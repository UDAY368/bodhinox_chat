import { randomUUID } from 'node:crypto';
import { config } from 'dotenv';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { disconnectDatabases, getPrisma, getWorkerPrisma } from '@/lib/db/prisma';
import { withTenant, type TenantTransaction } from '@/lib/db/tenant';
import { CONTACT_HOLD_LIMITS, placeOrder, prepareWhatsAppOrderJob } from './checkout';
import { recordWhatsAppOrder } from './orders';
import { issueSessionTx, loadSession, quoteSessionTx, setAddressTx, updateCartTx } from './storefront';
import type { StoreError } from './store-settings';

// Phase 8 per-contact hold caps (review C18) on PostgreSQL: one contact cannot
// hold the shelf with unpaid orders from fresh sessions, while other contacts
// still reserve; expired holds stop counting; a WhatsApp cart gets no link at the cap.
const configured = config({ path: '.env.test', quiet: true }).parsed;
const ownerUrl = process.env.TEST_DATABASE_URL;
const appUrl = process.env.TEST_APP_DATABASE_URL || configured?.DATABASE_URL;
const workerUrl = process.env.TEST_WORKER_DATABASE_URL || configured?.WORKER_DATABASE_URL;
if (appUrl) process.env.DATABASE_URL = appUrl;
if (workerUrl) process.env.WORKER_DATABASE_URL = workerUrl;
process.env.APP_URL ??= 'https://app.example.test';
process.env.ENCRYPTION_KEY ??= 'a'.repeat(64);

const account = randomUUID(), owner = randomUUID(), product = randomUUID(), variant = randomUUID(), conversation = randomUUID();
const contacts = Array.from({ length: 6 }, () => randomUUID());
const [hoarder, neighbour, bulk, racer, late, whatsapp] = contacts;
let db: pg.Client;

const worker = <T,>(fn: (tx: TenantTransaction) => Promise<T>) => withTenant({ accountId: account, role: 'owner' }, fn, getWorkerPrisma());
const ADDRESS = {
  name: 'Test buyer', phone: '+919876543210', line1: '1 MG Road', city: 'Bengaluru', state: 'Karnataka', state_code: '29',
  postal_code: '560001', country: 'IN',
};

async function readySession(contactId: string, qty: number) {
  const sessionId = randomUUID();
  await worker((tx) => issueSessionTx(tx, account, {
    sessionId, contactId, conversationId: null, whatsappConfigId: null, purpose: 'shop', orderId: null, ttlHours: 24, createdBy: null,
  }));
  await worker((tx) => updateCartTx(tx, account, sessionId, { expectedVersion: 1, lines: [{ variantId: variant, qty }] }));
  await worker((tx) => setAddressTx(tx, account, sessionId, { expectedVersion: 2, address: ADDRESS }));
  const quote = await worker(async (tx) => (await quoteSessionTx(tx, account, (await loadSession(tx, account, sessionId))!)).result);
  if (!quote.ok) throw new Error(`quote refused: ${quote.code}`);
  return { sessionId, version: 3, total: quote.quote.totalMinor };
}

/** A WhatsApp cart of one unit with its purpose='order' session and an address: what each inbound cart message yields. */
async function readyCart(contactId: string) {
  const orderId = randomUUID(), sessionId = randomUUID();
  await worker((tx) => recordWhatsAppOrder(tx, {
    accountId: account, orderId, metaMessageId: `wamid.${randomUUID()}`, contactId, conversationId: conversation, whatsappConfigId: null,
    order: { catalog_id: null, currency: 'INR', subtotal_minor: 1, note: null, items: [{ retailer_id: 'TRI-100', name: null, quantity: 1, unit_price_minor: 1 }] },
  }));
  await worker((tx) => issueSessionTx(tx, account, {
    sessionId, contactId, conversationId: conversation, whatsappConfigId: null, purpose: 'order', orderId, ttlHours: 24, createdBy: null,
  }));
  await worker((tx) => setAddressTx(tx, account, sessionId, { expectedVersion: 1, address: ADDRESS }));
  const quote = await worker(async (tx) => (await quoteSessionTx(tx, account, (await loadSession(tx, account, sessionId))!)).result);
  if (!quote.ok) throw new Error(`quote refused: ${quote.code}`);
  return { orderId, sessionId, version: 2, total: quote.quote.totalMinor };
}

const place = (s: { sessionId: string; version: number; total: number }, now?: Date) =>
  placeOrder(account, s.sessionId, { expectedVersion: s.version, expectedTotalMinor: s.total, clientRequestId: randomUUID() }, now);
const reserved = async () => (await db.query('SELECT reserved FROM inventory_levels WHERE account_id=$1 AND variant_id=$2', [account, variant])).rows[0].reserved;

