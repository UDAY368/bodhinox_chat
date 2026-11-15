import { randomUUID } from 'node:crypto';
import { config } from 'dotenv';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { disconnectDatabases, getPrisma } from '@/lib/db/prisma';
import { withTenant, type TenantContext } from '@/lib/db/tenant';
import { loadShopCollection, loadShopHome, loadShopProduct } from '@/lib/commerce/public-shop';
import { deleteCollection, getCollection, listCollections, previewCollection, upsertCollection } from './collections';
import {
  archiveProduct, CatalogueError, createCategory, duplicateProduct, getShopProduct, publishProduct, upsertProduct, upsertVariant,
} from './products';

// Store plan Phase 4 (package 1) on PostgreSQL: tags, brand, type and details on products; a variant's
// picture that can only be an image of its own product (composite foreign key); smart and manual
// collections, tenancy, roles, rule results and the public pages that read them.
const configured = config({ path: '.env.test', quiet: true }).parsed;
const ownerUrl = process.env.TEST_DATABASE_URL;
const appUrl = process.env.TEST_APP_DATABASE_URL || configured?.DATABASE_URL;
const workerUrl = process.env.TEST_WORKER_DATABASE_URL || configured?.WORKER_DATABASE_URL;
if (appUrl) process.env.DATABASE_URL = appUrl;
if (workerUrl) process.env.WORKER_DATABASE_URL = workerUrl;
process.env.APP_URL ??= 'https://app.example.test';

const accountA = randomUUID(), accountB = randomUUID();
const ownerA = randomUUID(), adminA = randomUUID(), agentA = randomUUID(), viewerA = randomUUID(), ownerB = randomUUID();
const users = [ownerA, adminA, agentA, viewerA, ownerB];
const handleA = `p4a-${accountA.slice(0, 8)}`, handleB = `p4b-${accountB.slice(0, 8)}`;
const asAdmin: TenantContext = { accountId: accountA, userId: adminA, role: 'admin' };
const asAgent: TenantContext = { accountId: accountA, userId: agentA, role: 'agent' };
const asViewer: TenantContext = { accountId: accountA, userId: viewerA, role: 'viewer' };
const asOwnerB: TenantContext = { accountId: accountB, userId: ownerB, role: 'owner' };
let db: pg.Client;

const app = <T,>(ctx: TenantContext, fn: Parameters<typeof withTenant<T>>[1]) => withTenant(ctx, fn);
const codeOf = (p: Promise<unknown>) => p.then(() => 'ok', (e) => (e instanceof CatalogueError ? `${e.code}:${e.field ?? ''}` : String(e?.message ?? e)));
const sqlCodeOf = (p: Promise<unknown>) => p.then(() => 'ok', (e: { code?: string }) => e.code ?? 'error');

interface Made { id: string; variant: string }
/** A published (or draft) product with one priced variant. */
async function product(ctx: TenantContext, name: string, fields: Record<string, unknown>, price: number, extra: { compareAt?: number; publish?: boolean; sku: string }): Promise<Made> {
  const p = await app(ctx, (tx) => upsertProduct(tx, ctx.accountId, ctx.userId!, null, { name, ...fields }));
  const withVariant = await app(ctx, (tx) => upsertVariant(tx, ctx.accountId, ctx.userId!, p.id,
    null, { sku: extra.sku, price_minor: price, ...(extra.compareAt ? { compare_at_minor: extra.compareAt } : {}) }));
  if (extra.publish !== false) await app(ctx, (tx) => publishProduct(tx, ctx.accountId, ctx.userId!, p.id));
  return { id: p.id, variant: withVariant.variants[0].id };
}

