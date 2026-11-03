import { randomUUID } from 'node:crypto';
import { config } from 'dotenv';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { disconnectDatabases, getWorkerPrisma } from '@/lib/db/prisma';
import { withTenant } from '@/lib/db/tenant';
import { issueSessionTx } from '@/lib/commerce/storefront';
import { GET as view } from './[token]/route';
import { PUT as putCart } from './[token]/cart/route';
import { PUT as putAddress } from './[token]/address/route';
import { POST as place } from './[token]/place/route';
import { GET as status } from './[token]/status/route';

// The anonymous storefront API end to end on PostgreSQL (design §4, E12, E13):
// token resolution through the definer, Origin checks, version checks, place,
// and a status read that ignores every razorpay_* parameter.
const configured = config({ path: '.env.test', quiet: true }).parsed;
const ownerUrl = process.env.TEST_DATABASE_URL;
const appUrl = process.env.TEST_APP_DATABASE_URL || configured?.DATABASE_URL;
const workerUrl = process.env.TEST_WORKER_DATABASE_URL || configured?.WORKER_DATABASE_URL;
if (appUrl) process.env.DATABASE_URL = appUrl;
if (workerUrl) process.env.WORKER_DATABASE_URL = workerUrl;
process.env.APP_URL ??= 'https://app.example.test';
process.env.ENCRYPTION_KEY ??= 'a'.repeat(64);
const ORIGIN = new URL(process.env.APP_URL).origin;

const account = randomUUID(), other = randomUUID(), owner = randomUUID(), contact = randomUUID(), otherContact = randomUUID();
const product = randomUUID(), variant = randomUUID(), hidden = randomUUID(), foreignVariant = randomUUID(), otherProduct = randomUUID();
let db: pg.Client;
let token = '';
let otherToken = '';

const params = (t: string) => ({ params: Promise.resolve({ token: t }) });
const req = (method: string, body?: unknown, origin: string | null = ORIGIN) => new Request(`${ORIGIN}/api/public/shop/x`, {
  method, headers: { 'content-type': 'application/json', ...(origin ? { origin } : {}), 'x-forwarded-for': '203.0.113.9' },
  body: body === undefined ? undefined : JSON.stringify(body),
});