describe.skipIf(!ownerUrl || !appUrl || !workerUrl)('phase 8 per-contact hold caps on PostgreSQL', { timeout: 180_000 }, () => {
  beforeAll(async () => {
    db = new pg.Client({ connectionString: ownerUrl });
    await db.connect();
    if (!/test/i.test((await db.query('SELECT current_database() AS name')).rows[0].name)) throw new Error('Requires an isolated test database');
    const role = await getPrisma().$queryRaw<{ role: string }[]>`SELECT current_user AS role`;
    if (role[0].role !== 'bodhinox_app') throw new Error('Requires constrained test app credentials');
    await db.query("INSERT INTO auth_users(id,email,full_name,password_hash) VALUES($1::uuid,$2,'P8 holds','test-only-hash')", [owner, `${owner}@example.invalid`]);
    await db.query("INSERT INTO accounts(id,name,owner_user_id) VALUES($1,'P8 holds',$2)", [account, owner]);
    await db.query("INSERT INTO account_subscriptions(account_id,plan_id) VALUES($1,'basic')", [account]);
    await db.query("INSERT INTO account_memberships(account_id,user_id,role) VALUES($1,$2,'owner')", [account, owner]);
    await db.query(`INSERT INTO contacts(id,account_id,user_id,name,phone)
      SELECT c, $2, $3, 'Buyer', '1415666' || lpad(n::text, 4, '0') FROM unnest($1::uuid[]) WITH ORDINALITY AS t(c, n)`, [contacts, account, owner]);
    await db.query('INSERT INTO conversations(id,account_id,user_id,contact_id) VALUES($1,$2,$3,$4)', [conversation, account, owner, whatsapp]);
    await db.query(`INSERT INTO commerce_settings(account_id,currency,prices_include_tax,default_tax_rate_bps,checkout_enabled,reservation_minutes)
      VALUES($1,'INR',true,1800,true,15)`, [account]);
    // Online checkout needs a Razorpay connection (a link can be made); the link job never runs here.
    await db.query(`INSERT INTO payment_providers(account_id,provider,mode,key_id,key_secret_enc) VALUES($1,'razorpay','test','rzp_test_SHOP','enc')`, [account]);
    await db.query(`INSERT INTO shipping_rates(account_id,name,country,fee_minor) VALUES($1,'India','IN',5000)`, [account]);
    await db.query(`INSERT INTO shop_products(id,account_id,name,status,content_reviewed_at) VALUES($1,$2,'Triphala','published',now())`, [product, account]);
    await db.query(`INSERT INTO shop_variants(id,account_id,product_id,sku,price_minor) VALUES($1,$2,$3,'TRI-100',20000)`, [variant, account, product]);
    await db.query(`INSERT INTO inventory_levels(account_id,variant_id,on_hand) VALUES($1,$2,1000)`, [account, variant]);
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

  it('refuses a contact its next open order at the cap while another contact still reserves', async () => {
    for (let i = 0; i < CONTACT_HOLD_LIMITS.openOrders; i += 1) await place(await readySession(hoarder, 1));
    const before = await reserved();
    const extra = await readySession(hoarder, 1);
    await expect(place(extra)).rejects.toMatchObject({ code: 'too_many_open_orders' });
    // Nothing was held or written for the refused place.
    expect(await reserved()).toBe(before);
    expect((await db.query(`SELECT count(*)::int AS n FROM orders WHERE account_id=$1 AND contact_id=$2`, [account, hoarder])).rows[0].n)
      .toBe(CONTACT_HOLD_LIMITS.openOrders);
    await expect(place(await readySession(neighbour, 1))).resolves.toMatchObject({ created: true });
  });

  it('counts concurrent places of one contact in turn, across fresh WhatsApp-cart sessions', async () => {
    const carts = [];
    for (let i = 0; i < CONTACT_HOLD_LIMITS.openOrders + 3; i += 1) carts.push(await readyCart(racer));
    const results = await Promise.allSettled(carts.map((c) => place(c)));
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(CONTACT_HOLD_LIMITS.openOrders);
    for (const r of results.filter((x): x is PromiseRejectedResult => x.status === 'rejected'))
      expect((r.reason as StoreError).code).toBe('too_many_open_orders');
    expect((await db.query(`SELECT count(*)::int AS n FROM orders WHERE account_id=$1 AND contact_id=$2 AND status='awaiting_payment'`,
      [account, racer])).rows[0].n).toBe(CONTACT_HOLD_LIMITS.openOrders);
  });

  it('caps the units of one variant a contact holds across its open orders', async () => {
    await place(await readySession(bulk, CONTACT_HOLD_LIMITS.unitsPerVariant));
    await expect(place(await readySession(bulk, 1))).rejects.toMatchObject({ code: 'too_many_open_orders', detail: { variantId: variant } });
  });

  it('stops counting holds once their reservation has expired', async () => {
    for (let i = 0; i < CONTACT_HOLD_LIMITS.openOrders; i += 1) await place(await readySession(late, 1));
    const next = await readySession(late, 1);
    await expect(place(next)).rejects.toMatchObject({ code: 'too_many_open_orders' });
    await expect(place(next, new Date(Date.now() + 20 * 60_000))).resolves.toMatchObject({ created: true });
  });

  it('sends no checkout link for a WhatsApp cart of a contact at the cap', async () => {
    for (let i = 0; i < CONTACT_HOLD_LIMITS.openOrders; i += 1) await place(await readySession(whatsapp, 1));
    const orderId = randomUUID();
    await worker((tx) => recordWhatsAppOrder(tx, {
      accountId: account, orderId, metaMessageId: `wamid.${randomUUID()}`, contactId: whatsapp, conversationId: conversation, whatsappConfigId: null,
      order: { catalog_id: null, currency: 'INR', subtotal_minor: 1, note: null, items: [{ retailer_id: 'TRI-100', name: null, quantity: 1, unit_price_minor: 1 }] },
    }));
    await prepareWhatsAppOrderJob(account, { orderId });
    const [message] = (await db.query(`SELECT status, reason FROM order_messages WHERE account_id=$1 AND order_id=$2 AND kind='checkout_link'`,
      [account, orderId])).rows;
    expect(message).toEqual({ status: 'skipped', reason: 'too_many_open_orders' });
    expect((await db.query(`SELECT count(*)::int AS n FROM storefront_sessions WHERE account_id=$1 AND order_id=$2`, [account, orderId])).rows[0].n).toBe(0);
  });
});
