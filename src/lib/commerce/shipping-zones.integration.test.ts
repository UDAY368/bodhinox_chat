import { randomUUID } from 'node:crypto';
import { config } from 'dotenv';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { disconnectDatabases, getPrisma, getWorkerPrisma } from '@/lib/db/prisma';
import { withTenant, type TenantTransaction } from '@/lib/db/tenant';
import { quoteShippingForPincode } from './pricing';
import { issueSessionTx, loadSession, quoteSessionTx, setAddressTx, updateCartTx } from './storefront';
import { createShippingRate, listShippingRates, parseShippingRate, pricingRate, selectRates, updateShippingRate } from './store-settings';

// Store Phase 5 on PostgreSQL: zone, weight and free-threshold shipping is read per workspace under RLS,
// written by admins only, and the checkout total is computed on the server from the stored rates and the
// variant's stored weight (the browser sends neither).
const configured = config({ path: '.env.test', quiet: true }).parsed;
const ownerUrl = process.env.TEST_DATABASE_URL;
const appUrl = process.env.TEST_APP_DATABASE_URL || configured?.DATABASE_URL;
const workerUrl = process.env.TEST_WORKER_DATABASE_URL || configured?.WORKER_DATABASE_URL;
if (appUrl) process.env.DATABASE_URL = appUrl;
if (workerUrl) process.env.WORKER_DATABASE_URL = workerUrl;
process.env.APP_URL ??= 'https://app.example.test';
process.env.ENCRYPTION_KEY ??= 'a'.repeat(64);

const A = randomUUID(), B = randomUUID(), owner = randomUUID();
const product = randomUUID(), variant = randomUUID(), contact = randomUUID();
const admin = { accountId: A, userId: owner, role: 'admin' as const };
const agent = { ...admin, role: 'agent' as const };
const otherAdmin = { accountId: B, userId: owner, role: 'admin' as const };
let db: pg.Client;

const worker = <T,>(fn: (tx: TenantTransaction) => Promise<T>) => withTenant({ accountId: A, role: 'owner' }, fn, getWorkerPrisma());
const address = (over: Record<string, unknown>) => ({
  name: 'Test buyer', phone: '+919876543210', line1: '1 Street', city: 'Pune', state: 'Maharashtra', state_code: 'MH', postal_code: '411001', country: 'IN', ...over,
});
const rateBody = (over: Record<string, unknown>) => parseShippingRate({ name: 'Rate', country: 'IN', fee_minor: 5000, active: true, ...over });

/** Quote a one-line cart (qty units of the 400 g variant) for an address, the way checkout does. */
async function quote(qty: number, addr: Record<string, unknown>) {
  const sessionId = randomUUID();
  await worker((tx) => issueSessionTx(tx, A, {
    sessionId, contactId: contact, conversationId: null, whatsappConfigId: null, purpose: 'shop', orderId: null, ttlHours: 24, createdBy: null,
  }));
  await worker((tx) => updateCartTx(tx, A, sessionId, { expectedVersion: 1, lines: [{ variantId: variant, qty }] }));
  await worker((tx) => setAddressTx(tx, A, sessionId, { expectedVersion: 2, address: addr }));
  return worker(async (tx) => (await quoteSessionTx(tx, A, (await loadSession(tx, A, sessionId))!)).result);
}

