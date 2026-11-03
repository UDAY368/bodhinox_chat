import { beforeEach, describe, expect, it, vi } from 'vitest';

// Currency lock (review C3): every amount stored in store-currency minor units locks the currency, and a rate
// write holds the settings row so it cannot race a currency change.
const calls: string[] = [];
let inUse = false;
let current: { currency: string } | null = { currency: 'INR' };

const sqlOf = (strings: TemplateStringsArray) => strings.join('?').replace(/\s+/g, ' ');
const tx = {
  $queryRaw: vi.fn(async (strings: TemplateStringsArray) => {
    const sql = sqlOf(strings);
    calls.push(sql);
    if (sql.includes('EXISTS (SELECT 1 FROM shop_variants')) return [{ used: inUse }];
    if (sql.includes('FROM commerce_settings')) return current ? [{ ...settingsRow, ...current }] : [];
    if (sql.includes('INSERT INTO shipping_rates')) {
      return [{ id: 'r1', name: 'Std', country: 'IN', postal_prefixes: [], min_subtotal_minor: BigInt(0), max_subtotal_minor: null, fee_minor: BigInt(4900),
        tax_rate_bps: null, active: true, position: 0 }];
    }
    return [];
  }),
  $executeRaw: vi.fn(async (strings: TemplateStringsArray) => { calls.push(sqlOf(strings)); return 1; }),
};
vi.mock('@/lib/db/tenant', () => ({ withTenant: (_ctx: unknown, fn: (t: typeof tx) => unknown) => fn(tx) }));

const { createShippingRate, currencyInUse, parseStoreSettings, saveStoreSettings } = await import('./store-settings');

const settingsRow = {
  currency: 'INR', prices_include_tax: true, default_tax_rate_bps: null, reservation_minutes: 30, checkout_enabled: true, low_stock_default: 5,
  legal_name: null, gstin: null, address: null, state_code: null, document_prefix: 'INV', storefront_title: null, return_window_days: 7,
  checkout_template_name: null, checkout_template_language: null,
};
const ctx = { accountId: '11111111-1111-4111-8111-111111111111', userId: '22222222-2222-4222-8222-222222222222', role: 'admin' as const };
const input = (currency: string) => parseStoreSettings({ ...settingsRow, currency });

beforeEach(() => { calls.length = 0; inUse = false; current = { currency: 'INR' }; });

describe('store currency lock', () => {
  it('counts shipping rates, coupon amounts and priced orders, not only variant prices', async () => {
    inUse = true;
    expect(await currencyInUse(tx as never, ctx.accountId)).toBe(true);
    const sql = calls[0];
    expect(sql).toContain('FROM shipping_rates');
    expect(sql).toMatch(/FROM coupons .*kind='fixed' OR min_subtotal_minor > 0 OR max_discount_minor IS NOT NULL/);
    expect(sql).toMatch(/FROM orders .*priced_at IS NOT NULL/);
  });

  it('refuses a currency change once any amount is in use, and allows it before', async () => {
    inUse = true;
    await expect(saveStoreSettings(ctx, input('JPY'))).rejects.toMatchObject({ code: 'currency_locked' });
    expect(calls.some((s) => s.includes('INSERT INTO commerce_settings'))).toBe(false);
    // Locked FOR UPDATE before the in-use check, so a concurrent rate write is serialized.
    expect(calls.findIndex((s) => s.includes('FOR UPDATE'))).toBeLessThan(calls.findIndex((s) => s.includes('FROM shipping_rates')));

    const same = await saveStoreSettings(ctx, input('INR'));
    expect(same.currency_locked).toBe(true);

    inUse = false;
    calls.length = 0;
    await saveStoreSettings(ctx, input('JPY'));
    expect(calls.some((s) => s.includes('INSERT INTO commerce_settings'))).toBe(true);
  });

  it('holds the settings row shared before inserting a shipping rate', async () => {
    await createShippingRate(ctx, { name: 'Std', country: 'IN', postal_prefixes: [], min_subtotal_minor: 0, max_subtotal_minor: null,
      fee_minor: 4900, tax_rate_bps: null, active: true, position: 0 });
    const lock = calls.findIndex((s) => /FROM commerce_settings .*FOR SHARE/.test(s));
    expect(lock).toBeGreaterThanOrEqual(0);
    expect(lock).toBeLessThan(calls.findIndex((s) => s.includes('INSERT INTO shipping_rates')));
  });
});
