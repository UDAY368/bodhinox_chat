import { afterEach, describe, expect, it, vi } from 'vitest';
import { checkCatalogBatchStatus, findCatalogItem, MetaApiError, parseBusinessUsage, sendCatalogItemsBatch, type MetaBatchStatus } from '@/lib/whatsapp/meta-api';
import {
  batchIntentKey, buildMetaItem, chunk, classifySendError, interpretBatchStatus, planItem, rateLimitDelayMs, usageBackoffMs,
  META_SYNC_BATCH_MAX, META_SYNC_PENDING_MAX_MS, type ItemState, type SyncContext, type SyncVariant,
} from './meta-sync';

// Store plan Phase 4 (package 4): the pure rules of the full Meta catalogue sync.
const PRODUCT = '22222222-2222-4222-8222-222222222222';
const IMAGE = '33333333-3333-4333-8333-333333333333';
const ctx: SyncContext = { catalogId: '9001', origin: 'https://app.example.test', handle: 'my-shop' };
const variant = (over: Partial<SyncVariant> = {}): SyncVariant => ({
  variant_id: '11111111-1111-4111-8111-111111111111', product_id: PRODUCT, sku: 'SKU-1', name: 'Linen shirt', description: 'Soft linen.',
  brand: 'Bodhi', option_values: { Color: 'Blue', Size: 'M' }, price_minor: 129900, currency: 'INR', sellable: true,
  image: { id: IMAGE, url: 'https://cdn.example.test/shirt.jpg' }, ...over,
});
const metaError = (httpStatus: number, code: number | null = null, subcode: number | null = null) =>
  new MetaApiError('refused', { httpStatus, code, subcode });