describe.skipIf(!ownerUrl || !appUrl || !workerUrl)('public storefront routes on PostgreSQL', { timeout: 120_000 }, () => {
  beforeAll(async () => {
    db = new pg.Client({ connectionString: ownerUrl });
    await db.connect();
    if (!/test/i.test((await db.query('SELECT current_database() AS name')).rows[0].name)) throw new Error('Requires an isolated test database');
    await db.query("INSERT INTO auth_users(id,email,full_name,password_hash) VALUES($1::uuid,$2,'P8 shop','test-only-hash')", [owner, `${owner}@example.invalid`]);
    await db.query("INSERT INTO accounts(id,name,owner_user_id) VALUES($1,'P8 shop',$3),($2,'P8 other',$3)", [account, other, owner]);
    await db.query("INSERT INTO account_subscriptions(account_id,plan_id) VALUES($1,'basic'),($2,'basic')", [account, other]);
    await db.query("INSERT INTO account_memberships(account_id,user_id,role) VALUES($1,$3,'owner'),($2,$3,'owner')", [account, other, owner]);
    await db.query("INSERT INTO contacts(id,account_id,user_id,name,phone) VALUES($1,$2,$3,'Buyer','14155559001'),($4,$5,$3,'Other','14155559002')",
      [contact, account, owner, otherContact, other]);
    await db.query(`INSERT INTO commerce_settings(account_id,currency,default_tax_rate_bps,checkout_enabled) VALUES($1,'INR',1800,true),($2,'INR',1800,true)`, [account, other]);
    await db.query(`INSERT INTO shipping_rates(account_id,name,country,fee_minor) VALUES($1,'India','IN',4000)`, [account]);
    await db.query(`INSERT INTO shop_products(id,account_id,name,status,content_reviewed_at) VALUES($1,$2,'Brahmi','published',now())`, [product, account]);
    await db.query(`INSERT INTO shop_products(id,account_id,name,status,content_reviewed_at) VALUES($1,$2,'Foreign','published',now())`, [otherProduct, other]);
    await db.query(`INSERT INTO shop_variants(id,account_id,product_id,sku,price_minor) VALUES($1,$3,$4,'BRA-1',15000),($2,$3,$4,'BRA-OLD',100)`,
      [variant, hidden, account, product]);
    await db.query(`UPDATE shop_variants SET archived_at=now() WHERE id=$1`, [hidden]);
    await db.query(`INSERT INTO shop_variants(id,account_id,product_id,sku,price_minor) VALUES($1,$2,$3,'FOR-1',100)`, [foreignVariant, other, otherProduct]);
    await db.query(`INSERT INTO inventory_levels(account_id,variant_id,on_hand) VALUES($1,$2,3)`, [account, variant]);
    const issue = (acct: string, contactId: string) => withTenant({ accountId: acct, role: 'owner' }, (tx) => issueSessionTx(tx, acct, {
      sessionId: randomUUID(), contactId, conversationId: null, whatsappConfigId: null, purpose: 'shop', orderId: null, ttlHours: 24, createdBy: null,
    }), getWorkerPrisma());
    token = (await issue(account, contact)).url.split('/shop/')[1];
    otherToken = (await issue(other, otherContact)).url.split('/shop/')[1];
  });

  afterAll(async () => {
    if (db) {
      await db.query('DELETE FROM jobs WHERE tenant_id=ANY($1::uuid[])', [[account, other]]);
      await db.query('DELETE FROM accounts WHERE id=ANY($1::uuid[])', [[account, other]]);
      await db.query('DELETE FROM auth_users WHERE id=$1', [owner]);
      await db.end();
    }
    await disconnectDatabases();
  });

  it('serves only published, priced, unarchived products of the token’s own workspace', async () => {
    const res = await view(req('GET'), params(token));
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const body = await res.json();
    expect(body.products.map((p: { id: string }) => p.id)).toEqual([product]);
    expect(body.products[0].variants.map((v: { id: string }) => v.id)).toEqual([variant]);
    expect(JSON.stringify(body)).not.toContain('14155559001');
    expect((await view(req('GET'), params('A'.repeat(43)))).status).toBe(404);
    expect((await view(req('GET'), params('not-a-token'))).status).toBe(404);
  });

  it('checks Origin and version, and refuses another workspace’s or archived variants', async () => {
    expect((await putCart(req('PUT', { expectedVersion: 1, lines: [] }, 'https://evil.example'), params(token))).status).toBe(403);
    expect((await putCart(req('PUT', { expectedVersion: 1, lines: [{ variantId: foreignVariant, qty: 1 }] }), params(token))).status).toBe(400);
    expect((await putCart(req('PUT', { expectedVersion: 1, lines: [{ variantId: hidden, qty: 1 }] }), params(token))).status).toBe(400);
    expect((await putCart(req('PUT', { expectedVersion: 9, lines: [{ variantId: variant, qty: 1 }] }), params(token))).status).toBe(409);
    const ok = await putCart(req('PUT', { expectedVersion: 1, lines: [{ variantId: variant, qty: 2 }] }), params(token));
    expect(ok.status).toBe(200);
    const body = await ok.json();
    expect(body).toMatchObject({ version: 2, cart: [{ variantId: variant, qty: 2 }] });
    // The other workspace's session is untouched and sees none of this.
    const theirs = await (await view(req('GET'), params(otherToken))).json();
    expect(theirs.cart).toEqual([]);
  });

  it('places once from the quoted total, and the success page never trusts razorpay parameters', async () => {
    const withAddress = await (await putAddress(req('PUT', { expectedVersion: 2, address: {
      name: 'Buyer', phone: '+91 98765 43210', line1: '2 Residency Rd', city: 'Bengaluru', postal_code: '560025', country: 'IN',
    } }), params(token))).json();
    expect(withAddress.quote).toMatchObject({ ok: true, quote: { subtotalMinor: 30000, shippingMinor: 4000, totalMinor: 34000 } });
    const bad = await place(req('POST', { expectedVersion: 3, expectedTotalMinor: 1, clientRequestId: randomUUID() }), params(token));
    expect(bad.status).toBe(409);
    expect(await bad.json()).toMatchObject({ code: 'quote_changed', quote: { totalMinor: 34000 } });
    const placed = await place(req('POST', { expectedVersion: 3, expectedTotalMinor: 34000, clientRequestId: randomUUID() }), params(token));
    expect(placed.status).toBe(201);
    const placedBody = await placed.json();
    expect(placedBody.view.order).toMatchObject({ status: 'awaiting_payment', totalMinor: 34000, paymentPending: true, paymentUrl: null });
    const replay = await place(req('POST', { expectedVersion: 3, expectedTotalMinor: 34000, clientRequestId: randomUUID() }), params(token));
    expect(replay.status).toBe(200);

    const before = (await db.query('SELECT status, amount_paid_minor, updated_at FROM orders WHERE storefront_session_id IS NOT NULL AND account_id=$1', [account])).rows;
    const done = new Request(`${ORIGIN}/api/public/shop/${token}/status?razorpay_payment_id=pay_x&razorpay_payment_link_status=paid&razorpay_signature=x`);
    const res = await status(done, params(token));
    expect((await res.json()).order).toMatchObject({ status: 'awaiting_payment', amountPaidMinor: 0 });
    const after = (await db.query('SELECT status, amount_paid_minor, updated_at FROM orders WHERE storefront_session_id IS NOT NULL AND account_id=$1', [account])).rows;
    expect(after).toEqual(before);
  });
});
