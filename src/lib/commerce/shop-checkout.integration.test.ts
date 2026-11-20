import { randomUUID } from 'node:crypto';
import { config } from 'dotenv';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { disconnectDatabases, getWorkerPrisma } from '@/lib/db/prisma';
import { withTenant } from '@/lib/db/tenant';
import { checkoutTokenBelongsToShop, loadShopHome } from '@/lib/commerce/public-shop';
import { issueSessionTx, seededUuid } from '@/lib/commerce/storefront';
import { POST as previewCart } from '@/app/api/public/store/[handle]/cart/route';
import ShopCheckoutPage from '@/app/s/[handle]/checkout/[token]/page';

// Store batch 6 on PostgreSQL: the themed checkout opens only a token of the shop that owns the handle (another
// shop's token is the plain 404), the cart page's estimate writes nothing and never redeems a coupon, and public
// variants carry the stock left.
const configured = config({ path: '.env.test', quiet: true }).parsed;
const ownerUrl = process.env.TEST_DATABASE_URL;
const appUrl = process.env.TEST_APP_DATABASE_URL || configured?.DATABASE_URL;
const workerUrl = process.env.TEST_WORKER_DATABASE_URL || configured?.WORKER_DATABASE_URL;
const authUrl = process.env.TEST_AUTH_DATABASE_URL || configured?.AUTH_DATABASE_URL;
if (appUrl) process.env.DATABASE_URL = appUrl;
if (workerUrl) process.env.WORKER_DATABASE_URL = workerUrl;
if (authUrl) process.env.AUTH_DATABASE_URL = authUrl;
process.env.APP_URL ??= 'https://app.example.test';
process.env.ENCRYPTION_KEY ??= 'a'.repeat(64);
const ORIGIN = new URL(process.env.APP_URL).origin;

const A = randomUUID(), B = randomUUID(), owner = randomUUID();
const productA = randomUUID(), tracked = randomUUID(), soldOut = randomUUID(), loose = randomUUID(), productB = randomUUID(), variantB = randomUUID();
const buyerA = randomUUID(), buyerB = randomUUID();
const handleA = `b6a-${A.slice(0, 8)}`, handleB = `b6b-${B.slice(0, 8)}`;
let db: pg.Client;
let tokenA = '', tokenB = '';
let ip = 0;

const req = (body: unknown) => new Request(`${ORIGIN}/api/public/store/x/cart`, {
  method: 'POST', body: JSON.stringify(body),
  headers: { 'content-type': 'application/json', origin: ORIGIN, 'x-forwarded-for': `198.51.100.${(ip++ % 200) + 1}` },
});
const at = (handle: string) => ({ params: Promise.resolve({ handle }) });
const page = (handle: string, token: string) => ShopCheckoutPage({ params: Promise.resolve({ handle, token }) });
const issue = (account: string, contact: string) => withTenant({ accountId: account, role: 'owner' }, (tx) => issueSessionTx(tx, account, {
  sessionId: seededUuid(`b6-checkout:${account}:${contact}`), contactId: contact, conversationId: null, whatsappConfigId: null,
  purpose: 'shop', orderId: null, ttlHours: 24, createdBy: null,
}), getWorkerPrisma());