describe.skipIf(!ownerUrl || !appUrl || !workerUrl)('store plan phase 4: catalogue fields and collections on PostgreSQL', { timeout: 180_000 }, () => {
  let categoryId = '';
  let p1: Made, p2: Made, p3: Made, p4: Made, p6: Made, foreign: Made;

  beforeAll(async () => {
    db = new pg.Client({ connectionString: ownerUrl });
    await db.connect();
    if (!/test/i.test((await db.query('SELECT current_database() AS name')).rows[0].name)) throw new Error('Requires an isolated test database');
    const role = await getPrisma().$queryRaw<{ role: string }[]>`SELECT current_user AS role`;
    if (role[0].role !== 'bodhinox_app') throw new Error('Requires constrained test app credentials');
    await db.query("INSERT INTO auth_users(id,email,full_name,password_hash) SELECT x, x::text || '@example.invalid', 'P4 cat', 'test-only-hash' FROM unnest($1::uuid[]) x", [users]);
    await db.query("INSERT INTO accounts(id,name,owner_user_id) VALUES($1,'P4 A',$2),($3,'P4 B',$4)", [accountA, ownerA, accountB, ownerB]);
    await db.query("INSERT INTO account_subscriptions(account_id,plan_id) VALUES($1,'basic'),($2,'basic')", [accountA, accountB]);
    await db.query(`INSERT INTO account_memberships(account_id,user_id,role) VALUES ($1,$2,'owner'),($1,$3,'admin'),($1,$4,'agent'),($1,$5,'viewer'),($6,$7,'owner')`,
      [accountA, ownerA, adminA, agentA, viewerA, accountB, ownerB]);
    await db.query(`INSERT INTO commerce_settings(account_id,currency,default_tax_rate_bps) VALUES($1,'INR',1800),($2,'INR',1800)`, [accountA, accountB]);
    await db.query(`INSERT INTO shop_storefronts(account_id,handle,published,template) VALUES($1,$2,true,'wellness'),($3,$4,true,'wellness')`,
      [accountA, handleA, accountB, handleB]);

    categoryId = (await app(asAdmin, (tx) => createCategory(tx, accountA, adminA, { name: 'Oils' }))).id;
    p1 = await product(asAdmin, 'Ashwagandha oil', { tags: ['Gift', 'oil'], brand: 'Kumar', product_type: 'Oil', category_id: categoryId,
      details: [{ label: 'Size', value: '100 ml' }, { label: 'Made in', value: 'Kerala' }] }, 50000, { sku: 'P4-ASH' });
    p2 = await product(asAdmin, 'Tulsi tea', { tags: ['gift'], brand: 'Other', product_type: 'Tea' }, 30000, { sku: 'P4-TULSI', compareAt: 40000 });
    p3 = await product(asAdmin, 'Draft thing', { tags: ['gift'], brand: 'Kumar' }, 20000, { sku: 'P4-DRAFT', publish: false });
    p4 = await product(asAdmin, 'Archived thing', { tags: ['gift'], brand: 'Kumar' }, 20000, { sku: 'P4-ARCH' });
    await app(asAdmin, (tx) => archiveProduct(tx, accountA, adminA, p4.id, true));
    p6 = await product(asAdmin, 'Cheap soap', { brand: 'kumar', product_type: 'oil' }, 10000, { sku: 'P4-SOAP' });
    foreign = await product(asOwnerB, 'B product', { tags: ['gift'], brand: 'Kumar' }, 10000, { sku: 'P4-B' });
  });

  afterAll(async () => {
    if (db) {
      await db.query('DELETE FROM accounts WHERE id=ANY($1::uuid[])', [[accountA, accountB]]);
      await db.query('DELETE FROM auth_users WHERE id=ANY($1::uuid[])', [users]);
      await db.end();
    }
    await disconnectDatabases();
  });

  const smart = (rules: unknown[], extra: Record<string, unknown> = {}) => ({ title: `S ${randomUUID().slice(0, 6)}`, kind: 'smart', published: true, sort: 'name', rules, ...extra });
  const idsOf = async (body: Record<string, unknown>) => {
    const made = await app(asAdmin, (tx) => upsertCollection(tx, accountA, adminA, null, body));
    const page = await loadShopCollection(handleA, made.slug);
    return { made, ids: (page?.products ?? []).map((p) => p.id) };
  };

  it('stores tags, brand, type and details, and rejects bad shapes', async () => {
    const stored = await app(asAdmin, (tx) => getShopProduct(tx, accountA, p1.id));
    expect(stored).toMatchObject({ tags: ['gift', 'oil'], brand: 'Kumar', product_type: 'Oil', details: [{ label: 'Size', value: '100 ml' }, { label: 'Made in', value: 'Kerala' }] });
    expect(await codeOf(app(asAdmin, (tx) => upsertProduct(tx, accountA, adminA, p1.id, { tags: Array.from({ length: 21 }, (_, i) => `t${i}`) })))).toBe('invalid:tags');
    expect(await codeOf(app(asAdmin, (tx) => upsertProduct(tx, accountA, adminA, p1.id, { details: Array.from({ length: 13 }, () => ({ label: 'a', value: 'b' })) })))).toBe('invalid:details');
    expect(await codeOf(app(asAdmin, (tx) => upsertProduct(tx, accountA, adminA, p1.id, { brand: 'x'.repeat(81) })))).toBe('invalid:brand');
    // The database says the same, whatever the application does.
    expect(await sqlCodeOf(db.query("UPDATE shop_products SET tags=ARRAY['Upper'] WHERE id=$1", [p1.id]))).toBe('23514');
    expect(await sqlCodeOf(db.query("UPDATE shop_products SET tags=ARRAY['a','a'] WHERE id=$1", [p1.id]))).toBe('23514');
    expect(await sqlCodeOf(db.query("UPDATE shop_products SET details='{}'::jsonb WHERE id=$1", [p1.id]))).toBe('23514');
    // An agent reads, never writes.
    expect((await app(asAgent, (tx) => getShopProduct(tx, accountA, p1.id))).tags).toEqual(['gift', 'oil']);
    await expect(app(asAgent, (tx) => upsertProduct(tx, accountA, agentA, p1.id, { tags: ['x'] }))).rejects.toThrow();
    // A copy keeps the fields.
    const copy = await app(asAdmin, (tx) => duplicateProduct(tx, accountA, adminA, p1.id));
    expect(copy).toMatchObject({ tags: ['gift', 'oil'], brand: 'Kumar', product_type: 'Oil', details: stored.details });
  });

  it('lets a variant show only an image of its own product, and keeps it through image edits', async () => {
    const withImages = await app(asAdmin, (tx) => upsertProduct(tx, accountA, adminA, p1.id,
      { images: [{ url: 'https://cdn.example.com/a.jpg' }, { url: 'https://cdn.example.com/b.jpg' }] }));
    const [imgA, imgB] = withImages.images;
    const red = await app(asAdmin, (tx) => upsertVariant(tx, accountA, adminA, p1.id, null, { sku: 'P4-ASH-R', option_values: { Colour: 'Red' }, price_minor: 50000, image_id: imgB.id }));
    const redVariant = red.variants.find((v) => v.sku === 'P4-ASH-R')!;
    expect(redVariant.image_id).toBe(imgB.id);

    // Another product's image, another workspace's image and a made-up id are all refused (service) ...
    const otherProductImage = (await app(asAdmin, (tx) => upsertProduct(tx, accountA, adminA, p2.id, { images: [{ url: 'https://cdn.example.com/c.jpg' }] }))).images[0];
    const foreignImage = (await app(asOwnerB, (tx) => upsertProduct(tx, accountB, ownerB, foreign.id, { images: [{ url: 'https://cdn.example.com/d.jpg' }] }))).images[0];
    for (const bad of [otherProductImage.id, foreignImage.id, randomUUID()])
      expect(await codeOf(app(asAdmin, (tx) => upsertVariant(tx, accountA, adminA, p1.id, redVariant.id, { image_id: bad })))).toBe('invalid:image_id');
    // ... and by the database itself (composite foreign key), even for the table owner.
    for (const bad of [otherProductImage.id, foreignImage.id])
      expect(await sqlCodeOf(db.query('UPDATE shop_variants SET image_id=$1 WHERE id=$2', [bad, redVariant.id]))).toBe('23503');
    expect(await sqlCodeOf(db.query('UPDATE shop_variants SET image_id=$1 WHERE id=$2', [imgA.id, redVariant.id]))).toBe('ok');
    expect(await sqlCodeOf(db.query('UPDATE shop_variants SET image_id=$1 WHERE id=$2', [imgB.id, redVariant.id]))).toBe('ok');
    // The app role cannot move a variant to another product to dodge the check.
    await expect(app(asAdmin, (tx) => tx.$executeRaw`UPDATE shop_variants SET product_id=${p2.id}::uuid WHERE id=${redVariant.id}::uuid`)).rejects.toThrow();
    // Another workspace cannot set it at all.
    expect(await codeOf(app(asOwnerB, (tx) => upsertVariant(tx, accountB, ownerB, p1.id, redVariant.id, { image_id: imgB.id })))).toBe('not_found:');

    // Reordering the pictures keeps the pick on the same picture; removing the picture clears it.
    const reordered = await app(asAdmin, (tx) => upsertProduct(tx, accountA, adminA, p1.id,
      { images: [{ url: 'https://cdn.example.com/b.jpg' }, { url: 'https://cdn.example.com/a.jpg' }] }));
    expect(reordered.variants.find((v) => v.id === redVariant.id)!.image_id).toBe(reordered.images[0].id);
    const removed = await app(asAdmin, (tx) => upsertProduct(tx, accountA, adminA, p1.id, { images: [{ url: 'https://cdn.example.com/a.jpg' }] }));
    expect(removed.variants.find((v) => v.id === redVariant.id)!.image_id).toBeNull();

    // The public page shows each variant's own picture by its place in the gallery, and the details as plain rows.
    await app(asAdmin, (tx) => upsertProduct(tx, accountA, adminA, p1.id,
      { images: [{ url: 'https://cdn.example.com/a.jpg' }, { url: 'https://cdn.example.com/b.jpg' }] }));
    const fresh = await app(asAdmin, (tx) => getShopProduct(tx, accountA, p1.id));
    await app(asAdmin, (tx) => upsertVariant(tx, accountA, adminA, p1.id, redVariant.id, { image_id: fresh.images[1].id }));
    const page = await loadShopProduct(handleA, p1.id);
    expect(page?.product.variants.find((v) => v.id === redVariant.id)?.imageIndex).toBe(1);
    expect(page?.product.variants.find((v) => v.id === p1.variant)?.imageIndex).toBeNull();
    expect(page?.product.details).toEqual([{ label: 'Size', value: '100 ml' }, { label: 'Made in', value: 'Kerala' }]);

    // A copy of the product points its variants at the copy's own images.
    const copy = await app(asAdmin, (tx) => duplicateProduct(tx, accountA, adminA, p1.id, { name: 'Ashwagandha copy' }));
    const copiedVariant = copy.variants.find((v) => v.sku.startsWith('P4-ASH-R'))!;
    expect(copy.images.map((i) => i.id)).toContain(copiedVariant.image_id);
    expect(fresh.images.map((i) => i.id)).not.toContain(copiedVariant.image_id);
  });

  it('chooses products by smart rules, only published ones with a priced variant', async () => {
    expect((await idsOf(smart([{ field: 'tag', op: 'eq', value: 'GIFT' }]))).ids).toEqual([p1.id, p2.id]);
    expect((await idsOf(smart([{ field: 'tag', op: 'eq', value: 'gift' }, { field: 'brand', op: 'eq', value: 'KUMAR' }]))).ids).toEqual([p1.id]);
    expect((await idsOf(smart([{ field: 'brand', op: 'eq', value: 'kumar' }, { field: 'on_sale', op: 'is', value: true }], { match: 'any' }))).ids)
      .toEqual([p1.id, p6.id, p2.id]);
    expect((await idsOf(smart([{ field: 'price', op: 'lt', value: 20000 }]))).ids).toEqual([p6.id]);
    expect((await idsOf(smart([{ field: 'price', op: 'gt', value: 40000 }]))).ids).toEqual([p1.id]);
    expect((await idsOf(smart([{ field: 'category', op: 'eq', value: categoryId }]))).ids).toEqual([p1.id]);
    expect((await idsOf(smart([{ field: 'category', op: 'neq', value: categoryId }]))).ids).toEqual([p6.id, p2.id]);
    expect((await idsOf(smart([{ field: 'tag', op: 'neq', value: 'gift' }]))).ids).toEqual([p6.id]);
    expect((await idsOf(smart([{ field: 'on_sale', op: 'is', value: false }]))).ids).toEqual([p1.id, p6.id]);
    expect((await idsOf(smart([{ field: 'product_type', op: 'eq', value: 'oil' }], { sort: 'price_asc' }))).ids).toEqual([p6.id, p1.id]);
    expect((await idsOf(smart([{ field: 'tag', op: 'eq', value: 'gift' }], { sort: 'price_desc' }))).ids).toEqual([p1.id, p2.id]);
    // No rules, nothing; the other workspace's product is never matched.
    expect((await idsOf(smart([]))).ids).toEqual([]);
    expect((await idsOf(smart([{ field: 'brand', op: 'eq', value: 'Kumar' }]))).ids).not.toContain(foreign.id);
    // Draft and archived products never show, whatever the rules say.
    expect((await idsOf(smart([{ field: 'brand', op: 'eq', value: 'Kumar' }]))).ids).not.toEqual(expect.arrayContaining([p3.id]));
    expect((await idsOf(smart([{ field: 'brand', op: 'eq', value: 'Kumar' }]))).ids).not.toEqual(expect.arrayContaining([p4.id]));
  });

  it('keeps injection-looking values and unknown rules out of the SQL', async () => {
    const evil = "Kumar'); DELETE FROM shop_products; --";
    expect((await idsOf(smart([{ field: 'brand', op: 'eq', value: evil }]))).ids).toEqual([]);
    expect((await idsOf(smart([{ field: 'tag', op: 'eq', value: evil }]))).ids).toEqual([]);
    expect(await codeOf(app(asAdmin, (tx) => upsertCollection(tx, accountA, adminA, null, smart([{ field: 'p.id) OR (1=1', op: 'eq', value: 'a' }]))))).toBe('invalid:rules');
    expect(await codeOf(app(asAdmin, (tx) => upsertCollection(tx, accountA, adminA, null, smart([{ field: 'tag', op: 'like', value: '%' }]))))).toBe('invalid:rules');
    expect(await codeOf(app(asAdmin, (tx) => upsertCollection(tx, accountA, adminA, null, smart(Array.from({ length: 11 }, () => ({ field: 'tag', op: 'eq', value: 'a' }))))))).toBe('invalid:rules');
    expect(await codeOf(app(asAdmin, (tx) => previewCollection(tx, accountA, { kind: 'smart', rules: [{ field: 'x', op: 'eq', value: 'a' }] })))).toBe('invalid:rules');
    const left = await db.query('SELECT count(*)::int AS n FROM shop_products WHERE account_id=$1', [accountA]);
    expect(left.rows[0].n).toBeGreaterThanOrEqual(5);
    // The database refuses a rules array that is too long or not an array, even from the owner.
    expect(await sqlCodeOf(db.query("INSERT INTO shop_collections(account_id,title,slug,rules) VALUES($1,'x','too-many',$2::jsonb)",
      [accountA, JSON.stringify(Array.from({ length: 11 }, () => ({})))]))).toBe('23514');
    expect(await sqlCodeOf(db.query("INSERT INTO shop_collections(account_id,title,slug,rules) VALUES($1,'x','not-array','{}'::jsonb)", [accountA]))).toBe('23514');
  });

  it('previews a draft collection without saving it', async () => {
    const before = (await app(asAdmin, (tx) => listCollections(tx, accountA))).length;
    const preview = await app(asAgent, (tx) => previewCollection(tx, accountA, { kind: 'smart', match: 'all', rules: [{ field: 'tag', op: 'eq', value: 'gift' }] }));
    expect(preview.count).toBe(2);
    expect(preview.sample.map((s) => s.name)).toEqual(['Ashwagandha oil', 'Tulsi tea']);
    const manual = await app(asAgent, (tx) => previewCollection(tx, accountA, { kind: 'manual', product_ids: [p1.id, p3.id, foreign.id] }));
    expect(manual.count).toBe(1);
    expect((await app(asAdmin, (tx) => listCollections(tx, accountA))).length).toBe(before);
  });

  it('keeps a manual collection in the picked order and shows only published collections publicly', async () => {
    const made = await app(asAdmin, (tx) => upsertCollection(tx, accountA, adminA, null,
      { title: 'Gift picks', slug: 'gift-picks', kind: 'manual', published: true, product_ids: [p2.id, p3.id, p1.id] }));
    expect(made.products.map((p) => p.id)).toEqual([p2.id, p3.id, p1.id]);
    expect(made.product_count).toBe(2);
    const page = await loadShopCollection(handleA, 'gift-picks');
    expect(page).toMatchObject({ collection: { slug: 'gift-picks', title: 'Gift picks' }, total: 2 });
    expect(page?.products.map((p) => p.id)).toEqual([p2.id, p1.id]);
    expect((await loadShopCollection(handleA, 'gift-picks', { sort: 'price_desc' }))?.products.map((p) => p.id)).toEqual([p1.id, p2.id]);
    // Unpublished: the same plain not-found as a missing one; another shop's address does not find it.
    await app(asAdmin, (tx) => upsertCollection(tx, accountA, adminA, made.id, { published: false }));
    expect(await loadShopCollection(handleA, 'gift-picks')).toBeNull();
    expect(await loadShopCollection(handleA, 'nothing-here')).toBeNull();
    expect(await loadShopCollection(handleA, 'Bad Slug')).toBeNull();
    await app(asAdmin, (tx) => upsertCollection(tx, accountA, adminA, made.id, { published: true }));
    expect(await loadShopCollection(handleB, 'gift-picks')).toBeNull();
  });

  it('feeds a featured collection section on the home page', async () => {
    const made = await app(asAdmin, (tx) => upsertCollection(tx, accountA, adminA, null, smart([{ field: 'tag', op: 'eq', value: 'gift' }], { slug: 'home-gifts', title: 'Home gifts' })));
    const hidden = await app(asAdmin, (tx) => upsertCollection(tx, accountA, adminA, null, smart([{ field: 'tag', op: 'eq', value: 'gift' }], { published: false, slug: 'home-hidden' })));
    await db.query('UPDATE shop_storefronts SET document=$2::jsonb WHERE account_id=$1', [accountA, JSON.stringify({ sections: [
      { id: 'feat1', type: 'featured_collection', settings: { collection: made.id, limit: 4 } },
      { id: 'feat2', type: 'featured_collection', settings: { collection: hidden.id } },
      { id: 'feat3', type: 'featured_collection', settings: { category: categoryId } },
    ] })]);
    const home = await loadShopHome(handleA);
    expect(Object.keys(home!.collections)).toEqual([made.id]);
    expect(home!.collections[made.id]).toMatchObject({ slug: 'home-gifts', title: 'Home gifts', productIds: [p1.id, p2.id] });
    // The old category field still works beside it.
    expect(home!.content.sections.find((s) => s.id === 'feat3')?.settings.category).toBe(categoryId);
  });

  it('keeps collections inside their workspace', async () => {
    const mine = await app(asAdmin, (tx) => upsertCollection(tx, accountA, adminA, null, { title: 'Tenancy', slug: 'tenancy', kind: 'manual', product_ids: [p1.id] }));
    // Another workspace sees none of it, cannot read, change or delete it, and cannot pick A's products.
    expect((await app(asOwnerB, (tx) => listCollections(tx, accountB))).map((c) => c.slug)).toEqual([]);
    expect(await codeOf(app(asOwnerB, (tx) => getCollection(tx, accountB, mine.id)))).toBe('not_found:');
    expect(await codeOf(app(asOwnerB, (tx) => upsertCollection(tx, accountB, ownerB, mine.id, { title: 'Hijacked' })))).toBe('not_found:');
    expect(await codeOf(app(asOwnerB, (tx) => deleteCollection(tx, accountB, ownerB, mine.id)))).toBe('not_found:');
    expect(await codeOf(app(asOwnerB, (tx) => upsertCollection(tx, accountB, ownerB, null, { title: 'Mine', kind: 'manual', product_ids: [p1.id] })))).toBe('invalid:product_ids');
    // Slugs are unique per workspace, not across them.
    expect((await app(asOwnerB, (tx) => upsertCollection(tx, accountB, ownerB, null, { title: 'Tenancy', slug: 'tenancy', product_ids: [foreign.id] }))).slug).toBe('tenancy');
    expect(await codeOf(app(asAdmin, (tx) => upsertCollection(tx, accountA, adminA, null, { title: 'Again', slug: 'tenancy' })))).toBe('slug_taken:slug');
    // The database refuses a member that is another workspace's product, even for the table owner.
    const bColl = (await app(asOwnerB, (tx) => listCollections(tx, accountB)))[0];
    expect(bColl).toBeDefined();
    expect(await sqlCodeOf(db.query('INSERT INTO shop_collection_products(account_id,collection_id,product_id) VALUES($1,$2,$3)', [accountA, mine.id, foreign.id]))).toBe('23503');
    expect(await sqlCodeOf(db.query('INSERT INTO shop_collection_products(account_id,collection_id,product_id) VALUES($1,$2,$3)', [accountA, bColl.id, p1.id]))).toBe('23503');
    // Untouched after the attempts.
    expect((await app(asAdmin, (tx) => getCollection(tx, accountA, mine.id))).title).toBe('Tenancy');
  });

  it('lets agents read and only admins write', async () => {
    const mine = (await app(asAdmin, (tx) => listCollections(tx, accountA))).find((c) => c.slug === 'tenancy')!;
    expect((await app(asAgent, (tx) => listCollections(tx, accountA))).map((c) => c.id)).toContain(mine.id);
    expect((await app(asAgent, (tx) => getCollection(tx, accountA, mine.id))).products.map((p) => p.id)).toEqual([p1.id]);
    await expect(app(asAgent, (tx) => upsertCollection(tx, accountA, agentA, null, { title: 'By agent' }))).rejects.toThrow();
    await expect(app(asAgent, (tx) => upsertCollection(tx, accountA, agentA, mine.id, { title: 'By agent' }))).rejects.toThrow();
    await expect(app(asAgent, (tx) => deleteCollection(tx, accountA, agentA, mine.id))).rejects.toThrow();
    // A viewer reads nothing at all.
    expect(await app(asViewer, (tx) => listCollections(tx, accountA))).toEqual([]);
    expect(await codeOf(app(asViewer, (tx) => getCollection(tx, accountA, mine.id)))).toBe('not_found:');
    expect((await app(asAdmin, (tx) => getCollection(tx, accountA, mine.id))).title).toBe('Tenancy');
  });

  it('deletes a collection with its members and audits ids only', async () => {
    const made = await app(asAdmin, (tx) => upsertCollection(tx, accountA, adminA, null, { title: 'Short lived', kind: 'manual', product_ids: [p1.id, p2.id] }));
    await app(asAdmin, (tx) => deleteCollection(tx, accountA, adminA, made.id));
    expect(await codeOf(app(asAdmin, (tx) => getCollection(tx, accountA, made.id)))).toBe('not_found:');
    expect((await db.query('SELECT count(*)::int AS n FROM shop_collection_products WHERE collection_id=$1', [made.id])).rows[0].n).toBe(0);
    const audits = (await db.query("SELECT action, resource_id, metadata FROM audit_logs WHERE account_id=$1 AND action LIKE 'commerce.collection_%' AND resource_id=$2 ORDER BY created_at",
      [accountA, made.id])).rows;
    expect(audits.map((a) => a.action)).toEqual(['commerce.collection_created', 'commerce.collection_deleted']);
    expect(JSON.stringify(audits)).not.toContain('Short lived');
  });
});
