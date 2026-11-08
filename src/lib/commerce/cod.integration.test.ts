import { randomUUID } from 'node:crypto';
import { config } from 'dotenv';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { disconnectDatabases, getPrisma, getWorkerPrisma } from '@/lib/db/prisma';
import { withTenant, type TenantTransaction } from '@/lib/db/tenant';
import { issueReceiptTx } from './documents';
import { CONTACT_HOLD_LIMITS, placeOrder } from './checkout';
import { recordDispatch, transitionOrder } from './order-lifecycle';
import { createReturn } from './returns';
import { issueSessionTx, loadSession, quoteSessionTx, setAddressTx, setPaymentMethodTx, updateCartTx } from './storefront';
import { recordOfflinePayment } from '@/lib/payments/offline';

// Cash on delivery on PostgreSQL: the store switch and the per-product flag gate the choice; a COD
// order is confirmed with its stock held (no expiry, no payment link), counts toward the contact's
// hold cap, ships before payment (the order trigger allows confirmed -> dispatched only for COD),
// keeps its dispatched status when the cash is recorded (stock committed, receipt with the fee),
// and releases its stock when cancelled, also from dispatched (parcel returned).
const configured = config({ path: '.env.test', quiet: true }).parsed;
const ownerUrl = process.env.TEST_DATABASE_URL;
const appUrl = process.env.TEST_APP_DATABASE_URL || configured?.DATABASE_URL;
const workerUrl = process.env.TEST_WORKER_DATABASE_URL || configured?.WORKER_DATABASE_URL;
if (appUrl) process.env.DATABASE_URL = appUrl;
if (workerUrl) process.env.WORKER_DATABASE_URL = workerUrl;
process.env.APP_URL ??= 'https://app.example.test';
process.env.ENCRYPTION_KEY ??= 'a'.repeat(64);

const account = randomUUID(), owner = randomUUID();
const product = randomUUID(), variant = randomUUID(), prepaidProduct = randomUUID(), prepaidVariant = randomUUID();
const contacts = Array.from({ length: 4 }, () => randomUUID());
const [buyer, hoarder, returner, onlineBuyer] = contacts;
const COD_FEE = 4000;
let db: pg.Client;

const worker = <T,>(fn: (tx: TenantTransaction) => Promise<T>) => withTenant({ accountId: account, role: 'owner' }, fn, getWorkerPrisma());
const staff = { accountId: account, userId: owner, role: 'owner' as const };
const ADDRESS = {
  name: 'Test buyer', phone: '+919876543210', line1: '1 MG Road', city: 'Bengaluru', state: 'Karnataka', state_code: '29',
  postal_code: '560001', country: 'IN',
};

/** A shop session with one line and an address; `cod` chooses cash on delivery. */
async function readySession(contactId: string, opts: { cod?: boolean; variantId?: string; qty?: number } = {}) {
  const sessionId = randomUUID();
  await worker((tx) => issueSessionTx(tx, account, {
    sessionId, contactId, conversationId: null, whatsappConfigId: null, purpose: 'shop', orderId: null, ttlHours: 24, createdBy: null,
  }));
  await worker((tx) => updateCartTx(tx, account, sessionId, { expectedVersion: 1, lines: [{ variantId: opts.variantId ?? variant, qty: opts.qty ?? 1 }] }));
  await worker((tx) => setAddressTx(tx, account, sessionId, { expectedVersion: 2, address: ADDRESS }));
  let version = 3;
  if (opts.cod) {
    await worker((tx) => setPaymentMethodTx(tx, account, sessionId, { expectedVersion: version, paymentMethod: 'cod' }));
    version += 1;
  }
  const quote = await worker(async (tx) => (await quoteSessionTx(tx, account, (await loadSession(tx, account, sessionId))!)).result);
  if (!quote.ok) throw new Error(`quote refused: ${quote.code}`);
  return { sessionId, version, total: quote.quote.totalMinor, quote: quote.quote };
}

