import { afterEach, describe, expect, it, vi } from 'vitest';

const db = vi.hoisted(() => ({ profile: null as null | { gstin: string | null; state_code: string | null; country: string }, inserted: [] as unknown[][], updates: [] as string[], pending: 0 }));
vi.mock('@/lib/db/tenant', () => ({
  withTenant: async (_ctx: unknown, fn: (tx: unknown) => unknown) => fn({
    $queryRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const sql = strings.join('?');
      if (sql.includes('FROM account_subscriptions')) return [{ provider_subscription_id: 'sub_1', current_period_end: new Date(Date.now() + 86_400_000) }];
      if (sql.includes('FROM billing_profiles')) return db.profile ? [db.profile] : [];
      if (sql.includes('INSERT INTO add_ons')) { db.inserted.push(values); return [{ id: 'addon-1' }]; }
      if (sql.includes("status='pending'")) return [{ n: db.pending }];
      return [];
    },
    $executeRaw: async (strings: TemplateStringsArray) => { db.updates.push(strings.join('?')); return 1; },
  }),
}));

const limits = vi.hoisted(() => ({ value: 100 as number | null }));
vi.mock('./entitlements', () => ({
  getEntitlements: async () => ({ limits: { ai_messages: limits.value, seats: limits.value, whatsapp_numbers: limits.value } }),
}));

import { addonPacks, AddonInputError, parsePurchase, purchaseAddon } from './addons';
import type { BillingProvider } from './provider';

const env = (value: unknown) => ({ BILLING_ADDON_PRICES: typeof value === 'string' ? value : JSON.stringify(value) });

describe('addonPacks', () => {
  it('reads valid packs with INR by default', () => {
    expect(addonPacks(env([{ kind: 'ai_messages', quantity: 1000, amount_minor: 49900 }, { kind: 'extra_seats', quantity: 1, amount_minor: 29900, currency: 'INR' }])))
      .toEqual([{ kind: 'ai_messages', quantity: 1000, amountMinor: 49900, currency: 'INR' }, { kind: 'extra_seats', quantity: 1, amountMinor: 29900, currency: 'INR' }]);
    // Subscriptions and invoices are INR only, so a pack in another currency could never be charged or invoiced.
    expect(addonPacks(env([{ kind: 'extra_seats', quantity: 1, amount_minor: 29900, currency: 'USD' }]))).toEqual([]);
  });

  it('drops invalid entries and duplicate kinds', () => {
    expect(addonPacks(env([
      { kind: 'storage', quantity: 1, amount_minor: 1 },
      { kind: 'ai_messages', quantity: 0, amount_minor: 1 },
      { kind: 'ai_messages', quantity: 1.5, amount_minor: 1 },
      { kind: 'ai_messages', quantity: 1, amount_minor: -1 },
      { kind: 'ai_messages', quantity: 1, amount_minor: 1, currency: 'inr' },
      null,
      { kind: 'extra_numbers', quantity: 1, amount_minor: 100 },
      { kind: 'extra_numbers', quantity: 2, amount_minor: 100 },
    ]))).toEqual([{ kind: 'extra_numbers', quantity: 1, amountMinor: 100, currency: 'INR' }]);
  });

  it('is empty when unset or malformed', () => {
    expect(addonPacks({})).toEqual([]);
    expect(addonPacks(env('{not json'))).toEqual([]);
    expect(addonPacks(env({ kind: 'ai_messages' }))).toEqual([]);
  });
});

describe('parsePurchase', () => {
  const packs = addonPacks(env([{ kind: 'ai_messages', quantity: 1000, amount_minor: 49900 }]));

  it('defaults to one pack', () => {
    expect(parsePurchase({ kind: 'ai_messages' }, packs)).toEqual({ pack: packs[0], packs: 1 });
    expect(parsePurchase({ kind: 'ai_messages', packs: 3 }, packs).packs).toBe(3);
  });

  it.each([null, {}, { kind: 'extra_seats' }, { kind: 'ai_messages', packs: 0 }, { kind: 'ai_messages', packs: 101 },
    { kind: 'ai_messages', packs: '2' }, { kind: 'ai_messages', packs: 1.5 }])('rejects %j', (body) => {
    expect(() => parsePurchase(body, packs)).toThrow(AddonInputError);
  });
});

