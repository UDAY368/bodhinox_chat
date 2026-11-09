import { randomUUID } from 'node:crypto';
import { config } from 'dotenv';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { disconnectDatabases, getPrisma, getWorkerPrisma } from '@/lib/db/prisma';
import { withTenant, type TenantTransaction } from '@/lib/db/tenant';
import { expireReservation, failCheckoutLink, placeOrder } from './checkout';
import { adjustTx, commitTx, StockError } from './stock';
import { issueSessionTx, loadOrderView, loadSession, quoteSessionTx, setAddressTx, setPaymentMethodTx, updateCartTx } from './storefront';
import { StoreError } from './store-settings';

// Phase 8 oversell gate (design E5, E6; test 1) on PostgreSQL: simultaneous
// purchases of the last units, opposite lock orders, replayed places, the
// expiry release and the adjust floor.
const configured = config({ path: '.env.test', quiet: true }).parsed;
const ownerUrl = process.env.TEST_DATABASE_URL;
const appUrl = process.env.TEST_APP_DATABASE_URL || configured?.DATABASE_URL;
const workerUrl = process.env.TEST_WORKER_DATABASE_URL || configured?.WORKER_DATABASE_URL;
if (appUrl) process.env.DATABASE_URL = appUrl;
if (workerUrl) process.env.WORKER_DATABASE_URL = workerUrl;
process.env.APP_URL ??= 'https://app.example.test';
process.env.ENCRYPTION_KEY ??= 'a'.repeat(64);

const account = randomUUID(), owner = randomUUID();
const product = randomUUID(), scarce = randomUUID(), left = randomUUID(), right = randomUUID();
const contacts = Array.from({ length: 24 }, () => randomUUID());
let db: pg.Client;

const worker = <T,>(fn: (tx: TenantTransaction) => Promise<T>) => withTenant({ accountId: account, role: 'owner' }, fn, getWorkerPrisma());

/** A shop session for a contact with a cart and an address; returns its id, version and quoted total. */
async function readySession(contactId: string, lines: Array<{ variantId: string; qty: number }>) {
  const sessionId = randomUUID();
  await worker((tx) => issueSessionTx(tx, account, {
    sessionId, contactId, conversationId: null, whatsappConfigId: null, purpose: 'shop', orderId: null, ttlHours: 24, createdBy: null,
  }));
  await worker((tx) => updateCartTx(tx, account, sessionId, { expectedVersion: 1, lines }));
  await worker((tx) => setAddressTx(tx, account, sessionId, { expectedVersion: 2, address: {
    name: 'Test buyer', phone: '+919876543210', line1: '1 MG Road', city: 'Bengaluru', state: 'Karnataka', state_code: '29',
    postal_code: '560001', country: 'IN',
  } }));
  const quote = await worker(async (tx) => (await quoteSessionTx(tx, account, (await loadSession(tx, account, sessionId))!)).result);
  if (!quote.ok) throw new Error(`quote refused: ${quote.code}`);
  return { sessionId, version: 3, total: quote.quote.totalMinor };
}

const place = (s: { sessionId: string; version: number; total: number }) =>
  placeOrder(account, s.sessionId, { expectedVersion: s.version, expectedTotalMinor: s.total, clientRequestId: randomUUID() });

const level = async (variantId: string) => (await db.query(
  'SELECT on_hand, reserved FROM inventory_levels WHERE account_id=$1 AND variant_id=$2', [account, variantId])).rows[0];