const place = (s: { sessionId: string; version: number; total: number }) =>
  placeOrder(account, s.sessionId, { expectedVersion: s.version, expectedTotalMinor: s.total, clientRequestId: randomUUID() });
const level = async () => (await db.query('SELECT on_hand, reserved FROM inventory_levels WHERE account_id=$1 AND variant_id=$2',
  [account, variant])).rows[0] as { on_hand: number; reserved: number };
const orderRow = async (id: string) => (await db.query(
  'SELECT status, payment_method, cod_fee_minor::int AS fee, total_minor::int AS total, reservation_expires_at, paid_at FROM orders WHERE id=$1',
  [id])).rows[0];
const pgError = (p: Promise<unknown>) => p.then(() => null, (e: { message?: string }) => e.message ?? 'error');

describe.skipIf(!ownerUrl || !appUrl || !workerUrl)('cash on delivery on PostgreSQL', { timeout: 180_000 }, () => {
  beforeAll(async () => {
    db = new pg.Client({ connectionString: ownerUrl });
    await db.connect();
    if (!/test/i.test((await db.query('SELECT current_database() AS name')).rows[0].name)) throw new Error('Requires an isolated test database');
    const role = await getPrisma().$queryRaw<{ role: string }[]>`SELECT current_user AS role`;
    if (role[0].role !== 'bodhinox_app') throw new Error('Requires constrained test app credentials');
    await db.query("INSERT INTO auth_users(id,email,full_name,password_hash) VALUES($1::uuid,$2,'COD','test-only-hash')", [owner, `${owner}@example.invalid`]);
    await db.query("INSERT INTO accounts(id,name,owner_user_id) VALUES($1,'COD store',$2)", [account, owner]);
    await db.query("INSERT INTO account_subscriptions(account_id,plan_id) VALUES($1,'basic')", [account]);
    await db.query("INSERT INTO account_memberships(account_id,user_id,role) VALUES($1,$2,'owner')", [account, owner]);
    await db.query(`INSERT INTO contacts(id,account_id,user_id,name,phone)
      SELECT c, $2, $3, 'Buyer', '1415777' || lpad(n::text, 4, '0') FROM unnest($1::uuid[]) WITH ORDINALITY AS t(c, n)`, [contacts, account, owner]);
    await db.query(`INSERT INTO commerce_settings(account_id,currency,prices_include_tax,default_tax_rate_bps,checkout_enabled,reservation_minutes)
      VALUES($1,'INR',true,1800,true,15)`, [account]);
    await db.query(`INSERT INTO shipping_rates(account_id,name,country,fee_minor) VALUES($1,'India','IN',5000)`, [account]);
    await db.query(`INSERT INTO shop_products(id,account_id,name,status,content_reviewed_at) VALUES($1,$2,'Triphala','published',now())`, [product, account]);
    await db.query(`INSERT INTO shop_products(id,account_id,name,status,content_reviewed_at,cod_available)
      VALUES($1,$2,'Prepaid only','published',now(),false)`, [prepaidProduct, account]);
    await db.query(`INSERT INTO shop_variants(id,account_id,product_id,sku,price_minor) VALUES($1,$2,$3,'COD-100',20000),($4,$2,$5,'PRE-100',20000)`,
      [variant, account, product, prepaidVariant, prepaidProduct]);
    await db.query(`INSERT INTO inventory_levels(account_id,variant_id,on_hand) VALUES($1,$2,100),($1,$3,100)`, [account, variant, prepaidVariant]);
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

  it('refuses COD while the store has it off, and for a product that opts out', async () => {
    await expect(readySession(buyer, { cod: true })).rejects.toMatchObject({ code: 'cod_unavailable' });
    await db.query('UPDATE commerce_settings SET cod_enabled=true, cod_fee_minor=$2 WHERE account_id=$1', [account, COD_FEE]);
    await expect(readySession(buyer, { cod: true, variantId: prepaidVariant })).rejects.toMatchObject({ code: 'cod_unavailable' });
    // The online quote reports whether COD could be chosen.
    expect((await readySession(buyer)).quote.codAvailable).toBe(true);
    expect((await readySession(buyer, { variantId: prepaidVariant })).quote.codAvailable).toBe(false);
  });

  it('places a COD order confirmed, with the fee, its stock held without expiry and no payment link', async () => {
    const before = await level();
    const session = await readySession(buyer, { cod: true });
    expect(session.quote).toMatchObject({ paymentMethod: 'cod', codFeeMinor: COD_FEE, totalMinor: 20000 + 5000 + COD_FEE });
    const { orderId } = await place(session);
    expect(await orderRow(orderId)).toMatchObject({
      status: 'confirmed', payment_method: 'cod', fee: COD_FEE, total: 20000 + 5000 + COD_FEE, reservation_expires_at: null, paid_at: null,
    });
    expect((await level()).reserved).toBe(before.reserved + 1);
    expect((await db.query(`SELECT status, expires_at FROM stock_reservations WHERE order_id=$1`, [orderId])).rows)
      .toEqual([{ status: 'held', expires_at: null }]);
    expect((await db.query(`SELECT count(*)::int AS n FROM jobs WHERE tenant_id=$1 AND (dedupe_key LIKE $2 OR dedupe_key LIKE $3)`,
      [account, `resv-exp:${orderId}%`, `colink:${orderId}%`])).rows[0].n).toBe(0);
    expect((await db.query(`SELECT kind FROM order_events WHERE order_id=$1 AND kind='cod_confirmed'`, [orderId])).rows).toHaveLength(1);
    // Once priced, the payment method and fee are frozen for every role.
    expect(await pgError(db.query(`UPDATE orders SET payment_method='online' WHERE id=$1`, [orderId]))).toMatch(/order_priced_frozen/);
  });

  it('counts unpaid COD orders toward the contact hold cap', async () => {
    for (let i = 0; i < CONTACT_HOLD_LIMITS.openOrders; i += 1) await place(await readySession(hoarder, { cod: true }));
    await expect(place(await readySession(hoarder, { cod: true }))).rejects.toMatchObject({ code: 'too_many_open_orders' });
    await expect(place(await readySession(hoarder))).rejects.toMatchObject({ code: 'too_many_open_orders' });
  });

  it('ships before payment, records the cash keeping dispatched, commits the stock and prints the fee', async () => {
    const { orderId } = await place(await readySession(buyer, { cod: true }));
    const placed = await level();
    await recordDispatch(staff, orderId, { from: 'confirmed' });
    expect((await orderRow(orderId)).status).toBe('dispatched');
    const { paymentId } = await recordOfflinePayment(staff, orderId,
      { amount: String((20000 + 5000 + COD_FEE) / 100), method: 'cash', clientRequestId: randomUUID() });
    const paid = await orderRow(orderId);
    expect(paid.status).toBe('dispatched');
    expect(paid.paid_at).not.toBeNull();
    // Committed: the hold leaves `reserved` and the unit leaves `on_hand`, once.
    expect(await level()).toEqual({ on_hand: placed.on_hand - 1, reserved: placed.reserved - 1 });
    await expect(recordOfflinePayment(staff, orderId, { amount: '290', method: 'cash', clientRequestId: randomUUID() }))
      .rejects.toMatchObject({ code: 'not_payable' });
    const documentId = await worker((tx) => issueReceiptTx(tx, account, paymentId));
    expect((await db.query('SELECT cod_fee_minor::int AS fee, total_minor::int AS total FROM commerce_documents WHERE id=$1', [documentId])).rows[0])
      .toEqual({ fee: COD_FEE, total: 20000 + 5000 + COD_FEE });
  });

  it('releases the stock when a COD order is cancelled, also once dispatched (parcel returned)', async () => {
    const start = await level();
    const kept = await place(await readySession(returner, { cod: true }));
    const returned = await place(await readySession(returner, { cod: true }));
    expect((await level()).reserved).toBe(start.reserved + 2);
    await transitionOrder(staff, kept.orderId, { from: 'confirmed', to: 'cancelled' });
    await recordDispatch(staff, returned.orderId, { from: 'confirmed' });
    await transitionOrder(staff, returned.orderId, { from: 'dispatched', to: 'cancelled' });
    expect(await level()).toEqual(start);
    expect((await db.query(`SELECT DISTINCT status FROM stock_reservations WHERE order_id = ANY($1::uuid[])`, [[kept.orderId, returned.orderId]])).rows)
      .toEqual([{ status: 'released' }]);
  });

  it('while a COD courier shipment is live: no cancel and no cash; an unpaid COD parcel is cancelled, not returned', async () => {
    const { orderId } = await place(await readySession(returner, { cod: true }));
    const connection = randomUUID();
    await db.query(`INSERT INTO courier_connections(id,account_id,api_email,api_password_enc,token_enc,webhook_token_hash)
      VALUES($1,$2,'api@example.invalid','enc-p','enc-t',repeat('c',64))`, [connection, account]);
    await db.query(`INSERT INTO order_shipments(account_id,order_id,connection_id,reference,create_state,awb,length_cm,breadth_cm,height_cm,weight_grams)
      VALUES($1,$2,$3,'bxcodtest00001','created','AWB123456',10,10,10,500)`, [account, orderId, connection]);
    const held = await level();
    await expect(transitionOrder(staff, orderId, { from: 'confirmed', to: 'cancelled' })).rejects.toMatchObject({ code: 'shipment_live' });
    await expect(recordOfflinePayment(staff, orderId, { amount: '290', method: 'upi', clientRequestId: randomUUID() }))
      .rejects.toMatchObject({ code: 'shipment_live' });
    expect((await orderRow(orderId)).status).toBe('confirmed');
    expect(await level()).toEqual(held);
    // Shipped and unpaid: a return would restock units that were never taken off on_hand.
    await recordDispatch(staff, orderId, { from: 'confirmed' });
    const [item] = (await db.query('SELECT id FROM order_items WHERE order_id=$1', [orderId])).rows;
    await expect(createReturn(staff, orderId, { items: [{ order_item_id: item.id, qty: 1 }] })).rejects.toMatchObject({ code: 'bad_transition' });
  });

  it('still refuses to ship an unpaid online order, in the service and in the database', async () => {
    const { orderId } = await place(await readySession(onlineBuyer));
    expect((await orderRow(orderId)).status).toBe('awaiting_payment');
    await expect(recordDispatch(staff, orderId, { from: 'awaiting_payment' })).rejects.toMatchObject({ code: 'bad_transition' });
    await expect(transitionOrder(staff, orderId, { from: 'awaiting_payment', to: 'confirmed' })).rejects.toMatchObject({ code: 'bad_transition' });
    // Even a direct write cannot move a priced, unpaid online order from confirmed to dispatched; a COD one may.
    const [online, cod] = [randomUUID(), randomUUID()];
    await db.query(`INSERT INTO orders(id,account_id,source,status,currency,subtotal_minor,total_minor,priced_at,payment_method)
      VALUES($1,$3,'manual','confirmed','INR',100,100,now(),'online'),($2,$3,'manual','confirmed','INR',100,100,now(),'cod')`,
    [online, cod, account]);
    expect(await pgError(db.query(`UPDATE orders SET status='dispatched' WHERE id=$1`, [online]))).toMatch(/order_not_paid/);
    expect(await pgError(db.query(`UPDATE orders SET status='dispatched' WHERE id=$1`, [cod]))).toBeNull();
  });
});