describe.skipIf(!ownerUrl || !appUrl || !workerUrl)('weight and zone shipping on PostgreSQL', { timeout: 180_000 }, () => {
  beforeAll(async () => {
    db = new pg.Client({ connectionString: ownerUrl });
    await db.connect();
    if (!/test/i.test((await db.query('SELECT current_database() AS name')).rows[0].name)) throw new Error('Requires an isolated test database');
    const role = await getPrisma().$queryRaw<{ role: string }[]>`SELECT current_user AS role`;
    if (role[0].role !== 'bodhinox_app') throw new Error('Requires constrained test app credentials');
    await db.query("INSERT INTO auth_users(id,email,full_name,password_hash) VALUES($1,$2,'Zones','test-only-hash')", [owner, `${owner}@example.invalid`]);
    for (const [id, name] of [[A, 'Zones A'], [B, 'Zones B']]) {
      await db.query('INSERT INTO accounts(id,name,owner_user_id) VALUES($1,$2,$3)', [id, name, owner]);
      await db.query("INSERT INTO account_subscriptions(account_id,plan_id) VALUES($1,'basic')", [id]);
      await db.query("INSERT INTO account_memberships(account_id,user_id,role) VALUES($1,$2,'owner')", [id, owner]);
      await db.query(`INSERT INTO commerce_settings(account_id,currency,prices_include_tax,default_tax_rate_bps,checkout_enabled)
        VALUES($1,'INR',true,0,true)`, [id]);
    }
    await db.query("INSERT INTO contacts(id,account_id,user_id,name,phone) VALUES($1,$2,$3,'Buyer','14157770001')", [contact, A, owner]);
    await db.query("INSERT INTO shop_products(id,account_id,name,status,content_reviewed_at) VALUES($1,$2,'Oil','published',now())", [product, A]);
    await db.query("INSERT INTO shop_variants(id,account_id,product_id,sku,price_minor,weight_grams) VALUES($1,$2,$3,'OIL-1',10000,400)", [variant, A, product]);
    await db.query('INSERT INTO inventory_levels(account_id,variant_id,on_hand) VALUES($1,$2,100)', [A, variant]);
    // Another workspace's cheap whole-country rate must never price A's cart.
    await db.query("INSERT INTO shipping_rates(account_id,name,country,fee_minor) VALUES($1,'B rest of India','IN',100)", [B]);
  });

  afterAll(async () => {
    if (db) {
      await db.query('DELETE FROM accounts WHERE id = ANY($1::uuid[])', [[A, B]]);
      await db.query('DELETE FROM auth_users WHERE id=$1', [owner]);
      await db.end();
    }
    await disconnectDatabases();
  });

  it('lets an admin write zones and slabs, refuses an agent, and keeps workspaces apart', async () => {
    await expect(createShippingRate(agent, rateBody({ name: 'Nope' }))).rejects.toThrow();
    const rest = await createShippingRate(admin, rateBody({ name: 'Rest of India', fee_minor: 9000, cod_allowed: false }));
    const state = await createShippingRate(admin, rateBody({
      name: 'Maharashtra', states: ['mh', 'Maharashtra'], fee_minor: 4000, base_weight_grams: 500, step_grams: 500, extra_per_step_minor: 1500,
      free_over_minor: 50000,
    }));
    expect(state).toMatchObject({ states: ['MH', 'MAHARASHTRA'], step_grams: 500, extra_per_step_minor: 1500, free_over_minor: 50000, cod_allowed: true });
    expect(rest.cod_allowed).toBe(false);
    await expect(listShippingRates(agent)).resolves.toHaveLength(2);
    expect((await listShippingRates(otherAdmin)).map((r) => r.name)).toEqual(['B rest of India']);
    await expect(updateShippingRate(otherAdmin, state.id, rateBody({ name: 'Hijack' }))).rejects.toMatchObject({ code: 'not_found' });
    await expect(updateShippingRate(agent, state.id, rateBody({ name: 'Hijack' }))).rejects.toThrow();
    expect((await listShippingRates(admin)).find((r) => r.id === state.id)?.name).toBe('Maharashtra');
  });

  it('refuses malformed zone or slab input at the API and in the table', async () => {
    expect(() => rateBody({ step_grams: 500 })).toThrow();
    expect(() => rateBody({ states: ['x'] })).toThrow();
    expect(() => rateBody({ cod_allowed: 'yes' })).toThrow();
    expect(() => rateBody({ max_weight_grams: 0 })).toThrow();
    await expect(db.query("INSERT INTO shipping_rates(account_id,name,country,fee_minor,step_grams) VALUES($1,'bad','IN',1,100)", [A])).rejects.toThrow();
  });

  it('prices the checkout on the server from stored rates and the stored weight', async () => {
    // 2 x 400 g = 800 g: one extra 500 g step on the Maharashtra rate; 20000 is under the free threshold.
    const mh = await quote(2, address({}));
    expect(mh.ok && mh.quote.shipping).toMatchObject({ name: 'Maharashtra', feeMinor: 5500 });
    expect(mh.ok && mh.quote.totalMinor).toBe(20000 + 5500);
    // 5 x 400 g reaches 50000: free.
    const free = await quote(5, address({}));
    expect(free.ok && free.quote.shippingMinor).toBe(0);
    // Another state falls to the catch-all (never workspace B's 100), and its zone turns COD off.
    const ka = await quote(2, address({ state: 'Karnataka', state_code: 'KA', postal_code: '560001' }));
    expect(ka.ok && ka.quote.shipping).toMatchObject({ name: 'Rest of India', feeMinor: 9000 });
    expect(ka.ok && ka.quote.codAvailable).toBe(false);
    // The weight is the variant's stored one: change it and the same cart costs more.
    await db.query('UPDATE shop_variants SET weight_grams=1200 WHERE id=$1', [variant]);
    const heavier = await quote(2, address({})); // 2400 g -> 4 extra steps
    expect(heavier.ok && heavier.quote.shippingMinor).toBe(4000 + 1500 * 4);
    await db.query('UPDATE shop_variants SET weight_grams=400 WHERE id=$1', [variant]);
  });

  it('is not deliverable when only zone rates exist and the address is outside them', async () => {
    await db.query("DELETE FROM shipping_rates WHERE account_id=$1 AND name='Rest of India'", [A]);
    const out = await quote(1, address({ state: 'Karnataka', state_code: 'KA', postal_code: '560001' }));
    expect(out).toEqual({ ok: false, code: 'shipping_unavailable' });
    const rates = (await withTenant(admin, (tx) => selectRates(tx, A, true))).map(pricingRate);
    expect(quoteShippingForPincode(rates, { pincode: '560001', state: 'Karnataka' }).deliverable).toBe(false);
    expect(quoteShippingForPincode(rates, { pincode: '411001', stateCode: 'MH', weightGrams: 800 })).toMatchObject({ deliverable: true, priceMinor: 5500, cod: true });
  });
});
