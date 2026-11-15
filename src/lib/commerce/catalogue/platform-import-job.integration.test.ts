import { randomUUID } from 'node:crypto';
import { config } from 'dotenv';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { disconnectDatabases, getPrisma } from '@/lib/db/prisma';
import { withTenant, type TenantContext } from '@/lib/db/tenant';
import { enqueueJob } from '@/lib/jobs/queue';
import { encrypt } from '@/lib/whatsapp/encryption';
import { publishProduct, upsertProduct, upsertVariant } from './products';
import {
  cancelPlatformImport, defaultPlatformFetch, handlePlatformImportJob, listPlatformImports, PLATFORM_IMPORT_JOB, platformStatus,
  queuePlatformImport, type PlatformDeps, type PlatformResponse,
} from './platform-import-job';

// Store plan Phase 4 (package 3) on PostgreSQL: import from Shopify and WooCommerce with the network mocked. A workspace
// only ever uses its own connection, only admins start or stop an import, an import can resume or replay without
// duplicates, imported products are drafts, and a hard failure ends with a safe code.
const configured = config({ path: '.env.test', quiet: true }).parsed;
const ownerUrl = process.env.TEST_DATABASE_URL;
const appUrl = process.env.TEST_APP_DATABASE_URL || configured?.DATABASE_URL;
const workerUrl = process.env.TEST_WORKER_DATABASE_URL || configured?.WORKER_DATABASE_URL;
if (appUrl) process.env.DATABASE_URL = appUrl;
if (workerUrl) process.env.WORKER_DATABASE_URL = workerUrl;
process.env.APP_URL ??= 'https://app.example.test';

const seed = randomUUID().slice(0, 8);
const accountA = randomUUID(), accountB = randomUUID();
const ownerA = randomUUID(), adminA = randomUUID(), agentA = randomUUID(), ownerB = randomUUID();
const users = [ownerA, adminA, agentA, ownerB];
const asAdmin = { accountId: accountA, userId: adminA, role: 'admin' } as TenantContext & { userId: string };
const asAgent = { accountId: accountA, userId: agentA, role: 'agent' } as TenantContext & { userId: string };
const asOwnerB = { accountId: accountB, userId: ownerB, role: 'owner' } as TenantContext & { userId: string };
const shopA = `p3a-${seed}.myshopify.com`, shopB = `p3b-${seed}.myshopify.com`;
const wooA = `https://woo-a-${seed}.example.test`, wooB = `https://woo-b-${seed}.example.test`, wooHttp = `http://woo-plain-${seed}.example.test`;
const TOKEN_A = `shpat_a_${seed}`, TOKEN_B = `shpat_b_${seed}`;
const KEY = `ck_${seed}abcdef`, SECRET = `cs_${seed}ghijkl`;
let db: pg.Client;
let wooAId = '', wooBId = '', wooHttpId = '';

const count = async (sql: string, values: unknown[]) => Number((await db.query(sql, values)).rows[0].n);
const job = async (id: string) => (await db.query('SELECT * FROM shop_platform_imports WHERE id=$1', [id])).rows[0];
const attempt = { attempts: 1, maxAttempts: 5 };
const ok = (body: unknown, extra: Partial<PlatformResponse> = {}): PlatformResponse => ({ status: 200, body: typeof body === 'string' ? body : JSON.stringify(body), retryAfter: null, ...extra });

const node = (n: number, extra: Record<string, unknown> = {}) => ({
  id: `gid://shopify/Product/${n}`, title: `Shop item ${n}`, descriptionHtml: `<p>About ${n}</p>`, vendor: 'Bodhi', productType: 'Oils', tags: ['Organic'],
  images: { nodes: [{ url: `https://cdn.shopify.example/${n}.jpg` }] },
  variants: { pageInfo: { hasNextPage: false }, nodes: [
    { id: `gid://shopify/ProductVariant/${n}1`, sku: `SH-${seed}-${n}A`, price: '100.00', compareAtPrice: '150.00', inventoryQuantity: n, selectedOptions: [{ name: 'Size', value: 'S' }], inventoryItem: { tracked: true } },
    { id: `gid://shopify/ProductVariant/${n}2`, sku: `SH-${seed}-${n}B`, price: '120.00', compareAtPrice: null, inventoryQuantity: 2, selectedOptions: [{ name: 'Size', value: 'M' }], inventoryItem: { tracked: true } },
  ] },
  ...extra,
});
const shopifyPage = (nodes: unknown[], next: string | null) => ({ data: { products: { pageInfo: { hasNextPage: !!next, endCursor: next }, nodes } } });

