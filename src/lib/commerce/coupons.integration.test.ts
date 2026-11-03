import { randomUUID } from 'node:crypto';
import { config } from 'dotenv';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { disconnectDatabases, getPrisma, getWorkerPrisma } from '@/lib/db/prisma';
import { withTenant, type TenantTransaction } from '@/lib/db/tenant';
import { placeOrder } from './checkout';
import { recordWhatsAppOrder } from './orders';
import { applyCouponTx, issueSessionTx, loadSession, loadStorefrontView, quoteSessionTx, setAddressTx, updateCartTx } from './storefront';
import { StoreError } from './store-settings';

// Phase 8 coupons and the WhatsApp-cart checkout on PostgreSQL (design E2, §3;
// test 7): a single-use coupon used concurrently succeeds once, the
// per-contact limit holds, a released redemption frees the coupon, and a
// WhatsApp cart is repriced from the catalogue (the Meta price is only kept).
const configured = config({ path: '.env.test', quiet: true }).parsed;
const ownerUrl = process.env.TEST_DATABASE_URL;
const appUrl = process.env.TEST_APP_DATABASE_URL || configured?.DATABASE_URL;
const workerUrl = process.env.TEST_WORKER_DATABASE_URL || configured?.WORKER_DATABASE_URL;
if (appUrl) process.env.DATABASE_URL = appUrl;
if (workerUrl) process.env.WORKER_DATABASE_URL = workerUrl;
process.env.APP_URL ??= 'https://app.example.test';
process.env.ENCRYPTION_KEY ??= 'a'.repeat(64);

const account = randomUUID(), owner = randomUUID(), product = randomUUID(), variant = randomUUID();
const contacts = Array.from({ length: 8 }, () => randomUUID());
const conversation = randomUUID();
let db: pg.Client;

const worker = <T,>(fn: (tx: TenantTransaction) => Promise<T>) => withTenant({ accountId: account, role: 'owner' }, fn, getWorkerPrisma());
const ADDRESS = { name: 'Buyer', phone: '+919876543210', line1: '1 MG Road', city: 'Bengaluru', postal_code: '560001', country: 'IN' };

async function couponSession(contactId: string, code: string) {
  const sessionId = randomUUID();
  await worker((tx) => issueSessionTx(tx, account, {
    sessionId, contactId, conversationId: null, whatsappConfigId: null, purpose: 'shop', orderId: null, ttlHours: 24, createdBy: null,
  }));
  await worker((tx) => updateCartTx(tx, account, sessionId, { expectedVersion: 1, lines: [{ variantId: variant, qty: 1 }] }));
  await worker((tx) => setAddressTx(tx, account, sessionId, { expectedVersion: 2, address: ADDRESS }));
  await worker((tx) => applyCouponTx(tx, account, sessionId, { expectedVersion: 3, code }));
  const quote = await worker(async (tx) => (await quoteSessionTx(tx, account, (await loadSession(tx, account, sessionId))!)).result);
  if (!quote.ok) throw new Error(`quote refused: ${quote.code}`);
  return { sessionId, total: quote.quote.totalMinor, discount: quote.quote.discountMinor };
}

const place = (s: { sessionId: string; total: number }, version = 4) =>
  placeOrder(account, s.sessionId, { expectedVersion: version, expectedTotalMinor: s.total, clientRequestId: randomUUID() });

