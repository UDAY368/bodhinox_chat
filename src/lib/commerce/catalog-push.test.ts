import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MetaCatalogItemUpdate } from '@/lib/whatsapp/meta-api';

const h = vi.hoisted(() => ({
  catalogs: [] as { id: string; catalog_id: string; whatsapp_config_id: string | null }[],
  items: new Map<string, unknown[]>(),
  numberless: new Set<string>(),
  executed: [] as { sql: string; values: unknown[] }[],
  current: '',
}));

vi.mock('@/lib/db/prisma', () => ({ getWorkerPrisma: () => 'worker' }));
vi.mock('@/lib/whatsapp/encryption', () => ({ decrypt: () => 'plain-token' }));
vi.mock('./catalog', () => {
  class CatalogError extends Error {}
  return {
    CatalogError,
    loadCatalogNumber: async (_tx: unknown, _account: string, configId: string | null) => {
      if (configId && h.numberless.has(configId)) throw new CatalogError('number_unavailable');
      return { id: configId, phoneNumberId: '1', wabaId: null, accessTokenEnc: 'enc' };
    },
  };
});
vi.mock('@/lib/db/tenant', () => ({
  withTenant: async (_ctx: unknown, fn: (tx: unknown) => unknown) => fn({
    $queryRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const sql = strings.join('?');
      if (sql.includes('FROM whatsapp_catalogs')) return h.catalogs;
      if (sql.includes('FROM products m')) return h.items.get(values[1] as string) ?? [];
      return [];
    },
    $executeRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
      h.executed.push({ sql: strings.join('?'), values });
      return 1;
    },
  }),
}));

import { itemUpdate, pushCatalogChanges, type CatalogUpdater, type LinkedItemState } from './catalog-push';

const ACCOUNT = '11111111-1111-4111-8111-111111111111';
const state = (over: Partial<LinkedItemState> = {}): LinkedItemState => ({
  retailer_id: 'SKU-1', meta_price_minor: 129900, meta_currency: 'INR', meta_availability: 'in stock',
  price_minor: 129900, currency: 'INR', sellable: true, ...over,
});
const row = (over: Record<string, unknown> = {}) => ({
  retailer_id: 'SKU-1', meta_price: BigInt(129900), meta_currency: 'INR', meta_availability: 'in stock',
  price: BigInt(149900), currency: 'INR', sellable: true, ...over,
});

describe('itemUpdate', () => {
  it('sends nothing when Meta already shows the Bodhinox price and availability', () => {
    expect(itemUpdate(state())).toBeNull();
  });

  it('sends a changed price in feed format with the store currency, exactly (no float rounding)', () => {
    expect(itemUpdate(state({ price_minor: 149999 }))).toEqual({ retailerId: 'SKU-1', price: '1499.99 INR' });
    expect(itemUpdate(state({ price_minor: 1500, currency: 'JPY', meta_currency: 'JPY' }))).toEqual({ retailerId: 'SKU-1', price: '1500 JPY' });
    expect(itemUpdate(state({ meta_currency: 'USD' }))).toEqual({ retailerId: 'SKU-1', price: '1299.00 INR' });
  });

  it('marks an item that checkout would refuse out of stock, and back in stock', () => {
    expect(itemUpdate(state({ sellable: false }))).toEqual({ retailerId: 'SKU-1', availability: 'out of stock' });
    expect(itemUpdate(state({ meta_availability: 'out of stock' }))).toEqual({ retailerId: 'SKU-1', availability: 'in stock' });
    // Meta's own wording we never write is replaced too.
    expect(itemUpdate(state({ meta_availability: 'available for order' }))).toEqual({ retailerId: 'SKU-1', availability: 'in stock' });
  });

  it('leaves the price alone while the variant has no price or the store no currency', () => {
    expect(itemUpdate(state({ price_minor: null, sellable: false }))).toEqual({ retailerId: 'SKU-1', availability: 'out of stock' });
    expect(itemUpdate(state({ currency: null, price_minor: 1 }))).toBeNull();
  });
});

describe('pushCatalogChanges', () => {
  beforeEach(() => {
    h.catalogs = [];
    h.items = new Map();
    h.numberless = new Set();
    h.executed = [];
  });

  it('batches differences per catalogue (1000 per call) and records each accepted batch in the mirror', async () => {
    h.catalogs = [{ id: 'row-1', catalog_id: '111', whatsapp_config_id: 'cfg-1' }];
    h.items.set('row-1', [
      ...Array.from({ length: 1001 }, (_, i) => row({ retailer_id: `SKU-${i}` })),
      row({ retailer_id: 'SAME', price: BigInt(129900) }),
    ]);
    const update = vi.fn<(args: { catalogId: string; accessToken: string; items: MetaCatalogItemUpdate[] }) => Promise<{ handles: string[] }>>(async () => ({ handles: [] }));
    const result = await pushCatalogChanges(ACCOUNT, update as unknown as CatalogUpdater);
    expect(result).toEqual({ catalogs: 1, pushed: 1001, skipped: 0 });
    expect(update.mock.calls.map(([args]) => [args.catalogId, args.accessToken, args.items.length])).toEqual([['111', 'plain-token', 1000], ['111', 'plain-token', 1]]);
    expect(update.mock.calls.flatMap(([args]) => args.items).some((i) => i.retailerId === 'SAME')).toBe(false);
    const mirrorWrites = h.executed.filter((e) => e.sql.includes('UPDATE products SET'));
    expect(mirrorWrites).toHaveLength(1001);
    expect(mirrorWrites[0].values).toContain(BigInt(149900));
  });

  it('skips a catalogue without a usable number, and one refusing catalogue does not stop the others but fails the job', async () => {
    h.catalogs = [
      { id: 'row-1', catalog_id: '111', whatsapp_config_id: 'gone' },
      { id: 'row-2', catalog_id: '222', whatsapp_config_id: 'cfg-2' },
      { id: 'row-3', catalog_id: '333', whatsapp_config_id: 'cfg-3' },
    ];
    h.numberless.add('gone');
    h.items.set('row-2', [row()]);
    h.items.set('row-3', [row({ retailer_id: 'SKU-3' })]);
    const update = vi.fn(async (args: { catalogId: string }) => {
      if (args.catalogId === '222') throw new Error('Meta API error: 403');
      return { handles: [] };
    });
    await expect(pushCatalogChanges(ACCOUNT, update as unknown as CatalogUpdater)).rejects.toThrow('403');
    expect(update.mock.calls.map(([args]) => args.catalogId)).toEqual(['222', '333']);
    // Only the accepted catalogue's item was recorded as pushed.
    const mirrorWrites = h.executed.filter((e) => e.sql.includes('UPDATE products SET'));
    expect(mirrorWrites.map((e) => e.values.includes('SKU-3'))).toEqual([true]);
  });
});