describe.skipIf(!ownerUrl || !appUrl || !workerUrl)('themed checkout and cart estimate on PostgreSQL', { timeout: 120_000 }, () => {
  beforeAll(async () => {
    db = new pg.Client({ connectionString: ownerUrl });
    await db.connect();
    if (!/test/i.test((await db.query('SELECT current_database() AS name')).rows[0].name)) throw new Error('Requires an isolated test database');
    const q = (sql: string, values: unknown[]) => db.query(sql, values);
    await q("INSERT INTO auth_users(id,email,full_name,password_hash) VALUES($1::uuid,$2,'B6 shop','test-only-hash')", [owner, `${owner}@example.invalid`]);
    await q("INSERT INTO accounts(id,name,owner_user_id) VALUES($1,'B6 A',$3),($2,'B6 B',$3)", [A, B, owner]);
    await q("INSERT INTO account_subscriptions(account_id,plan_id) VALUES($1,'basic'),($2,'basic')", [A, B]);
    await q("INSERT INTO account_memberships(account_id,user_id,role) VALUES($1,$3,'owner'),($2,$3,'owner')", [A, B, owner]);
    await q("INSERT INTO commerce_settings(account_id,currency,prices_include_tax,default_tax_rate_bps,checkout_enabled) VALUES($1,'INR',true,1800,true),($2,'INR',true,1800,true)", [A, B]);
    await q(`INSERT INTO shipping_rates(account_id,name,country,fee_minor,postal_prefixes) VALUES($1,'Bengaluru','IN',4000,'{560}')`, [A]);
    await q(`INSERT INTO coupons(account_id,code,kind,value,per_contact_limit) VALUES($1,'SAVE10','percent',1000,1),($2,'BONLY','fixed',100,NULL)`, [A, B]);
    await q("INSERT INTO shop_products(id,account_id,name,status,content_reviewed_at) VALUES($1,$3,'Kurta','published',now()),($2,$4,'Foreign','published',now())",
      [productA, productB, A, B]);
    await q(`INSERT INTO shop_variants(id,account_id,product_id,sku,price_minor,track_inventory,option_values) VALUES
      ($1,$4,$5,'K-S',100000,true,'{"Size":"S"}'),($2,$4,$5,'K-M',100000,true,'{"Size":"M"}'),($3,$4,$5,'K-L',100000,false,'{"Size":"L"}')`,
    [tracked, soldOut, loose, A, productA]);
    await q("INSERT INTO shop_variants(id,account_id,product_id,sku,price_minor,track_inventory) VALUES($1,$2,$3,'F-1',500,false)", [variantB, B, productB]);
    await q('INSERT INTO inventory_levels(account_id,variant_id,on_hand) VALUES($1,$2,3)', [A, tracked]);
    await q("INSERT INTO contacts(id,account_id,user_id,name,phone) VALUES($1,$2,$3,'Buyer A','919800000101')", [buyerA, A, owner]);
    await q("INSERT INTO contacts(id,account_id,user_id,name,phone) VALUES($1,$2,$3,'Buyer B','919800000102')", [buyerB, B, owner]);
    await q("INSERT INTO shop_storefronts(account_id,handle,published,template) VALUES($1,$2,true,'fashion'),($3,$4,true,'fashion')", [A, handleA, B, handleB]);
    tokenA = (await issue(A, buyerA)).token;
    tokenB = (await issue(B, buyerB)).token;
  });

  afterAll(async () => {
    if (db) {
      await db.query('DELETE FROM jobs WHERE tenant_id=ANY($1::uuid[])', [[A, B]]);
      await db.query('DELETE FROM accounts WHERE id=ANY($1::uuid[])', [[A, B]]);
      await db.query('DELETE FROM auth_users WHERE id=$1', [owner]);
      await db.end();
    }
    await disconnectDatabases();
  });

  it("opens a checkout token only under its own shop's handle", async () => {
    expect(await checkoutTokenBelongsToShop(handleA, tokenA)).toBe(true);
    expect(await checkoutTokenBelongsToShop(handleB, tokenB)).toBe(true);
    // Shop B's token under shop A's handle (and the other way round) is not found.
    expect(await checkoutTokenBelongsToShop(handleA, tokenB)).toBe(false);
    expect(await checkoutTokenBelongsToShop(handleB, tokenA)).toBe(false);
    expect(await checkoutTokenBelongsToShop(handleA, 'x'.repeat(43))).toBe(false);
    expect(await checkoutTokenBelongsToShop(handleA, '../etc')).toBe(false);
    expect(await checkoutTokenBelongsToShop('no-such-shop-b6', tokenA)).toBe(false);
    await expect(page(handleA, tokenB)).rejects.toThrow();
    await expect(page(handleA, tokenA)).resolves.toBeTruthy();
    // A revoked session is gone too.
    await db.query('UPDATE storefront_sessions SET revoked_at=now() WHERE account_id=$1', [B]);
    expect(await checkoutTokenBelongsToShop(handleB, tokenB)).toBe(false);
  });

  it('estimates the cart with a pincode and coupon without writing anything or redeeming the coupon', async () => {
    const count = async () => (await db.query(`SELECT (SELECT count(*) FROM storefront_sessions WHERE account_id=$1)::int AS sessions,
      (SELECT count(*) FROM contacts WHERE account_id=$1)::int AS contacts, (SELECT count(*) FROM coupon_redemptions WHERE account_id=$1)::int AS redemptions,
      (SELECT reserved FROM inventory_levels WHERE account_id=$1 AND variant_id=$2) AS reserved`, [A, tracked])).rows[0];
    const before = await count();
    const res = await previewCart(req({ lines: [{ variantId: loose, qty: 2 }], pincode: '560001', coupon: 'save10' }), at(handleA));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.estimate).toMatchObject({ currency: 'INR', subtotalMinor: 200000, couponCode: 'SAVE10', couponMinor: 20000, couponError: null,
      shipping: 'priced', shippingMinor: 4000, pincode: '560001' });
    expect(body.estimate.totalMinor).toBe(200000 - 20000 + 4000);
    expect(await count()).toEqual(before);

    // A pincode no rate reaches, and another shop's coupon, are reported; the cart is still totalled.
    const far = await (await previewCart(req({ lines: [{ variantId: loose, qty: 1 }], pincode: '110001', coupon: 'BONLY' }), at(handleA))).json();
    expect(far.estimate).toMatchObject({ shipping: 'unavailable', couponCode: null, couponError: 'coupon_not_found', totalMinor: 100000 });
    // Without a pincode, shipping waits for it.
    const plain = await (await previewCart(req({ lines: [{ variantId: loose, qty: 1 }] }), at(handleA))).json();
    expect(plain.estimate).toMatchObject({ shipping: 'needs_pincode', shippingMinor: 0, couponError: null });
    // Another shop's variant never prices here.
    const foreign = await (await previewCart(req({ lines: [{ variantId: variantB, qty: 1 }] }), at(handleA))).json();
    expect(foreign.removed).toEqual([variantB]);
    expect(foreign.estimate).toBeNull();
  });

  it('gives public variants the stock left (null when not tracked)', async () => {
    const home = await loadShopHome(handleA);
    const variants = home?.products.find((p) => p.id === productA)?.variants ?? [];
    expect(Object.fromEntries(variants.map((v) => [v.id, [v.inStock, v.available]]))).toEqual({
      [tracked]: [true, 3], [soldOut]: [false, 0], [loose]: [true, null],
    });
  });
});