describe.skipIf(!ownerUrl || !appUrl || !workerUrl)('phase 8 coupons and WhatsApp checkout on PostgreSQL', { timeout: 120_000 }, () => {
  beforeAll(async () => {
    db = new pg.Client({ connectionString: ownerUrl });
    await db.connect();
    if (!/test/i.test((await db.query('SELECT current_database() AS name')).rows[0].name)) throw new Error('Requires an isolated test database');
    const role = await getPrisma().$queryRaw<{ role: string }[]>`SELECT current_user AS role`;
    if (role[0].role !== 'bodhinox_app') throw new Error('Requires constrained test app credentials');
    await db.query("INSERT INTO auth_users(id,email,full_name,password_hash) VALUES($1::uuid,$2,'P8 coupons','test-only-hash')", [owner, `${owner}@example.invalid`]);
    await db.query("INSERT INTO accounts(id,name,owner_user_id) VALUES($1,'P8 coupons',$2)", [account, owner]);
    await db.query("INSERT INTO account_subscriptions(account_id,plan_id) VALUES($1,'basic')", [account]);
    await db.query("INSERT INTO account_memberships(account_id,user_id,role) VALUES($1,$2,'owner')", [account, owner]);
    await db.query(`INSERT INTO contacts(id,account_id,user_id,name,phone)
      SELECT c, $2, $3, 'Buyer', '1415666' || lpad(n::text, 4, '0') FROM unnest($1::uuid[]) WITH ORDINALITY AS t(c, n)`, [contacts, account, owner]);
    await db.query('INSERT INTO conversations(id,account_id,user_id,contact_id) VALUES($1,$2,$3,$4)', [conversation, account, owner, contacts[7]]);
    await db.query(`INSERT INTO commerce_settings(account_id,currency,prices_include_tax,default_tax_rate_bps,checkout_enabled)
      VALUES($1,'INR',false,500,true)`, [account]);
    await db.query(`INSERT INTO shipping_rates(account_id,name,country,fee_minor,tax_rate_bps) VALUES($1,'India','IN',0,0)`, [account]);
    await db.query(`INSERT INTO shop_products(id,account_id,name,status,content_reviewed_at) VALUES($1,$2,'Triphala','published',now())`, [product, account]);
    await db.query(`INSERT INTO shop_variants(id,account_id,product_id,sku,price_minor) VALUES($1,$2,$3,'TRI-100',20000)`, [variant, account, product]);
    await db.query(`INSERT INTO inventory_levels(account_id,variant_id,on_hand) VALUES($1,$2,100)`, [account, variant]);
    await db.query(`INSERT INTO coupons(account_id,code,kind,value,max_redemptions) VALUES($1,'ONCE','fixed',1000,1)`, [account]);
    await db.query(`INSERT INTO coupons(account_id,code,kind,value,per_contact_limit) VALUES($1,'MINE','percent',1000,1)`, [account]);
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

  it('lets a single-use coupon succeed once under concurrency', async () => {
    const sessions = [];
    for (const contact of contacts.slice(0, 5)) sessions.push(await couponSession(contact, 'ONCE'));
    expect(sessions[0].discount).toBe(1000);
    const results = await Promise.allSettled(sessions.map((s) => place(s)));
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    for (const r of results.filter((x): x is PromiseRejectedResult => x.status === 'rejected'))
      expect((r.reason as StoreError).code).toBe('coupon_exhausted');
    const redemptions = (await db.query(`SELECT count(*)::int AS n FROM coupon_redemptions r JOIN coupons c ON c.id=r.coupon_id
      WHERE r.account_id=$1 AND c.code='ONCE' AND r.status<>'released'`, [account])).rows[0].n;
    expect(redemptions).toBe(1);
    // The refused buyers keep their sessions and stock: nothing was reserved for them.
    expect((await db.query('SELECT reserved FROM inventory_levels WHERE variant_id=$1', [variant])).rows[0].reserved).toBe(1);
  });

  it('holds the per-contact limit across sessions', async () => {
    const first = await couponSession(contacts[5], 'MINE');
    await place(first);
    const second = await couponSession(contacts[5], 'MINE');
    await expect(place(second)).rejects.toMatchObject({ code: 'coupon_limit_reached' });
    const other = await couponSession(contacts[6], 'MINE');
    await expect(place(other)).resolves.toMatchObject({ created: true });
  });

  it('reprices a WhatsApp cart from the catalogue and keeps the Meta price only as submitted', async () => {
    const orderId = randomUUID();
    await worker((tx) => recordWhatsAppOrder(tx, {
      accountId: account, orderId, metaMessageId: `wamid.${randomUUID()}`, contactId: contacts[7], conversationId: conversation, whatsappConfigId: null,
      order: { catalog_id: null, currency: 'INR', subtotal_minor: 2, note: null, items: [{ retailer_id: 'TRI-100', name: null, quantity: 2, unit_price_minor: 1 }] },
    }));
    expect((await db.query(`SELECT count(*)::int AS n FROM jobs WHERE dedupe_key=$1`, [`prep:${orderId}`])).rows[0].n).toBe(1);
    const sessionId = randomUUID();
    await worker((tx) => issueSessionTx(tx, account, {
      sessionId, contactId: contacts[7], conversationId: conversation, whatsappConfigId: null, purpose: 'order', orderId, ttlHours: 24, createdBy: null,
    }));
    // The cart of a WhatsApp order is fixed.
    await expect(worker((tx) => updateCartTx(tx, account, sessionId, { expectedVersion: 1, lines: [{ variantId: variant, qty: 5 }] })))
      .rejects.toMatchObject({ code: 'cart_locked' });
    await worker((tx) => setAddressTx(tx, account, sessionId, { expectedVersion: 1, address: ADDRESS }));
    const view = await worker((tx) => loadStorefrontView(tx, account, sessionId));
    expect(view?.quote).toMatchObject({ ok: true, quote: { subtotalMinor: 40000, taxMinor: 2000, totalMinor: 42000 } });
    await placeOrder(account, sessionId, { expectedVersion: 2, expectedTotalMinor: 42000, clientRequestId: randomUUID() });
    const [order] = (await db.query('SELECT status, subtotal_minor, total_minor, priced_at FROM orders WHERE id=$1', [orderId])).rows;
    expect(order).toMatchObject({ status: 'awaiting_payment', subtotal_minor: '40000', total_minor: '42000' });
    const [item] = (await db.query('SELECT unit_price_minor, submitted_unit_price_minor, variant_id, tax_minor FROM order_items WHERE order_id=$1', [orderId])).rows;
    expect(item).toMatchObject({ unit_price_minor: '20000', submitted_unit_price_minor: '1', variant_id: variant, tax_minor: '2000' });
  });
});