/** A fake Shopify: page 1 (no cursor) has products 1-2 and cursor "c1"; page "c1" has product 3. Records every call. */
function shopifyDeps(opts: { failOnPage2Once?: boolean } = {}) {
  let failed = false;
  const fetch = vi.fn(async (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => {
    const after = JSON.parse(init.body ?? '{}').variables?.after ?? null;
    if (after === null) return ok(shopifyPage([node(1), node(2)], 'c1'));
    if (opts.failOnPage2Once && !failed) { failed = true; throw new Error('worker crashed'); }
    return ok(shopifyPage([node(3)], null));
  });
  const sleep = vi.fn<(ms: number) => Promise<void>>(async () => {});
  return { deps: { fetch, sleep } as PlatformDeps, fetch, sleep };
}

describe.skipIf(!ownerUrl || !appUrl || !workerUrl)('store plan phase 4: import from Shopify and WooCommerce on PostgreSQL', { timeout: 300_000 }, () => {
  beforeAll(async () => {
    db = new pg.Client({ connectionString: ownerUrl });
    await db.connect();
    if (!/test/i.test((await db.query('SELECT current_database() AS name')).rows[0].name)) throw new Error('Requires an isolated test database');
    const role = await getPrisma().$queryRaw<{ role: string }[]>`SELECT current_user AS role`;
    if (role[0].role !== 'bodhinox_app') throw new Error('Requires constrained test app credentials');
    await db.query("INSERT INTO auth_users(id,email,full_name,password_hash) SELECT x, x::text || '@example.invalid', 'P4 platform', 'test-only-hash' FROM unnest($1::uuid[]) x", [users]);
    await db.query("INSERT INTO accounts(id,name,owner_user_id) VALUES($1,'P4 PLAT A',$2),($3,'P4 PLAT B',$4)", [accountA, ownerA, accountB, ownerB]);
    await db.query("INSERT INTO account_subscriptions(account_id,plan_id) VALUES($1,'basic'),($2,'basic')", [accountA, accountB]);
    await db.query(`INSERT INTO account_memberships(account_id,user_id,role) VALUES ($1,$2,'owner'),($1,$3,'admin'),($1,$4,'agent'),($5,$6,'owner')`,
      [accountA, ownerA, adminA, agentA, accountB, ownerB]);
    await db.query(`INSERT INTO commerce_settings(account_id,currency,default_tax_rate_bps) VALUES($1,'INR',1800),($2,'INR',1800)`, [accountA, accountB]);
    await db.query('INSERT INTO shopify_stores(account_id,shop_domain,access_token_enc,scopes) VALUES($1,$2,$3,$4),($5,$6,$7,$8)',
      [accountA, shopA, encrypt(TOKEN_A), 'read_orders,read_products', accountB, shopB, encrypt(TOKEN_B), 'read_orders,read_products']);
    const woo = await db.query('INSERT INTO woocommerce_stores(account_id,store_url,webhook_secret_enc) VALUES($1,$2,$3),($1,$4,$3),($5,$6,$3) RETURNING id, store_url',
      [accountA, wooA, encrypt('whsec'), wooHttp, accountB, wooB]);
    wooAId = woo.rows.find((r) => r.store_url === wooA).id;
    wooHttpId = woo.rows.find((r) => r.store_url === wooHttp).id;
    wooBId = woo.rows.find((r) => r.store_url === wooB).id;
    // Workspace B owns a product with a SKU workspace A's feed will also use, and a draft that must never change.
    await withTenant(asOwnerB, async (tx) => {
      const p = await upsertProduct(tx, accountB, ownerB, null, { name: 'B original' });
      await upsertVariant(tx, accountB, ownerB, p.id, null, { sku: `SH-${seed}-1A`, price_minor: 11100 });
    });
  });

  afterAll(async () => {
    if (db) {
      await db.query('DELETE FROM jobs WHERE tenant_id=ANY($1::uuid[])', [[accountA, accountB]]);
      await db.query('DELETE FROM accounts WHERE id=ANY($1::uuid[])', [[accountA, accountB]]);
      await db.query('DELETE FROM auth_users WHERE id=ANY($1::uuid[])', [users]);
      await db.end();
    }
    await disconnectDatabases();
  });

  it('shows what is connected without any credential, and refuses a workspace with no connection or without product access', async () => {
    const status = await withTenant(asAdmin, (tx) => platformStatus(tx, accountA));
    expect(status.shopify).toEqual({ connected: true, shop_domain: shopA, scope_ok: true });
    expect(status.woocommerce.stores.map((s) => [s.store_url, s.https]).sort()).toEqual([[wooA, true], [wooHttp, false]].sort());
    expect(JSON.stringify(status)).not.toContain(TOKEN_A);
    // Workspace B's connections never show up here.
    expect(JSON.stringify(status)).not.toContain(shopB);
    expect(JSON.stringify(status)).not.toContain(wooB);

    await db.query("UPDATE shopify_stores SET scopes='read_orders' WHERE account_id=$1", [accountA]);
    expect((await withTenant(asAdmin, (tx) => platformStatus(tx, accountA))).shopify.scope_ok).toBe(false);
    await expect(queuePlatformImport(asAdmin, { platform: 'shopify' })).rejects.toMatchObject({ code: 'shopify_scope_missing' });
    await db.query("UPDATE shopify_stores SET scopes='read_orders,read_products' WHERE account_id=$1", [accountA]);

    await db.query('UPDATE shopify_stores SET uninstalled_at=now(), access_token_enc=NULL WHERE account_id=$1', [accountA]);
    await expect(queuePlatformImport(asAdmin, { platform: 'shopify' })).rejects.toMatchObject({ code: 'platform_not_connected' });
    await db.query('UPDATE shopify_stores SET uninstalled_at=NULL, access_token_enc=$2 WHERE account_id=$1', [accountA, encrypt(TOKEN_A)]);

    // Another workspace's store id, a plain-http store and malformed keys are refused before anything is stored.
    await expect(queuePlatformImport(asAdmin, { platform: 'woocommerce', storeId: wooBId, consumerKey: KEY, consumerSecret: SECRET })).rejects.toMatchObject({ code: 'platform_not_connected' });
    await expect(queuePlatformImport(asAdmin, { platform: 'woocommerce', storeId: wooHttpId, consumerKey: KEY, consumerSecret: SECRET })).rejects.toMatchObject({ code: 'woo_https_required' });
    await expect(queuePlatformImport(asAdmin, { platform: 'woocommerce', storeId: wooAId, consumerKey: 'bad key', consumerSecret: SECRET })).rejects.toMatchObject({ code: 'invalid' });
    expect(await count('SELECT count(*) AS n FROM shop_platform_imports WHERE account_id=ANY($1::uuid[])', [[accountA, accountB]])).toBe(0);
  });

  it('keeps agents out: they cannot start or cancel an import', async () => {
    await expect(queuePlatformImport(asAgent, { platform: 'shopify' })).rejects.toThrow();
    expect(await count('SELECT count(*) AS n FROM shop_platform_imports WHERE account_id=$1', [accountA])).toBe(0);
    const queued = await queuePlatformImport(asAdmin, { platform: 'shopify' });
    expect(await cancelPlatformImport(asAgent, queued.import_id)).toBe(false);
    // Workspace B cannot see or stop workspace A's import either.
    expect(await cancelPlatformImport(asOwnerB, queued.import_id)).toBe(false);
    expect((await withTenant(asOwnerB, (tx) => listPlatformImports(tx, accountB)))).toEqual([]);
    expect((await job(queued.import_id)).cancel_requested).toBe(false);
    // Only one import at a time, and the queue row is deduplicated by the job id.
    await expect(queuePlatformImport(asAdmin, { platform: 'shopify' })).rejects.toMatchObject({ code: 'import_running' });
    const key = `${PLATFORM_IMPORT_JOB}:${queued.import_id}`;
    const again = await enqueueJob(PLATFORM_IMPORT_JOB, { importId: queued.import_id }, { tenantId: accountA, dedupeKey: key });
    expect(await count('SELECT count(*) AS n FROM jobs WHERE dedupe_key=$1', [key])).toBe(1);
    expect((await db.query('SELECT id::text AS id FROM jobs WHERE dedupe_key=$1', [key])).rows[0].id).toBe(again);

    // A real cancel stops it before any request is made.
    expect(await cancelPlatformImport(asAdmin, queued.import_id)).toBe(true);
    const mock = shopifyDeps();
    await handlePlatformImportJob(accountA, { importId: queued.import_id }, attempt, () => {}, mock.deps);
    expect(mock.fetch).not.toHaveBeenCalled();
    expect(await job(queued.import_id)).toMatchObject({ status: 'canceled', cursor: null, credentials_enc: null });
    expect(await cancelPlatformImport(asAdmin, queued.import_id)).toBe(false);
  });

  it('imports Shopify products as drafts with its own token only, then a replay duplicates nothing and keeps a published product published', async () => {
    // A product A already has: matched by SKU, updated, still published.
    await withTenant(asAdmin, async (tx) => {
      const p = await upsertProduct(tx, accountA, adminA, null, { name: 'Old name' });
      await upsertVariant(tx, accountA, adminA, p.id, null, { sku: `SH-${seed}-3A`, price_minor: 100 });
      await publishProduct(tx, accountA, adminA, p.id);
    });

    const queued = await queuePlatformImport(asAdmin, { platform: 'shopify' });
    const mock = shopifyDeps();
    await handlePlatformImportJob(accountA, { importId: queued.import_id }, attempt, () => {}, mock.deps);

    const done = await job(queued.import_id);
    expect(done).toMatchObject({ status: 'done', pages_done: 2, products_seen: 3, created_count: 5, updated_count: 1, skipped_count: 0, error_count: 0, cursor: null, credentials_enc: null });
    // Every request went to workspace A's shop with workspace A's token; B's never appeared.
    for (const [url, init] of mock.fetch.mock.calls) {
      expect(url).toBe(`https://${shopA}/admin/api/2025-10/graphql.json`);
      expect(init.headers['x-shopify-access-token']).toBe(TOKEN_A);
    }
    expect(mock.fetch).toHaveBeenCalledTimes(2);

    const products = (await db.query("SELECT name, status, brand, product_type, tags, description FROM shop_products WHERE account_id=$1 AND name LIKE 'Shop item%' ORDER BY name", [accountA])).rows;
    expect(products.map((p) => [p.name, p.status])).toEqual([['Shop item 1', 'draft'], ['Shop item 2', 'draft'], ['Shop item 3', 'published']]);
    expect(products[0]).toMatchObject({ brand: 'Bodhi', product_type: 'Oils', tags: ['organic'], description: 'About 1' });
    expect((await db.query("SELECT url FROM shop_product_images i JOIN shop_products p ON p.id=i.product_id WHERE p.account_id=$1 AND p.name='Shop item 1'", [accountA])).rows)
      .toEqual([{ url: 'https://cdn.shopify.example/1.jpg' }]);
    expect((await db.query("SELECT price_minor::int AS p, compare_at_minor::int AS c FROM shop_variants WHERE account_id=$1 AND sku=$2", [accountA, `SH-${seed}-1A`])).rows[0]).toEqual({ p: 10000, c: 15000 });
    expect(await count("SELECT coalesce(sum(l.on_hand),0) AS n FROM inventory_levels l JOIN shop_variants v ON v.id=l.variant_id WHERE v.account_id=$1 AND v.sku=$2", [accountA, `SH-${seed}-1A`])).toBe(1);

    // Workspace B's product with the same SKU is untouched.
    expect((await db.query("SELECT p.name, v.price_minor::int AS price FROM shop_variants v JOIN shop_products p ON p.id=v.product_id WHERE v.account_id=$1 AND v.sku=$2", [accountB, `SH-${seed}-1A`])).rows)
      .toEqual([{ name: 'B original', price: 11100 }]);
    expect(await count("SELECT count(*) AS n FROM shop_products WHERE account_id=$1 AND name LIKE 'Shop item%'", [accountB])).toBe(0);

    // The worker died after writing the products but before saving the checkpoint: run the whole import again from the start.
    const shape = async () => ({
      products: await count("SELECT count(*) AS n FROM shop_products WHERE account_id=$1 AND name LIKE 'Shop item%'", [accountA]),
      variants: await count("SELECT count(*) AS n FROM shop_variants WHERE account_id=$1 AND sku LIKE $2", [accountA, `SH-${seed}-%`]),
      images: await count("SELECT count(*) AS n FROM shop_product_images i JOIN shop_products p ON p.id=i.product_id WHERE p.account_id=$1 AND p.name LIKE 'Shop item%'", [accountA]),
    });
    const before = await shape();
    expect(before).toEqual({ products: 3, variants: 6, images: 3 });
    await db.query("UPDATE shop_platform_imports SET status='queued', cursor=NULL, pages_done=0, products_seen=0, created_count=0, updated_count=0, completed_at=NULL WHERE id=$1", [queued.import_id]);
    await handlePlatformImportJob(accountA, { importId: queued.import_id }, { attempts: 2, maxAttempts: 5 }, () => {}, shopifyDeps().deps);
    expect(await shape()).toEqual(before);
    expect(await job(queued.import_id)).toMatchObject({ status: 'done', created_count: 0, updated_count: 6 });
    // A finished import delivered again does nothing.
    const idle = shopifyDeps();
    await handlePlatformImportJob(accountA, { importId: queued.import_id }, attempt, () => {}, idle.deps);
    expect(idle.fetch).not.toHaveBeenCalled();
  });

  it('resumes from the saved cursor after a crash in the middle of an import', async () => {
    await db.query("DELETE FROM shop_products WHERE account_id=$1 AND name LIKE 'Shop item%'", [accountA]);
    const queued = await queuePlatformImport(asAdmin, { platform: 'shopify' });
    const crashing = shopifyDeps({ failOnPage2Once: true });
    await expect(handlePlatformImportJob(accountA, { importId: queued.import_id }, attempt, () => {}, crashing.deps)).rejects.toThrow('worker crashed');
    // Page 1 is applied and checkpointed; the job stays running for the next attempt.
    expect(await job(queued.import_id)).toMatchObject({ status: 'running', cursor: 'c1', pages_done: 1, products_seen: 2, created_count: 4 });
    expect(await count("SELECT count(*) AS n FROM shop_products WHERE account_id=$1 AND name LIKE 'Shop item%'", [accountA])).toBe(2);

    const resumed = shopifyDeps();
    await handlePlatformImportJob(accountA, { importId: queued.import_id }, { attempts: 2, maxAttempts: 5 }, () => {}, resumed.deps);
    // It asked only for the second page, starting from the saved cursor.
    expect(resumed.fetch).toHaveBeenCalledTimes(1);
    expect(JSON.parse(resumed.fetch.mock.calls[0][1].body!).variables.after).toBe('c1');
    expect(await job(queued.import_id)).toMatchObject({ status: 'done', pages_done: 2, products_seen: 3, created_count: 6, updated_count: 0, cursor: null });
    expect(await count("SELECT count(*) AS n FROM shop_products WHERE account_id=$1 AND name LIKE 'Shop item%'", [accountA])).toBe(3);
  });

  it('imports WooCommerce with a key that is stored encrypted, never readable, and cleared; waits out a 429', async () => {
    const queued = await queuePlatformImport(asAdmin, { platform: 'woocommerce', storeId: wooAId, consumerKey: KEY, consumerSecret: SECRET });
    const raw = (await db.query('SELECT credentials_enc FROM shop_platform_imports WHERE id=$1', [queued.import_id])).rows[0].credentials_enc as string;
    expect(raw).toBeTruthy();
    expect(raw).not.toContain(KEY);
    expect(raw).not.toContain(SECRET);
    await expect(getPrisma().$queryRaw`SELECT credentials_enc FROM shop_platform_imports LIMIT 1`).rejects.toThrow();
    await expect(getPrisma().$queryRaw`SELECT cursor FROM shop_platform_imports LIMIT 1`).rejects.toThrow();

    const sleep = vi.fn<(ms: number) => Promise<void>>(async () => {});
    let limited = false;
    const fetch = vi.fn(async (url: string, init: { headers: Record<string, string> }) => {
      expect(init.headers.authorization).toBe(`Basic ${Buffer.from(`${KEY}:${SECRET}`).toString('base64')}`);
      expect(url.startsWith(wooA)).toBe(true);
      if (url.includes('/products/70/variations')) return ok([
        { id: 701, sku: `WC-${seed}-S`, regular_price: '500', sale_price: '', manage_stock: true, stock_quantity: 3, attributes: [{ name: 'Size', option: 'S' }] },
        { id: 702, sku: '', regular_price: '500', sale_price: '450', manage_stock: false, attributes: [{ name: 'Size', option: 'M' }] }]);
      if (!limited) { limited = true; return { status: 429, body: '', retryAfter: '2' }; }
      return ok([
        { id: 70, type: 'variable', name: 'Woo tee', sku: '', description: '<p>Tee</p>', tags: [], categories: [{ name: 'Tees' }], images: [{ src: 'https://woo.example/t.jpg' }] },
        { id: 71, type: 'simple', name: 'Woo soap', sku: `WC-${seed}-SOAP`, regular_price: '99', sale_price: '', manage_stock: true, stock_quantity: 5, tags: [{ name: 'Bath' }], categories: [], images: [] }]);
    });
    await handlePlatformImportJob(accountA, { importId: queued.import_id }, attempt, () => {}, { fetch, sleep } as unknown as PlatformDeps);
    expect(sleep).toHaveBeenCalledWith(2000);
    expect(await job(queued.import_id)).toMatchObject({ status: 'done', pages_done: 1, products_seen: 2, created_count: 3, credentials_enc: null, error_count: 0 });
    expect((await db.query("SELECT name, status, product_type FROM shop_products WHERE account_id=$1 AND name LIKE 'Woo %' ORDER BY name", [accountA])).rows)
      .toEqual([{ name: 'Woo soap', status: 'draft', product_type: null }, { name: 'Woo tee', status: 'draft', product_type: 'Tees' }]);
    expect((await db.query("SELECT sku, price_minor::int AS p, option_values FROM shop_variants WHERE account_id=$1 AND sku LIKE 'WOO-70-%'", [accountA])).rows)
      .toEqual([{ sku: 'WOO-70-702', p: 45000, option_values: { Size: 'M' } }]);
  });

  it('ends a refused login with a safe code, clears the key, and leaks no secret into the row', async () => {
    const queued = await queuePlatformImport(asAdmin, { platform: 'woocommerce', storeId: wooAId, consumerKey: KEY, consumerSecret: SECRET });
    const fetch = vi.fn(async () => ({ status: 401, body: `{"detail":"${SECRET}"}`, retryAfter: null }));
    await handlePlatformImportJob(accountA, { importId: queued.import_id }, attempt, () => {}, { fetch, sleep: async () => {} } as PlatformDeps);
    const row = await job(queued.import_id);
    expect(row).toMatchObject({ status: 'failed', error_code: 'unauthorized', credentials_enc: null, cursor: null });
    expect(JSON.stringify(row)).not.toContain(SECRET);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('gives up on a store that keeps rate limiting, after the capped retries', async () => {
    const queued = await queuePlatformImport(asAdmin, { platform: 'shopify' });
    const sleep = vi.fn<(ms: number) => Promise<void>>(async () => {});
    const fetch = vi.fn(async () => ({ status: 429, body: '', retryAfter: null }));
    await handlePlatformImportJob(accountA, { importId: queued.import_id }, attempt, () => {}, { fetch, sleep } as PlatformDeps);
    expect(fetch).toHaveBeenCalledTimes(5);
    expect(sleep.mock.calls.map((c) => c[0])).toEqual([1000, 2000, 4000, 8000]);
    expect(await job(queued.import_id)).toMatchObject({ status: 'failed', error_code: 'rate_limited' });
  });

  it('stops when the admin who queued the import lost the role, or the shop was swapped, and requests nothing', async () => {
    const queued = await queuePlatformImport(asAdmin, { platform: 'shopify' });
    await db.query("UPDATE account_memberships SET role='agent' WHERE account_id=$1 AND user_id=$2", [accountA, adminA]);
    const mock = shopifyDeps();
    try {
      await handlePlatformImportJob(accountA, { importId: queued.import_id }, attempt, () => {}, mock.deps);
    } finally {
      await db.query("UPDATE account_memberships SET role='admin' WHERE account_id=$1 AND user_id=$2", [accountA, adminA]);
    }
    expect(await job(queued.import_id)).toMatchObject({ status: 'failed', error_code: 'not_allowed' });

    const second = await queuePlatformImport(asAdmin, { platform: 'shopify' });
    await db.query("UPDATE shopify_stores SET shop_domain=$2 WHERE account_id=$1", [accountA, `swapped-${seed}.myshopify.com`]);
    try {
      await handlePlatformImportJob(accountA, { importId: second.import_id }, attempt, () => {}, mock.deps);
    } finally {
      await db.query("UPDATE shopify_stores SET shop_domain=$2 WHERE account_id=$1", [accountA, shopA]);
    }
    expect(await job(second.import_id)).toMatchObject({ status: 'failed', error_code: 'not_connected' });
    expect(mock.fetch).not.toHaveBeenCalled();
  });

  it('never calls a private or local address: the production fetcher refuses it before any connection', async () => {
    await expect(defaultPlatformFetch('https://127.0.0.1/wp-json/wc/v3/products', { method: 'GET', headers: {} })).rejects.toMatchObject({ code: 'blocked' });
    await expect(defaultPlatformFetch('https://169.254.169.254/latest/meta-data', { method: 'GET', headers: {} })).rejects.toMatchObject({ code: 'blocked' });
    await expect(defaultPlatformFetch('https://localhost/x', { method: 'GET', headers: {} })).rejects.toMatchObject({ code: 'blocked' });
  });
});