describe('purchaseAddon GST', () => {
  const ACCOUNT = '11111111-1111-4111-8111-111111111111', USER = '22222222-2222-4222-8222-222222222222';
  const pack = { kind: 'ai_messages' as const, quantity: 1000, amountMinor: 100_000, currency: 'INR' };
  const provider = () => {
    const createAddon = vi.fn(async () => ({ outcome: 'ok' as const, value: { id: 'ao_1' } }));
    return { createAddon, p: { name: 'razorpay', createAddon } as unknown as BillingProvider };
  };
  afterEach(() => {
    vi.unstubAllEnvs();
    Object.assign(db, { profile: null, inserted: [], updates: [], pending: 0 });
  });

  it.each([
    ['in the seller state (CGST + SGST)', { gstin: null, state_code: '29', country: 'IN' }, 118_000],
    ['in another state (IGST)', { gstin: null, state_code: '27', country: 'IN' }, 118_000],
    ['with a GSTIN', { gstin: '27AAPFU0939F1ZV', state_code: '29', country: 'IN' }, 118_000],
    ['outside India (export, no GST)', { gstin: null, state_code: null, country: 'US' }, 100_000],
  ])('charges the pack price plus GST for a buyer %s', async (_label, profile, unit) => {
    vi.stubEnv('BILLING_SELLER_STATE_CODE', '29');
    db.profile = profile;
    const { createAddon, p } = provider();
    await expect(purchaseAddon(p, { accountId: ACCOUNT, userId: USER, pack, packs: 3 }, {} as never)).resolves.toEqual({ id: 'addon-1', status: 'active' });
    // The provider call carries the add-on row's id, so a lost answer can be matched later (audit finding 53).
    expect(createAddon).toHaveBeenCalledWith(expect.objectContaining({ amountMinor: unit, quantity: 3, currency: 'INR', reference: 'addon-1' }));
    // The recorded amount is what the provider charges, GST included (the invoice splits it back out).
    expect(db.inserted[0]).toContain(unit * 3);
  });

  it('refuses a second purchase of the same kind while one is still pending, before charging anything (audit finding 53)', async () => {
    vi.stubEnv('BILLING_SELLER_STATE_CODE', '29');
    db.pending = 1;
    const { createAddon, p } = provider();
    await expect(purchaseAddon(p, { accountId: ACCOUNT, userId: USER, pack, packs: 1 }, {} as never)).rejects.toMatchObject({ code: 'purchase_pending', status: 409 });
    expect(createAddon).not.toHaveBeenCalled();
    expect(db.inserted).toEqual([]);
    expect(db.updates.some((sql) => sql.includes('pg_advisory_xact_lock'))).toBe(true);
  });

  it('refuses a pack for a limit the plan leaves unlimited, before charging anything', async () => {
    vi.stubEnv('BILLING_SELLER_STATE_CODE', '29');
    limits.value = null;
    const { createAddon, p } = provider();
    await expect(purchaseAddon(p, { accountId: ACCOUNT, userId: USER, pack, packs: 1 }, {} as never)).rejects.toMatchObject({ code: 'limit_unlimited', status: 409 });
    expect(createAddon).not.toHaveBeenCalled();
    expect(db.inserted).toEqual([]);
    limits.value = 100;
  });

  it('refuses before recording anything when the seller state is not configured', async () => {
    vi.stubEnv('BILLING_SELLER_STATE_CODE', '');
    const { createAddon, p } = provider();
    await expect(purchaseAddon(p, { accountId: ACCOUNT, userId: USER, pack, packs: 1 }, {} as never)).rejects.toThrow(/BILLING_SELLER_STATE_CODE/);
    expect(createAddon).not.toHaveBeenCalled();
    expect(db.inserted).toEqual([]);
  });
});
