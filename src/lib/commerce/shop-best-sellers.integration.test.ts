import { randomUUID } from 'node:crypto';
import { config } from 'dotenv';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { disconnectDatabases } from '@/lib/db/prisma';
import { inShopTenant, loadShopHome } from '@/lib/commerce/public-shop';
import { loadBestSellerIds } from '@/lib/commerce/shop-best-sellers';
import { loadShopProductCards } from '@/lib/commerce/shop-recently-viewed';
import { GET as productsRoute } from '@/app/api/public/store/[handle]/products/route';

// Batch 6 home sections on PostgreSQL. "Best sellers" ranks this workspace's
// published products by real sales only (paid or later, or confirmed cash on
// delivery; inside the day window) and never sees another workspace's orders.
// The "recently viewed" ids route answers only the asked shop's own published
// products, whatever ids the browser sends.
const configured = config({ path: '.env.test', quiet: true }).parsed;
const ownerUrl = process.env.TEST_DATABASE_URL;
const appUrl = process.env.TEST_APP_DATABASE_URL || configured?.DATABASE_URL;
const workerUrl = process.env.TEST_WORKER_DATABASE_URL || configured?.WORKER_DATABASE_URL;
if (appUrl) process.env.DATABASE_URL = appUrl;
if (workerUrl) process.env.WORKER_DATABASE_URL = workerUrl;
process.env.APP_URL ??= 'https://app.example.test';

const account = randomUUID(), other = randomUUID(), owner = randomUUID();
const keys = ['a', 'b', 'c', 'd', 'draft', 'foreign'] as const;
const ids = Object.fromEntries(keys.map((k) => [k, randomUUID()])) as Record<(typeof keys)[number], string>;
const variants = Object.fromEntries(keys.map((k) => [k, randomUUID()])) as Record<(typeof keys)[number], string>;
const handle = `b6s-${account.slice(0, 8)}`, otherHandle = `b6s-${other.slice(0, 8)}`;
let db: pg.Client;
let ip = 0;

async function order(owner_: string, status: string, products: Array<(typeof keys)[number]>, opts: { cod?: boolean; ageDays?: number } = {}) {
  const id = randomUUID();
  await db.query(`INSERT INTO orders(id,account_id,source,currency,subtotal_minor,status,payment_method,created_at)
    VALUES($1,$2,'manual','INR',100,$3,$4, now() - ($5 || ' days')::interval)`, [id, owner_, status, opts.cod ? 'cod' : 'online', String(opts.ageDays ?? 1)]);
  for (const p of products) {
    await db.query("INSERT INTO order_items(account_id,order_id,name,quantity,unit_price_minor,currency,variant_id) VALUES($1,$2,'x',1,100,'INR',$3)", [owner_, id, variants[p]]);
  }
}

const get = (h: string, query: string) => productsRoute(
  new Request(`https://app.example.test/api/public/store/${h}/products?${query}`, { headers: { 'x-forwarded-for': `198.51.100.${(ip++ % 200) + 1}` } }),
  { params: Promise.resolve({ handle: h }) },
);

