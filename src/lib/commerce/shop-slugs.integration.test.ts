import { randomUUID } from 'node:crypto';
import { config } from 'dotenv';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

// Store Batch 6 on PostgreSQL: readable product and category slugs (made from the name, numbered per workspace, kept when the seller
// chose one, moved on a rename with a 301 rule from the old path), the search listing fields, slug and id lookups that never cross
// shops, and the per-shop sitemap (only the shop's own live products; none for a hidden shop).
import { GET as sitemapRoute } from '@/app/s/[handle]/sitemap.xml/route';
import { disconnectDatabases } from '@/lib/db/prisma';
import { withTenant, type TenantContext } from '@/lib/db/tenant';
import { CatalogueError, createCategory, duplicateProduct, updateCategory, upsertProduct } from './catalogue/products';
import { loadShopCategory, loadShopProduct } from './public-shop';
import { resolveShopRedirect } from './shop-redirects';
import { loadShopSitemap } from './shop-sitemap';

const configured = config({ path: '.env.test', quiet: true }).parsed;
const ownerUrl = process.env.TEST_DATABASE_URL;
const appUrl = process.env.TEST_APP_DATABASE_URL || configured?.DATABASE_URL;
const workerUrl = process.env.TEST_WORKER_DATABASE_URL || configured?.WORKER_DATABASE_URL;
if (appUrl) process.env.DATABASE_URL = appUrl;
if (workerUrl) process.env.WORKER_DATABASE_URL = workerUrl;
process.env.APP_URL ??= 'https://app.example.test';
const ORIGIN = new URL(process.env.APP_URL).origin;

type Staff = TenantContext & { userId: string };
const A = randomUUID(), B = randomUUID();
const owner = randomUUID(), admin = randomUUID();
const asAdmin: Staff = { accountId: A, userId: admin, role: 'admin' };
const bAdmin: Staff = { accountId: B, userId: owner, role: 'admin' };
const handleA = `b6s-${A.slice(0, 8)}`, handleB = `b6s-${B.slice(0, 8)}`;
let db: pg.Client;
let ip = 0;

const q = async <T,>(sql: string, values: unknown[] = []): Promise<T[]> => (await db.query(sql, values)).rows as T[];
const create = (who: Staff, body: Record<string, unknown>) => withTenant(who, (tx) => upsertProduct(tx, who.accountId, who.userId, null, body));
const update = (who: Staff, id: string, body: Record<string, unknown>) => withTenant(who, (tx) => upsertProduct(tx, who.accountId, who.userId, id, body));
/** Published with one priced variant (written as the owner, as a seeded catalogue would be). */
async function makeLive(account: string, productId: string, sku: string) {
  await q("UPDATE shop_products SET status='published', content_reviewed_at=now() WHERE id=$1", [productId]);
  await q('INSERT INTO shop_variants(account_id,product_id,sku,price_minor,track_inventory) VALUES($1,$2,$3,25000,false)', [account, productId, sku]);
}
const sitemap = (handle: string) => sitemapRoute(
  new Request(`${ORIGIN}/s/${handle}/sitemap.xml`, { headers: { 'x-forwarded-for': `198.51.100.${(ip++ % 250) + 1}` } }), { params: Promise.resolve({ handle }) });