describe.skipIf(!ownerUrl || !appUrl || !workerUrl)('phase 8 stock and checkout on PostgreSQL', { timeout: 180_000 }, () => {
  beforeAll(async () => {
    db = new pg.Client({ connectionString: ownerUrl });
    await db.connect();
    if (!/test/i.test((await db.query('SELECT current_database() AS name')).rows[0].name)) throw new Error('Requires an isolated test database');
    const role = await getPrisma().$queryRaw<{ role: string }[]>`SELECT current_user AS role`;
    if (role[0].role !== 'bodhinox_app') throw new Error('Requires constrained test app credentials');
    await db.query("INSERT INTO auth_users(id,email,full_name,password_hash) VALUES($1::uuid,$2,'P8 stock','test-only-hash')", [owner, `${owner}@example.invalid`]);
    await db.query("INSERT INTO accounts(id,name,owner_user_id) VALUES($1,'P8 stock',$2)", [account, owner]);
    await db.query("INSERT INTO account_subscriptions(account_id,plan_id) VALUES($1,'basic')", [account]);
    await db.query("INSERT INTO account_memberships(account_id,user_id,role) VALUES($1,$2,'owner')", [account, owner]);
    await db.query(`INSERT INTO contacts(id,account_id,user_id,name,phone)
      SELECT c, $2, $3, 'Buyer', '1415555' || lpad(n::text, 4, '0') FROM unnest($1::uuid[]) WITH ORDINALITY AS t(c, n)`, [contacts, account, owner]);
    await db.query(`INSERT INTO commerce_settings(account_id,currency,prices_include_tax,default_tax_rate_bps,checkout_enabled,reservation_minutes)
      VALUES($1,'INR',true,1800,true,15)`, [account]);
    // Online checkout needs a Razorpay connection (a link can be made); the link job never runs here.
    await db.query(`INSERT INTO payment_providers(account_id,provider,mode,key_id,key_secret_enc) VALUES($1,'razorpay','test','rzp_test_SHOP','enc')`, [account]);
    await db.query(`INSERT INTO shipping_rates(account_id,name,country,fee_minor) VALUES($1,'India','IN',5000)`, [account]);
    await db.query(`INSERT INTO shop_products(id,account_id,name,status,content_reviewed_at) VALUES($1,$2,'Ashwagandha','published',now())`, [product, account]);
    await db.query(`INSERT INTO shop_variants(id,account_id,product_id,sku,price_minor) VALUES
      ($1,$4,$5,'ASH-SCARCE',49900),($2,$4,$5,'ASH-LEFT',10000),($3,$4,$5,'ASH-RIGHT',20000)`, [scarce, left, right, account, product]);
    await db.query(`INSERT INTO inventory_levels(account_id,variant_id,on_hand) VALUES($1,$2,5),($1,$3,40),($1,$4,40)`, [account, scarce, left, right]);
  });

  afterAll(async () => {
    if (db) {
      await db.query('DELETE FROM jobs WHERE tenant_id=$1', [account]);
      await db.query('DELETE FROM accounts WHERE id=$1', [account]);
      await db.query('DELETE FROM auth_users WHERE id=$1', [owner]);
      await db.end();
    }
    await disconnectDatabases();
  });

  it('never oversells: 20 simultaneous buyers of 5 units', async () => {
    const sessions = [];
    for (const contact of contacts.slice(0, 20)) sessions.push(await readySession(contact, [{ variantId: scarce, qty: 1 }]));
    const results = await Promise.allSettled(sessions.map(place));
    const placed = results.filter((r) => r.status === 'fulfilled');
    const refused = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(placed).toHaveLength(5);
    expect(refused).toHaveLength(15);
    for (const r of refused) expect((r.reason as StoreError).code).toBe('out_of_stock');
    expect(await level(scarce)).toEqual({ on_hand: 5, reserved: 5 });

    const orderIds = placed.map((r) => (r as PromiseFulfilledResult<{ orderId: string }>).value.orderId);
    const orders = (await db.query('SELECT status, total_minor, priced_at FROM orders WHERE account_id=$1 AND id=ANY($2::uuid[])', [account, orderIds])).rows;
    expect(orders.every((o) => o.status === 'awaiting_payment' && o.priced_at)).toBe(true);
    // Both jobs are queued with the order, once each.
    const jobs = (await db.query(`SELECT type FROM jobs WHERE tenant_id=$1 AND payload->>'orderId' = ANY($2::text[])`, [account, orderIds])).rows;
    expect(jobs.filter((j) => j.type === 'commerce.create_checkout_link')).toHaveLength(5);
    expect(jobs.filter((j) => j.type === 'commerce.reservation_expiry')).toHaveLength(5);

    // Settling the five sales empties the shelf; the ledger sums to on_hand.
    for (const id of orderIds) await worker((tx) => commitTx(tx, account, id));
    expect(await level(scarce)).toEqual({ on_hand: 0, reserved: 0 });
    const ledger = (await db.query(`SELECT kind, sum(quantity)::int AS q FROM inventory_movements WHERE account_id=$1 AND variant_id=$2 GROUP BY kind`,
      [account, scarce])).rows;
    expect(Object.fromEntries(ledger.map((r) => [r.kind, r.q]))).toEqual({ reserve: 5, sale: -5 });
    // One low-stock alert for the owner.
    const alerts = (await db.query(`SELECT count(*)::int AS n FROM notifications WHERE account_id=$1 AND type='low_stock'`, [account])).rows[0].n;
    expect(alerts).toBe(1);
  });

  it('does not deadlock when carts lock the same variants in opposite orders', async () => {
    const sessions = [];
    for (const [i, contact] of contacts.slice(0, 10).entries())
      sessions.push(await readySession(contact, i % 2 ? [{ variantId: left, qty: 1 }, { variantId: right, qty: 1 }] : [{ variantId: right, qty: 1 }, { variantId: left, qty: 1 }]));
    const results = await Promise.allSettled(sessions.map(place));
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(0);
    expect(await level(left)).toEqual({ on_hand: 40, reserved: 10 });
    expect(await level(right)).toEqual({ on_hand: 40, reserved: 10 });
  });

  it('returns the same order for a replayed place and refuses a stale total', async () => {
    const s = await readySession(contacts[20], [{ variantId: left, qty: 2 }]);
    await expect(placeOrder(account, s.sessionId, { expectedVersion: s.version, expectedTotalMinor: s.total + 1, clientRequestId: randomUUID() }))
      .rejects.toMatchObject({ code: 'quote_changed' });
    const first = await place(s);
    const again = await place(s);
    expect(first.created).toBe(true);
    expect(again).toEqual({ orderId: first.orderId, created: false });
    const [order] = (await db.query('SELECT subtotal_minor, shipping_minor, tax_minor, total_minor, source FROM orders WHERE id=$1', [first.orderId])).rows;
    expect(order).toMatchObject({ subtotal_minor: '20000', shipping_minor: '5000', total_minor: String(s.total), source: 'storefront' });
  });

  it('releases the hold when the reservation expires', async () => {
    const s = await readySession(contacts[21], [{ variantId: right, qty: 3 }]);
    const { orderId } = await place(s);
    const before = await level(right);
    await db.query(`UPDATE orders SET reservation_expires_at=now() - interval '2 minutes' WHERE id=$1`, [orderId]);
    await expireReservation(account, { orderId, attempt: 1 });
    expect((await db.query('SELECT status FROM orders WHERE id=$1', [orderId])).rows[0].status).toBe('expired');
    expect(await level(right)).toEqual({ on_hand: before.on_hand, reserved: before.reserved - 3 });
    // A second run changes nothing.
    await expireReservation(account, { orderId, attempt: 1 });
    expect(await level(right)).toEqual({ on_hand: before.on_hand, reserved: before.reserved - 3 });
  });

  it('never adjusts stock below what is reserved', async () => {
    const { reserved, on_hand } = await level(left);
    await expect(worker((tx) => adjustTx(tx, account, { variantId: left, delta: -(on_hand - reserved) - 1, kind: 'adjustment', reason: null, actorUserId: owner })))
      .rejects.toBeInstanceOf(StockError);
    const ok = await worker((tx) => adjustTx(tx, account, { variantId: left, delta: -(on_hand - reserved), kind: 'write_off', reason: 'damaged', actorUserId: owner }));
    expect(ok).toEqual({ variantId: left, onHand: reserved, reserved });
  });

  // ------------------------------------------------------------------ audit 17: no spinner while no link can be made
  it('closes the order at once when Razorpay definitely refuses its checkout link, telling the customer and the admins', async () => {
    const s = await readySession(contacts[22], [{ variantId: right, qty: 2 }]);
    const { orderId } = await place(s);
    const before = await level(right);
    expect(await failCheckoutLink(account, { orderId, attempt: 1 }, 'provider_auth')).toBe(true);
    expect((await db.query('SELECT status FROM orders WHERE id=$1', [orderId])).rows[0].status).toBe('expired');
    expect(await level(right)).toEqual({ on_hand: before.on_hand, reserved: before.reserved - 2 });
    expect((await db.query(`SELECT detail FROM order_events WHERE order_id=$1 AND kind='payment_link_failed'`, [orderId])).rows)
      .toEqual([{ detail: 'provider_auth' }]);
    const notes = (await db.query(`SELECT user_id::text AS user_id, type, link FROM notifications WHERE account_id=$1 AND dedupe_key=$2`,
      [account, `checkout-link-failed:${orderId}:1`])).rows;
    expect(notes).toEqual([{ user_id: owner, type: 'payment_exception', link: `/commerce/orders/${orderId}` }]);
    const view = await worker((tx) => loadOrderView(tx, account, orderId));
    expect(view).toMatchObject({ status: 'expired', paymentFailed: true, paymentUrl: null, paymentPending: false });
    // A second report (job replay) changes nothing.
    expect(await failCheckoutLink(account, { orderId, attempt: 1 }, 'provider_auth')).toBe(false);
    expect(await level(right)).toEqual({ on_hand: before.on_hand, reserved: before.reserved - 2 });
    // An order that simply expired is not shown as a payment-setup failure.
    const t = await readySession(contacts[23], [{ variantId: right, qty: 1 }]);
    const expired = await place(t);
    await db.query(`UPDATE orders SET reservation_expires_at=now() - interval '2 minutes' WHERE id=$1`, [expired.orderId]);
    await expireReservation(account, { orderId: expired.orderId, attempt: 1 });
    expect(await worker((tx) => loadOrderView(tx, account, expired.orderId))).toMatchObject({ status: 'expired', paymentFailed: false });
  });

  it('refuses online payment while Razorpay is not connected, before anything is held', async () => {
    const provider = (await db.query(`DELETE FROM payment_providers WHERE account_id=$1 RETURNING provider, mode, key_id, key_secret_enc`, [account])).rows[0];
    try {
      const s = await readySession(contacts[19], [{ variantId: left, qty: 1 }]);
      const before = await level(left);
      await expect(worker((tx) => setPaymentMethodTx(tx, account, s.sessionId, { expectedVersion: s.version, paymentMethod: 'online' })))
        .rejects.toMatchObject({ code: 'online_unavailable', status: 409 });
      await expect(place(s)).rejects.toMatchObject({ code: 'online_unavailable' });
      expect(await level(left)).toEqual(before);
      expect((await db.query('SELECT count(*)::int AS n FROM orders WHERE storefront_session_id=$1', [s.sessionId])).rows[0].n).toBe(0);
    } finally {
      await db.query(`INSERT INTO payment_providers(account_id,provider,mode,key_id,key_secret_enc) VALUES($1,$2,$3,$4,$5)`,
        [account, provider.provider, provider.mode, provider.key_id, provider.key_secret_enc]);
    }
  });
});