describe.skipIf(!ownerUrl || !appUrl || !workerUrl)('best sellers and recently viewed on PostgreSQL', { timeout: 120_000 }, () => {
  beforeAll(async () => {
    db = new pg.Client({ connectionString: ownerUrl });
    await db.connect();
    if (!/test/i.test((await db.query('SELECT current_database() AS name')).rows[0].name)) throw new Error('Requires an isolated test database');
    const q = (sql: string, values: unknown[]) => db.query(sql, values);
    await q("INSERT INTO auth_users(id,email,full_name,password_hash) VALUES($1::uuid,$2,'B6 owner','test-only-hash')", [owner, `${owner}@example.invalid`]);
    await q("INSERT INTO accounts(id,name,owner_user_id) VALUES($1,'B6 shop',$3),($2,'B6 other',$3)", [account, other, owner]);
    await q("INSERT INTO account_subscriptions(account_id,plan_id) VALUES($1,'basic'),($2,'basic')", [account, other]);
    await q("INSERT INTO account_memberships(account_id,user_id,role) VALUES($1,$3,'owner'),($2,$3,'owner')", [account, other, owner]);
    await q("INSERT INTO commerce_settings(account_id,currency,default_tax_rate_bps,checkout_enabled) VALUES($1,'INR',1800,true),($2,'INR',1800,true)", [account, other]);
    await q("INSERT INTO shop_storefronts(account_id,handle,published,template,document) VALUES($1,$2,true,'grocery',$5::jsonb),($3,$4,true,'fashion','{}')",
      [account, handle, other, otherHandle, JSON.stringify({ sections: [{ id: 'best01', type: 'best_sellers', settings: { days: 30, limit: 4 } }] })]);
    await q(`INSERT INTO shop_products(id,account_id,name,status,content_reviewed_at) VALUES
      ($1,$7,'Alpha','published',now()),($2,$7,'Beta','published',now()),($3,$7,'Gamma','published',now()),($4,$7,'Delta','published',now()),
      ($5,$7,'Draft one','draft',now()),($6,$8,'Foreign','published',now())`,
    [ids.a, ids.b, ids.c, ids.d, ids.draft, ids.foreign, account, other]);
    for (const k of keys) {
      await q('INSERT INTO shop_variants(id,account_id,product_id,sku,price_minor,track_inventory) VALUES($1,$2,$3,$4,25000,false)',
        [variants[k], k === 'foreign' ? other : account, ids[k], `B6S-${k}`]);
    }
    // This shop: b sells 3 times, a twice, c once; d only on cancelled, unconfirmed or too old orders; the draft sells most but is hidden.
    await order(account, 'paid', ['a', 'b']);
    await order(account, 'fulfilled', ['b']);
    await order(account, 'confirmed', ['a', 'b'], { cod: true });
    await order(account, 'dispatched', ['c']);
    await order(account, 'cancelled', ['d']);
    await order(account, 'cancelled', ['d']);
    await order(account, 'confirmed', ['d']); // confirmed but not COD: not a sale yet
    await order(account, 'paid', ['d'], { ageDays: 60 }); // outside a 30-day window
    for (let i = 0; i < 4; i++) await order(account, 'paid', ['draft']);
    // The other shop sells its own product many times.
    for (let i = 0; i < 5; i++) await order(other, 'paid', ['foreign']);
  });

  afterAll(async () => {
    if (db) {
      await db.query('DELETE FROM accounts WHERE id=ANY($1::uuid[])', [[account, other]]);
      await db.query('DELETE FROM auth_users WHERE id=$1', [owner]);
      await db.end();
    }
    await disconnectDatabases();
  });

  it('ranks by real sales in the window, ignoring cancelled, unconfirmed, old, unpublished and foreign orders', async () => {
    expect(await inShopTenant(account, (tx) => loadBestSellerIds(tx, account, 12, 30))).toEqual([ids.b, ids.a, ids.c]);
    expect(await inShopTenant(account, (tx) => loadBestSellerIds(tx, account, 2, 30))).toEqual([ids.b, ids.a]);
    // A longer window counts the older sale of d.
    expect(await inShopTenant(account, (tx) => loadBestSellerIds(tx, account, 12, 90))).toEqual([ids.b, ids.a, ids.c, ids.d]);
    // The other workspace sees only its own sales, never this shop's.
    expect(await inShopTenant(other, (tx) => loadBestSellerIds(tx, other, 12, 30))).toEqual([ids.foreign]);
  });

  it('hands the home page the ranked public products only when a best sellers section is visible', async () => {
    const home = await loadShopHome(handle);
    expect(home?.bestSellers.map((p) => p.id)).toEqual([ids.b, ids.a, ids.c]);
    expect(JSON.stringify(home?.bestSellers)).not.toMatch(/count|order_id/i);
    expect((await loadShopHome(otherHandle))?.bestSellers).toEqual([]);
  });

  it('answers recently viewed ids with this shop\'s published products only, in the order asked', async () => {
    const cards = await loadShopProductCards(handle, [ids.c, ids.foreign, ids.draft, ids.a]);
    expect(cards?.map((p) => p.id)).toEqual([ids.c, ids.a]);
    expect(cards?.[0].description).toBeNull();

    const res = await get(handle, `ids=${[ids.foreign, ids.b, randomUUID()].join(',')}`);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { products: Array<{ id: string }> }).products.map((p) => p.id)).toEqual([ids.b]);
    // The other shop's handle never returns this shop's products.
    const theirs = await get(otherHandle, `ids=${ids.a},${ids.foreign}`);
    expect(((await theirs.json()) as { products: Array<{ id: string }> }).products.map((p) => p.id)).toEqual([ids.foreign]);
  });

  it('refuses a missing or oversized list and an unknown shop', async () => {
    expect((await get(handle, '')).status).toBe(400);
    expect((await get(handle, `ids=${Array.from({ length: 13 }, () => randomUUID()).join(',')}`)).status).toBe(400);
    expect((await get('no-such-shop-b6', `ids=${ids.a}`)).status).toBe(404);
    expect((await get('Bad Handle', `ids=${ids.a}`)).status).toBe(404);
  });
});