describe.skipIf(!ownerUrl || !appUrl || !workerUrl)('store batch 6: shop slugs and SEO on PostgreSQL', { timeout: 120_000 }, () => {
  beforeAll(async () => {
    db = new pg.Client({ connectionString: ownerUrl });
    await db.connect();
    if (!/test/i.test((await db.query('SELECT current_database() AS name')).rows[0].name)) throw new Error('Requires an isolated test database');
    await q("INSERT INTO auth_users(id,email,full_name,password_hash) SELECT x, x::text || '@example.invalid', 'B6S', 'test-only-hash' FROM unnest($1::uuid[]) x", [[owner, admin]]);
    await q("INSERT INTO accounts(id,name,owner_user_id) VALUES($1,'B6S shop',$3),($2,'B6S other',$3)", [A, B, owner]);
    await q("INSERT INTO account_subscriptions(account_id,plan_id) VALUES($1,'basic'),($2,'basic')", [A, B]);
    await q("INSERT INTO account_memberships(account_id,user_id,role) VALUES($1,$2,'owner'),($1,$3,'admin'),($4,$2,'owner')", [A, owner, admin, B]);
    await q("INSERT INTO commerce_settings(account_id,currency,default_tax_rate_bps,checkout_enabled) VALUES($1,'INR',500,true),($2,'INR',500,true)", [A, B]);
    await q("INSERT INTO shop_storefronts(account_id,handle,published,template) VALUES($1,$2,true,'wellness'),($3,$4,true,'wellness')", [A, handleA, B, handleB]);
  });

  beforeEach(async () => {
    await q("UPDATE shop_storefronts SET access_mode='open' WHERE account_id = ANY($1::uuid[])", [[A, B]]);
  });

  afterAll(async () => {
    if (db) {
      await db.query('DELETE FROM accounts WHERE id = ANY($1::uuid[])', [[A, B]]);
      await db.query('DELETE FROM auth_users WHERE id = ANY($1::uuid[])', [[owner, admin]]);
      await db.end();
    }
    await disconnectDatabases();
  });

  it('makes a slug from the name, numbers repeats per workspace and falls back to an id fragment for a non-latin name', async () => {
    const first = await create(asAdmin, { name: 'Café Neem Oil' });
    const second = await create(asAdmin, { name: 'Cafe Neem Oil' });
    const other = await create(bAdmin, { name: 'Café Neem Oil' });
    const hindi = await create(asAdmin, { name: 'नीम तेल' });
    expect(first.slug).toBe('cafe-neem-oil');
    expect(second.slug).toBe('cafe-neem-oil-2');
    expect(other.slug).toBe('cafe-neem-oil'); // unique per workspace, not across them
    expect(hindi.slug).toMatch(/^[0-9a-f]{8}$/);
    const copy = await withTenant(asAdmin, (tx) => duplicateProduct(tx, A, admin, first.id));
    expect(copy.slug).toBe('cafe-neem-oil-copy');
  });

  it('follows a rename with a 301 from the old path, keeps a slug the seller chose, and refuses a taken one', async () => {
    const p = await create(asAdmin, { name: 'Rose Water' });
    expect(p.slug).toBe('rose-water');
    const renamed = await update(asAdmin, p.id, { name: 'Rose Water Toner', version: p.version });
    expect(renamed.slug).toBe('rose-water-toner');
    expect(await q('SELECT from_path, to_path, status_code FROM shop_redirects WHERE account_id=$1 AND from_path=$2', [A, '/p/rose-water']))
      .toEqual([{ from_path: '/p/rose-water', to_path: '/p/rose-water-toner', status_code: 301 }]);
    expect(await resolveShopRedirect(handleA, '/p/rose-water')).toEqual({ location: `/s/${handleA}/p/rose-water-toner`, permanent: true });

    // The seller's own address: a second move re-points the first rule (no chain), and a later rename keeps it.
    const chosen = await update(asAdmin, p.id, { slug: 'Toner', version: renamed.version });
    expect(chosen.slug).toBe('toner');
    expect((await q<{ to_path: string }>('SELECT to_path FROM shop_redirects WHERE account_id=$1 AND from_path=$2', [A, '/p/rose-water']))[0].to_path).toBe('/p/toner');
    const kept = await update(asAdmin, p.id, { name: 'Rose Toner', version: chosen.version });
    expect(kept.slug).toBe('toner');

    const other = await create(asAdmin, { name: 'Other' });
    await expect(update(asAdmin, other.id, { slug: 'toner', version: other.version })).rejects.toMatchObject({ code: 'slug_taken' });
    for (const bad of ['Has Space', '-lead', 'a--b', '0f0e5b4e-6d33-4c2c-9b8a-8a1c5c1d2e3f', 'x'.repeat(61)]) {
      await expect(update(asAdmin, other.id, { slug: bad, version: other.version })).rejects.toBeInstanceOf(CatalogueError);
    }
    // No redirect rule ever leaves the workspace.
    expect(await q('SELECT 1 FROM shop_redirects WHERE account_id=$1', [B])).toEqual([]);
  });

  it('checks the search listing lengths and that the share image is one of the product\'s own images', async () => {
    const p = await create(asAdmin, { name: 'Listing', images: [{ url: 'https://cdn.example.test/a.jpg' }, { url: 'https://cdn.example.test/b.jpg' }] });
    const q2 = await create(asAdmin, { name: 'Elsewhere', images: [{ url: 'https://cdn.example.test/c.jpg' }] });
    await expect(update(asAdmin, p.id, { seo_title: 't'.repeat(71) })).rejects.toMatchObject({ code: 'invalid', field: 'seo_title' });
    await expect(update(asAdmin, p.id, { seo_description: 'd'.repeat(161) })).rejects.toMatchObject({ code: 'invalid', field: 'seo_description' });
    await expect(update(asAdmin, p.id, { seo_image_id: q2.images[0].id })).rejects.toMatchObject({ code: 'invalid', field: 'seo_image_id' });
    const saved = await update(asAdmin, p.id, { seo_title: 'Best listing', seo_description: 'Short words.', seo_image_id: p.images[1].id });
    expect(saved).toMatchObject({ seo_title: 'Best listing', seo_description: 'Short words.', seo_image_id: p.images[1].id });
    // Replacing the images keeps the share image on the same picture (new row id).
    const reordered = await update(asAdmin, p.id, { images: [{ url: 'https://cdn.example.test/b.jpg' }, { url: 'https://cdn.example.test/a.jpg' }] });
    expect(reordered.seo_image_id).toBe(reordered.images[0].id);
  });

  it('finds a product and a category by slug or by id only under its own shop', async () => {
    const cat = await withTenant(asAdmin, (tx) => createCategory(tx, A, admin, { name: 'Hair Care' }));
    expect(cat.slug).toBe('hair-care');
    const p = await create(asAdmin, { name: 'Amla Shampoo', category_id: cat.id });
    await makeLive(A, p.id, `AMLA-${A.slice(0, 4)}`);

    const bySlug = await loadShopProduct(handleA, 'amla-shampoo');
    expect(bySlug?.product).toMatchObject({ id: p.id, slug: 'amla-shampoo', categorySlug: 'hair-care' });
    expect((await loadShopProduct(handleA, p.id))?.product.slug).toBe('amla-shampoo'); // the page answers this with a 308
    expect(await loadShopProduct(handleB, 'amla-shampoo')).toBeNull();
    expect(await loadShopProduct(handleB, p.id)).toBeNull();

    expect((await loadShopCategory(handleA, 'hair-care'))?.category).toMatchObject({ id: cat.id, slug: 'hair-care' });
    expect((await loadShopCategory(handleA, cat.id))?.category.slug).toBe('hair-care');
    expect(await loadShopCategory(handleB, 'hair-care')).toBeNull();
    expect(await loadShopCategory(handleB, cat.id)).toBeNull();

    // A renamed category moves too, with its own rule.
    const moved = await withTenant(asAdmin, (tx) => updateCategory(tx, A, admin, cat.id, { name: 'Hair' }));
    expect(moved.slug).toBe('hair');
    expect(await resolveShopRedirect(handleA, '/c/hair-care')).toEqual({ location: `/s/${handleA}/c/hair`, permanent: true });
  });

  it('lists only the shop\'s own live products in its sitemap, and none for a hidden shop', async () => {
    const live = await create(asAdmin, { name: 'Sitemap Live' });
    await makeLive(A, live.id, `SML-${A.slice(0, 4)}`);
    const draft = await create(asAdmin, { name: 'Sitemap Draft' });
    const foreign = await create(bAdmin, { name: 'Sitemap Foreign' });
    await makeLive(B, foreign.id, `SMF-${B.slice(0, 4)}`);

    const entries = (await loadShopSitemap(handleA))!.map((e) => e.path);
    expect(entries).toContain(`/s/${handleA}`);
    expect(entries).toContain(`/s/${handleA}/p/sitemap-live`);
    expect(entries).not.toContain(`/s/${handleA}/p/${draft.slug}`);
    expect(entries.every((path) => path.startsWith(`/s/${handleA}`))).toBe(true);
    expect(entries.some((path) => path.includes('sitemap-foreign'))).toBe(false);

    const res = await sitemap(handleA);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/xml');
    const xml = await res.text();
    expect(xml).toContain(`<loc>${ORIGIN}/s/${handleA}/p/sitemap-live</loc>`);
    expect(xml).not.toContain('sitemap-foreign');

    await q("UPDATE shop_storefronts SET access_mode='coming_soon' WHERE account_id=$1", [A]);
    expect(await loadShopSitemap(handleA)).toBeNull();
    expect((await sitemap(handleA)).status).toBe(404);
    expect((await sitemap('no-such-shop-xyz')).status).toBe(404);
  });
});