describe('buildMetaItem (payload mapping)', () => {
  it('maps a variant to a whole Meta item: SKU as id, exact price with currency, links, picture, brand and group', () => {
    const built = buildMetaItem(variant(), ctx);
    expect(built).toMatchObject({ ok: true });
    if (!built.ok) return;
    expect(built.data).toEqual({
      id: 'SKU-1', title: 'Linen shirt - Blue / M', description: 'Soft linen.', availability: 'in stock', condition: 'new',
      price: '1299.00 INR', link: `https://app.example.test/s/my-shop/p/${PRODUCT}`, image_link: 'https://cdn.example.test/shirt.jpg',
      brand: 'Bodhi', item_group_id: PRODUCT, color: 'Blue', size: 'M',
    });
    expect(built.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('uses the shop public image route for a library picture, the title when there is no description, and out of stock when not sellable', () => {
    const built = buildMetaItem(variant({ image: { id: IMAGE, url: null }, description: '  ', sellable: false, option_values: {}, brand: null }), ctx);
    if (!built.ok) throw new Error('expected an item');
    expect(built.data.image_link).toBe(`https://app.example.test/api/public/store/my-shop/images/${IMAGE}`);
    expect(built.data.description).toBe('Linen shirt');
    expect(built.data.title).toBe('Linen shirt');
    expect(built.data.availability).toBe('out of stock');
    expect(built.data).not.toHaveProperty('brand');
    expect(built.data).not.toHaveProperty('color');
  });

  it('keeps a three-decimal and a zero-decimal currency exact, and clips long text to Meta limits', () => {
    const kwd = buildMetaItem(variant({ price_minor: 1234, currency: 'KWD' }), ctx);
    const jpy = buildMetaItem(variant({ price_minor: 1500, currency: 'JPY', name: 'x'.repeat(400), description: 'y'.repeat(20_000) }), ctx);
    if (!kwd.ok || !jpy.ok) throw new Error('expected items');
    expect(kwd.data.price).toBe('1.234 KWD');
    expect(jpy.data.price).toBe('1500 JPY');
    expect(jpy.data.title).toHaveLength(200);
    expect(jpy.data.description).toHaveLength(9999);
  });

  it('refuses locally, before any call: no price, no public https link, no picture', () => {
    expect(buildMetaItem(variant({ price_minor: null }), ctx)).toMatchObject({ ok: false, code: 'missing_price' });
    expect(buildMetaItem(variant({ currency: null }), ctx)).toMatchObject({ ok: false, code: 'missing_price' });
    expect(buildMetaItem(variant(), { ...ctx, handle: null })).toMatchObject({ ok: false, code: 'missing_link' });
    expect(buildMetaItem(variant(), { ...ctx, origin: null })).toMatchObject({ ok: false, code: 'missing_link' });
    expect(buildMetaItem(variant({ image: null }), ctx)).toMatchObject({ ok: false, code: 'missing_image' });
  });

  it('changes the digest when anything Meta shows changes, or the catalogue does, and not otherwise', () => {
    const base = buildMetaItem(variant(), ctx).hash;
    expect(buildMetaItem(variant(), ctx).hash).toBe(base);
    expect(buildMetaItem(variant({ variant_id: 'other' }), ctx).hash).toBe(base);
    for (const over of [{ price_minor: 129901 }, { sellable: false }, { name: 'Linen shirts' }, { description: 'New.' }, { brand: 'Other' },
      { image: { id: IMAGE, url: 'https://cdn.example.test/2.jpg' } }, { option_values: { Color: 'Red', Size: 'M' } }] as Partial<SyncVariant>[]) {
      expect(buildMetaItem(variant(over), ctx).hash).not.toBe(base);
    }
    expect(buildMetaItem(variant(), { ...ctx, catalogId: '9002' }).hash).not.toBe(base);
  });
});

describe('batching', () => {
  it('chunks to the batch limit and keeps every item once, in order', () => {
    const items = Array.from({ length: META_SYNC_BATCH_MAX * 2 + 7 }, (_, i) => i);
    const parts = chunk(items);
    expect(parts.map((p) => p.length)).toEqual([META_SYNC_BATCH_MAX, META_SYNC_BATCH_MAX, 7]);
    expect(parts.flat()).toEqual(items);
    expect(chunk([])).toEqual([]);
  });

  it('keys a batch stably: same items in any order give the same key; content, attempt, method, catalogue or workspace change it', () => {
    const a = { retailerId: 'A', hash: 'h1', attempts: 0 }, b = { retailerId: 'B', hash: 'h2', attempts: 3 };
    const key = batchIntentKey('acct', '9001', 'CREATE', [a, b]);
    expect(key).toMatch(/^acct:meta-catalogue:9001:create:[0-9a-f]{64}$/);
    expect(batchIntentKey('acct', '9001', 'CREATE', [b, a])).toBe(key);
    expect(batchIntentKey('acct', '9001', 'CREATE', [a, { ...b, hash: 'h3' }])).not.toBe(key);
    expect(batchIntentKey('acct', '9001', 'CREATE', [a, { ...b, attempts: 4 }])).not.toBe(key);
    expect(batchIntentKey('acct', '9001', 'UPDATE', [a, b])).not.toBe(key);
    expect(batchIntentKey('acct', '9002', 'CREATE', [a, b])).not.toBe(key);
    expect(batchIntentKey('other', '9001', 'CREATE', [a, b])).not.toBe(key);
    // No SKU or content digest is readable in the key.
    expect(key).not.toContain('h1');
  });
});

describe('planItem', () => {
  const built = buildMetaItem(variant(), ctx);
  const opts = { catalogId: '9001', sku: 'SKU-1', mirrored: false, force: false };
  const row = (over: Partial<ItemState> = {}): ItemState => ({ status: 'synced', catalog_id: '9001', retailer_id: 'SKU-1', pushed_hash: built.hash, in_meta: true, error_code: null, ...over });

  it('creates an item Meta has never had and updates one it has (mirror or an earlier sync)', () => {
    expect(planItem(null, built, opts)).toEqual({ kind: 'send', method: 'CREATE' });
    expect(planItem(null, built, { ...opts, mirrored: true })).toEqual({ kind: 'send', method: 'UPDATE' });
    expect(planItem(row({ pushed_hash: 'f'.repeat(64) }), built, opts)).toEqual({ kind: 'send', method: 'UPDATE' });
    expect(planItem(row({ status: 'not_synced', pushed_hash: null, in_meta: false }), built, opts)).toEqual({ kind: 'send', method: 'CREATE' });
  });

  it('sends nothing when the content is already synced', () => {
    expect(planItem(row(), built, opts)).toEqual({ kind: 'skip' });
  });

  it('never plans an uncertain or a pending item, even on Sync now or after the content changed', () => {
    for (const status of ['uncertain', 'pending'] as const) {
      expect(planItem(row({ status, pushed_hash: 'f'.repeat(64) }), built, { ...opts, force: true })).toEqual({ kind: 'skip' });
      expect(planItem(row({ status }), buildMetaItem(variant({ price_minor: null }), ctx), { ...opts, force: true })).toEqual({ kind: 'skip' });
    }
  });

  it('leaves a failed item until its content changes or an admin forces a sync', () => {
    const failed = row({ status: 'failed', in_meta: false, error_code: 'meta_item_invalid' });
    expect(planItem(failed, built, opts)).toEqual({ kind: 'skip' });
    expect(planItem(failed, built, { ...opts, force: true })).toEqual({ kind: 'send', method: 'CREATE' });
    expect(planItem(failed, buildMetaItem(variant({ name: 'Fixed' }), ctx), opts)).toEqual({ kind: 'send', method: 'CREATE' });
  });

  it('records a local refusal once, and treats a changed SKU or catalogue as a new item', () => {
    const noPrice = buildMetaItem(variant({ price_minor: null }), ctx);
    expect(planItem(null, noPrice, opts)).toEqual({ kind: 'refuse', code: 'missing_price' });
    expect(planItem(row({ status: 'failed', error_code: 'missing_price' }), noPrice, opts)).toEqual({ kind: 'skip' });
    expect(planItem(row({ status: 'failed', error_code: 'missing_image' }), noPrice, opts)).toEqual({ kind: 'refuse', code: 'missing_price' });
    expect(planItem(row({ retailer_id: 'OLD-SKU' }), built, opts)).toEqual({ kind: 'send', method: 'CREATE' });
    expect(planItem(row({ catalog_id: '8000' }), built, opts)).toEqual({ kind: 'send', method: 'CREATE' });
  });
});

describe('classifySendError (retry or uncertain)', () => {
  const timeout = new DOMException('The operation was aborted due to timeout', 'TimeoutError');
  const network = new TypeError('fetch failed');

  it('marks a CREATE uncertain after a timeout, a network error or a 5xx: it may have been created', () => {
    for (const error of [timeout, network, metaError(500, 2), metaError(503), new Error('anything')]) {
      expect(classifySendError(error, 'CREATE')).toEqual({ kind: 'uncertain' });
    }
  });

  it('lets an UPDATE retry after the same failures: it is absolute', () => {
    for (const error of [timeout, network, metaError(500, 2), metaError(502)]) {
      expect(classifySendError(error, 'UPDATE')).toEqual({ kind: 'retryable' });
    }
  });

  it('backs off on every Graph throttling code and on HTTP 429, for either method, without marking anything uncertain', () => {
    for (const code of [4, 17, 32, 613, 80014]) {
      expect(classifySendError(metaError(400, code), 'CREATE')).toEqual({ kind: 'rate_limited', delayMs: 5 * 60_000 });
      expect(classifySendError(metaError(403, code), 'UPDATE', 2)).toEqual({ kind: 'rate_limited', delayMs: 10 * 60_000 });
    }
    expect(classifySendError(metaError(429), 'CREATE')).toMatchObject({ kind: 'rate_limited' });
    // A throttled 5xx-looking answer with a throttling code is still a throttle, not an unknown outcome.
    expect(classifySendError(metaError(500, 80014), 'CREATE')).toMatchObject({ kind: 'rate_limited' });
    expect([1, 2, 3, 4, 5, 9].map(rateLimitDelayMs)).toEqual([300_000, 600_000, 1_200_000, 2_400_000, 3_600_000, 3_600_000]);
  });

  it('treats a 4xx as a definite refusal with a fixed code and only Meta numeric codes as detail', () => {
    expect(classifySendError(metaError(400, 190), 'CREATE')).toEqual({ kind: 'rejected', code: 'token_invalid', detail: '190', stop: true });
    expect(classifySendError(metaError(401), 'UPDATE')).toEqual({ kind: 'rejected', code: 'token_invalid', detail: null, stop: true });
    expect(classifySendError(metaError(400, 200, 1870034), 'CREATE')).toEqual({ kind: 'rejected', code: 'catalog_permission', detail: '200/1870034', stop: true });
    expect(classifySendError(metaError(400, 10), 'CREATE')).toMatchObject({ kind: 'rejected', code: 'catalog_permission' });
    expect(classifySendError(metaError(400, 100, 33), 'CREATE')).toEqual({ kind: 'rejected', code: 'meta_rejected', detail: '100/33', stop: false });
  });
});

describe('usage header and backoff', () => {
  it('reads the highest use across businesses and metrics, and the time to regain access', () => {
    const header = JSON.stringify({
      '111': [{ type: 'catalog_management', call_count: 12, total_cputime: 40, total_time: 95, estimated_time_to_regain_access: 0 }],
      '222': [{ type: 'catalog_batch', call_count: 100, total_cputime: 5, total_time: 5, estimated_time_to_regain_access: 7 }],
    });
    expect(parseBusinessUsage(header)).toEqual({ percent: 100, regainMinutes: 7 });
    expect(parseBusinessUsage(null)).toBeNull();
    expect(parseBusinessUsage('not json')).toBeNull();
    expect(parseBusinessUsage('{}')).toBeNull();
  });

  it('carries on below 90%, pauses ten minutes at 90% and for Meta own estimate when throttled (capped at an hour)', () => {
    expect(usageBackoffMs(null)).toBeNull();
    expect(usageBackoffMs({ percent: 89, regainMinutes: 0 })).toBeNull();
    expect(usageBackoffMs({ percent: 90, regainMinutes: 0 })).toBe(600_000);
    expect(usageBackoffMs({ percent: 100, regainMinutes: 7 })).toBe(420_000);
    expect(usageBackoffMs({ percent: 100, regainMinutes: 600 })).toBe(3_600_000);
  });
});

describe('interpretBatchStatus (handle status)', () => {
  const status = (over: Partial<MetaBatchStatus>): MetaBatchStatus => ({ status: 'finished', invalidIds: [], errorsTruncated: false, ...over });
  const create = { retailerId: 'A', method: 'CREATE' as const }, update = { retailerId: 'A', method: 'UPDATE' as const };

  it('finished: synced, or failed when Meta lists the item as invalid', () => {
    expect(interpretBatchStatus(status({}), create, 1000)).toBe('synced');
    expect(interpretBatchStatus(status({ invalidIds: ['A'] }), create, 1000)).toBe('failed');
    expect(interpretBatchStatus(status({ invalidIds: ['B'] }), update, 1000)).toBe('synced');
  });

  it('finished with more errors than Meta listed: an unlisted CREATE is uncertain, an UPDATE is retried', () => {
    expect(interpretBatchStatus(status({ invalidIds: ['B'], errorsTruncated: true }), create, 1000)).toBe('uncertain');
    expect(interpretBatchStatus(status({ invalidIds: ['B'], errorsTruncated: true }), update, 1000)).toBe('retry');
    expect(interpretBatchStatus(status({ invalidIds: ['A'], errorsTruncated: true }), create, 1000)).toBe('failed');
  });

  it('started: wait, until it is older than the limit', () => {
    expect(interpretBatchStatus(status({ status: 'started' }), create, 60_000)).toBe('wait');
    expect(interpretBatchStatus(status({ status: 'started' }), create, META_SYNC_PENDING_MAX_MS + 1)).toBe('uncertain');
    expect(interpretBatchStatus(status({ status: 'started' }), update, META_SYNC_PENDING_MAX_MS + 1)).toBe('retry');
  });

  it('error, canceled, an unknown handle or a status never seen before: CREATE uncertain, UPDATE retried', () => {
    for (const value of ['error', 'canceled', null, 'something_new']) {
      expect(interpretBatchStatus(status({ status: value }), create, 1000)).toBe('uncertain');
      expect(interpretBatchStatus(status({ status: value }), update, 1000)).toBe('retry');
    }
  });
});

describe('Graph calls (fetch mocked)', () => {
  afterEach(() => vi.unstubAllGlobals());
  const reply = (body: unknown, init: ResponseInit = {}) => new Response(JSON.stringify(body), { status: 200, ...init });
  const item = buildMetaItem(variant(), ctx);
  if (!item.ok) throw new Error('expected an item');

  it('sends one method per batch with upsert off, the token only in the header, and returns handles and usage', async () => {
    const fetch = vi.fn(async (...args: [string, RequestInit]) => { void args; return reply({ handles: ['H1'] },
      { headers: { 'x-business-use-case-usage': JSON.stringify({ '1': [{ call_count: 91, total_cputime: 1, total_time: 1, estimated_time_to_regain_access: 0 }] }) } }); });
    vi.stubGlobal('fetch', fetch);
    const out = await sendCatalogItemsBatch({ catalogId: '9001', accessToken: 'secret-token', method: 'CREATE', items: [item.data] });
    expect(out).toEqual({ handles: ['H1'], usage: { percent: 91, regainMinutes: 0 } });
    const [url, init] = fetch.mock.calls[0];
    expect(url).toMatch(/\/9001\/items_batch$/);
    expect(url).not.toContain('secret-token');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer secret-token');
    const body = JSON.parse(String(init.body));
    expect(body).toEqual({ item_type: 'PRODUCT_ITEM', allow_upsert: false, requests: [{ method: 'CREATE', data: item.data }] });
    expect(String(init.body)).not.toContain('secret-token');
  });

  it('refuses an empty or oversized batch and a malformed catalogue id before any call', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    await expect(sendCatalogItemsBatch({ catalogId: '9001', accessToken: 't', method: 'UPDATE', items: [] })).rejects.toThrow();
    await expect(sendCatalogItemsBatch({ catalogId: '9001', accessToken: 't', method: 'UPDATE', items: Array(1001).fill(item.data) })).rejects.toThrow();
    await expect(sendCatalogItemsBatch({ catalogId: '../x', accessToken: 't', method: 'UPDATE', items: [item.data] })).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('throws a MetaApiError with the Graph code on a refusal', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => reply({ error: { message: 'limit', code: 80014 } }, { status: 400 })));
    await expect(sendCatalogItemsBatch({ catalogId: '9001', accessToken: 't', method: 'CREATE', items: [item.data] }))
      .rejects.toMatchObject({ name: 'MetaApiError', httpStatus: 400, code: 80014 });
  });

  it('reads a batch status: invalid ids from both lists, truncated errors, and an unknown handle as null', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => reply({ data: [{ handle: 'H1', status: 'FINISHED', errors_total_count: 3,
      errors: [{ line: 0, id: 'A', message: 'bad image for Linen shirt' }], ids_of_invalid_requests: ['B'] }] })));
    const status = await checkCatalogBatchStatus({ catalogId: '9001', accessToken: 't', handle: 'H1' });
    expect(status).toEqual({ status: 'finished', invalidIds: ['B', 'A'], errorsTruncated: true });
    // Meta's error text (it can quote product content) is not returned.
    expect(JSON.stringify(status)).not.toContain('Linen');
    vi.stubGlobal('fetch', vi.fn(async () => reply({ data: [] })));
    expect(await checkCatalogBatchStatus({ catalogId: '9001', accessToken: 't', handle: 'H2' })).toEqual({ status: null, invalidIds: [], errorsTruncated: false });
  });

  it('finds an item by retailer id only on an exact match', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => reply({ data: [{ id: '555', retailer_id: 'SKU-10' }, { id: '777', retailer_id: 'SKU-1' }] })));
    expect(await findCatalogItem({ catalogId: '9001', accessToken: 't', retailerId: 'SKU-1' })).toEqual({ id: '777' });
    vi.stubGlobal('fetch', vi.fn(async () => reply({ data: [{ id: '555', retailer_id: 'SKU-10' }] })));
    expect(await findCatalogItem({ catalogId: '9001', accessToken: 't', retailerId: 'SKU-1' })).toBeNull();
  });
});
