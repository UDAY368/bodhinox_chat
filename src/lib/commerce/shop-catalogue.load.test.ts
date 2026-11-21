import { randomUUID } from 'node:crypto';
import { config } from 'dotenv';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// Store Batch 6 (speed): a category page of a 600-product shop on PostgreSQL. Counts the round trips one page load makes (the gate,
// the tenant transaction's BEGIN/set_config/COMMIT included) and checks the page is right (24 cards in price order, the full total),
// so a change that brings back the in-memory scan (every product of the category read for one page) shows here. Runs with the other
// real-database tests (one worker).
import { disconnectDatabases } from '@/lib/db/prisma';
import { loadShopCategory } from './public-shop';

const configured = config({ path: '.env.test', quiet: true }).parsed;
const ownerUrl = process.env.TEST_DATABASE_URL;
const appUrl = process.env.TEST_APP_DATABASE_URL || configured?.DATABASE_URL;
const workerUrl = process.env.TEST_WORKER_DATABASE_URL || configured?.WORKER_DATABASE_URL;
if (appUrl) process.env.DATABASE_URL = appUrl;
if (workerUrl) process.env.WORKER_DATABASE_URL = workerUrl;

const A = randomUUID(), owner = randomUUID(), category = randomUUID();
const handle = `b6l-${A.slice(0, 8)}`;
const PRODUCTS = 600;
let db: pg.Client;
const q = async (sql: string, values: unknown[] = []) => (await db.query(sql, values)).rows;

/** Round trips to PostgreSQL while `work` runs (every client query, BEGIN and COMMIT included) and the rows they returned. */
async function countStatements<T>(work: () => Promise<T>): Promise<{ result: T; statements: number; rows: number }> {
  const proto = pg.Client.prototype as unknown as { query: (...args: unknown[]) => unknown };
  const original = proto.query;
  let statements = 0, rows = 0;
  proto.query = function counted(this: unknown, ...args: unknown[]) {
    statements++;
    const out = original.apply(this, args);
    if (out instanceof Promise) out.then((r: { rowCount?: number | null }) => { rows += r?.rowCount ?? 0; }, () => undefined);
    return out;
  };
  try {
    return { result: await work(), statements, rows };
  } finally {
    proto.query = original;
  }
}

describe.skipIf(!ownerUrl || !appUrl || !workerUrl)('store batch 6: a category page of a large shop', { timeout: 120_000 }, () => {
  beforeAll(async () => {
    db = new pg.Client({ connectionString: ownerUrl });
    await db.connect();
    if (!/test/i.test((await db.query('SELECT current_database() AS name')).rows[0].name)) throw new Error('Requires an isolated test database');
    await q("INSERT INTO auth_users(id,email,full_name,password_hash) VALUES($1::uuid, $2, 'B6L', 'test-only-hash')", [owner, `${owner}@example.invalid`]);
    await q("INSERT INTO accounts(id,name,owner_user_id) VALUES($1,'B6L shop',$2)", [A, owner]);
    await q("INSERT INTO account_subscriptions(account_id,plan_id) VALUES($1,'basic')", [A]);
    await q("INSERT INTO account_memberships(account_id,user_id,role) VALUES($1,$2,'owner')", [A, owner]);
    await q("INSERT INTO commerce_settings(account_id,currency,default_tax_rate_bps,checkout_enabled) VALUES($1,'INR',500,true)", [A]);
    await q("INSERT INTO shop_storefronts(account_id,handle,published,template) VALUES($1,$2,true,'wellness')", [A, handle]);
    await q("UPDATE shop_storefronts SET access_mode='open' WHERE account_id=$1", [A]);
    await q("INSERT INTO shop_categories(id,account_id,name,slug,position) VALUES($1,$2,'Oils','oils',1)", [category, A]);
    await q(`INSERT INTO shop_products(account_id,name,status,content_reviewed_at,category_id,slug)
      SELECT $1, 'Oil ' || lpad(n::text, 4, '0'), 'published', now(), $2, 'oil-' || n FROM generate_series(1, ${PRODUCTS}) n`, [A, category]);
    await q(`INSERT INTO shop_variants(account_id,product_id,sku,price_minor,track_inventory,option_values,position)
      SELECT p.account_id, p.id, 'L6-' || p.slug || '-' || s, 10000 + (hashtext(p.slug) & 65535) * 10 + s, false,
        jsonb_build_object('Size', CASE s WHEN 1 THEN '100 ml' ELSE '250 ml' END), s
      FROM shop_products p CROSS JOIN generate_series(1, 2) s WHERE p.account_id=$1`, [A]);
    await q(`INSERT INTO shop_product_images(account_id,product_id,url,position)
      SELECT account_id, id, 'https://cdn.example.test/' || slug || '.jpg', 0 FROM shop_products WHERE account_id=$1`, [A]);
    // Planner statistics, as a live database has them.
    await q('ANALYZE shop_products, shop_variants, shop_categories, shop_product_images');
  });

  afterAll(async () => {
    if (db) {
      await db.query('DELETE FROM accounts WHERE id=$1', [A]);
      await db.query('DELETE FROM auth_users WHERE id=$1', [owner]);
      await db.end();
    }
    await disconnectDatabases();
  });

  it('reads one page of 24 for a 600-product category: bounded statements and rows, the full total', async () => {
    await loadShopCategory(handle, 'oils', { sort: 'price_asc' }); // warm the pool
    const started = performance.now();
    const { result, statements, rows } = await countStatements(() => loadShopCategory(handle, 'oils', { sort: 'price_asc', option: 'Size:250 ml' }));
    const ms = Math.round(performance.now() - started);
    process.stdout.write(`[b6-load] category page: ${statements} statements, ${rows} rows, ${ms} ms, ${result?.products.length} cards of ${result?.total}
`);
    expect(result?.products).toHaveLength(24);
    expect(result?.total).toBe(PRODUCTS);
    const prices = result!.products.map((p) => Math.min(...p.variants.map((v) => v.priceMinor)));
    expect(prices).toEqual([...prices].sort((a, b) => a - b));
    // The page reads its 24 cards (and their 48 variants and 24 images), never the whole category.
    expect(rows).toBeLessThan(200);
    expect(statements).toBeLessThanOrEqual(26);
  });
});
