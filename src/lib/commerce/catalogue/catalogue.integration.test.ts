import { randomUUID } from 'node:crypto';
import { config } from 'dotenv';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { disconnectDatabases, getPrisma } from '@/lib/db/prisma';
import { withTenant, type TenantContext } from '@/lib/db/tenant';
import {
  archiveProduct, CatalogueError, createCategory, getShopProduct, importFromMeta, linkMetaProducts, listCategories, listShopProducts,
  publishProduct, updateCategory, upsertProduct, upsertVariant,
} from './products';
import { adjustStock, listInventory, listMovements, setLowStockThreshold } from './inventory';

// Phase 8 T2: the Bodhinox-owned catalogue and staff stock adjustments on
// PostgreSQL. Admin writes through RLS, agents read, viewers see nothing;
// publish needs a reviewed, priced product; Meta import never overwrites;
// stock changes go through stock.ts on the worker role with the
// commerce.inventory permission, a stale-count check and an audit entry.
const configured = config({ path: '.env.test', quiet: true }).parsed;
const ownerUrl = process.env.TEST_DATABASE_URL;
const appUrl = process.env.TEST_APP_DATABASE_URL || configured?.DATABASE_URL;
const workerUrl = process.env.TEST_WORKER_DATABASE_URL || configured?.WORKER_DATABASE_URL;
if (appUrl) process.env.DATABASE_URL = appUrl;
if (workerUrl) process.env.WORKER_DATABASE_URL = workerUrl;

const accountA = randomUUID(), accountB = randomUUID(), accountC = randomUUID();
const ownerA = randomUUID(), adminA = randomUUID(), agentA = randomUUID(), viewerA = randomUUID(), ownerB = randomUUID(), ownerC = randomUUID();
const users = [ownerA, adminA, agentA, viewerA, ownerB, ownerC];
const asAdmin = { accountId: accountA, userId: adminA, role: 'admin' } as const;
const asAgent: TenantContext = { accountId: accountA, userId: agentA, role: 'agent' };
const asViewer: TenantContext = { accountId: accountA, userId: viewerA, role: 'viewer' };
const asOwnerB = { accountId: accountB, userId: ownerB, role: 'owner' } as const;
const asOwnerC = { accountId: accountC, userId: ownerC, role: 'owner' } as const;
const catalogRow = randomUUID(), metaFresh = randomUUID(), metaTaken = randomUUID(), metaBadSku = randomUUID(), metaUsd = randomUUID(), metaAgent = randomUUID();
let db: pg.Client;

const app = <T,>(ctx: TenantContext, fn: Parameters<typeof withTenant<T>>[1]) => withTenant(ctx, fn);
const codeOf = (p: Promise<unknown>) => p.then(() => 'ok', (e) => (e instanceof CatalogueError ? e.code : String(e?.message ?? e)));

describe.skipIf(!ownerUrl || !appUrl || !workerUrl)('phase 8 catalogue and inventory on PostgreSQL', { timeout: 120_000 }, () => {
  beforeAll(async () => {
    db = new pg.Client({ connectionString: ownerUrl });
    await db.connect();
    if (!/test/i.test((await db.query('SELECT current_database() AS name')).rows[0].name)) throw new Error('Requires an isolated test database');
    const role = await getPrisma().$queryRaw<{ role: string }[]>`SELECT current_user AS role`;
    if (role[0].role !== 'bodhinox_app') throw new Error('Requires constrained test app credentials');
    await db.query("INSERT INTO auth_users(id,email,full_name,password_hash) SELECT x, x::text || '@example.invalid', 'P8 cat', 'test-only-hash' FROM unnest($1::uuid[]) x", [users]);
    await db.query("INSERT INTO accounts(id,name,owner_user_id) VALUES($1,'Cat A',$2),($3,'Cat B',$4),($5,'Cat C',$6)",
      [accountA, ownerA, accountB, ownerB, accountC, ownerC]);
    await db.query("INSERT INTO account_subscriptions(account_id,plan_id) VALUES($1,'basic'),($2,'basic'),($3,'basic')", [accountA, accountB, accountC]);
    await db.query(`INSERT INTO account_memberships(account_id,user_id,role) VALUES ($1,$2,'owner'),($1,$3,'admin'),($1,$4,'agent'),($1,$5,'viewer'),
      ($6,$7,'owner'),($8,$9,'owner')`, [accountA, ownerA, adminA, agentA, viewerA, accountB, ownerB, accountC, ownerC]);
    await db.query(`INSERT INTO commerce_settings(account_id,currency,default_tax_rate_bps,low_stock_default) VALUES($1,'INR',1800,3),($2,'INR',NULL,5)`,
      [accountA, accountB]);
    await db.query(`INSERT INTO whatsapp_catalogs(id,account_id,catalog_id,name) VALUES($1,$2,'9001','Shop')`, [catalogRow, accountA]);
    await db.query(`INSERT INTO products(id,account_id,catalog_row_id,retailer_id,name,description,price_minor,currency,image_url) VALUES
      ($1,$5,$6,'TULSI-1','Tulsi drops','Herbal',25000,'INR','https://cdn.example.com/t.jpg'),
      ($2,$5,$6,'ASH-60','Meta Ashwagandha',NULL,99900,'INR',NULL),
      ($3,$5,$6,'bad sku!','Bad',NULL,100,'INR',NULL),
      ($4,$5,$6,'USD-1','Imported',NULL,500,'USD','http://insecure.example.com/x.jpg')`,
      [metaFresh, metaTaken, metaBadSku, metaUsd, accountA, catalogRow]);
  });

  afterAll(async () => {
    if (db) {
      await db.query('DELETE FROM accounts WHERE id=ANY($1::uuid[])', [[accountA, accountB, accountC]]);
      await db.query('DELETE FROM auth_users WHERE id=ANY($1::uuid[])', [users]);
      await db.end();
    }
    await disconnectDatabases();
  });

  let productId = '', variantId = '', categoryId = '';

  it('keeps categories two levels deep', async () => {
    const top = await app(asAdmin, (tx) => createCategory(tx, accountA, adminA, { name: 'Ayurveda' }));
    const child = await app(asAdmin, (tx) => createCategory(tx, accountA, adminA, { name: 'Oils', parent_id: top.id }));
    expect(await codeOf(app(asAdmin, (tx) => createCategory(tx, accountA, adminA, { name: 'Deep', parent_id: child.id })))).toBe('category_depth');
    expect(await codeOf(app(asAdmin, (tx) => updateCategory(tx, accountA, adminA, top.id, { parent_id: child.id })))).toBe('category_depth');
    const other = await app(asAdmin, (tx) => createCategory(tx, accountA, adminA, { name: 'Teas' }));
    expect(await codeOf(app(asAdmin, (tx) => updateCategory(tx, accountA, adminA, top.id, { parent_id: other.id })))).toBe('category_has_children');
    expect(await codeOf(app(asAdmin, (tx) => updateCategory(tx, accountA, adminA, top.id, { parent_id: top.id })))).toBe('category_depth');
    // Another workspace's category is invisible.
    expect(await codeOf(app(asOwnerB, (tx) => createCategory(tx, accountB, ownerB, { name: 'X', parent_id: top.id })))).toBe('invalid');
    categoryId = child.id;
    expect((await app(asAgent, (tx) => listCategories(tx, accountA))).map((c) => c.name)).toEqual(expect.arrayContaining(['Ayurveda', 'Oils']));
  });

  it('creates a draft, refuses to publish it unpriced, then publishes with a review stamp', async () => {
    const product = await app(asAdmin, (tx) => upsertProduct(tx, accountA, adminA, null,
      { name: '  Ashwagandha  ', description: 'Root powder', disclosure: 'Consult a practitioner.', category_id: categoryId }));
    productId = product.id;
    expect(product).toMatchObject({ name: 'Ashwagandha', status: 'draft', content_reviewed_at: null, currency: 'INR', version: 1 });
    const withVariant = await app(asAdmin, (tx) => upsertVariant(tx, accountA, adminA, productId, null,
      { sku: 'ASH-60', option_values: { Size: '60 caps' }, hsn_code: '3004' }));
    variantId = withVariant.variants[0].id;
    expect(withVariant.variants[0]).toMatchObject({ sku: 'ASH-60', price_minor: null, track_inventory: true, on_hand: 0, meta_linked: true });
    expect(await codeOf(app(asAdmin, (tx) => publishProduct(tx, accountA, adminA, productId)))).toBe('needs_priced_variant');
    await app(asAdmin, (tx) => upsertVariant(tx, accountA, adminA, productId, variantId, { price_minor: 49900, tax_rate_bps: 1200 }));
    const published = await app(asAdmin, (tx) => publishProduct(tx, accountA, adminA, productId));
    expect(published).toMatchObject({ status: 'published', content_reviewed_by: adminA });
    expect(published.content_reviewed_at).not.toBeNull();
    // A stale version is a conflict; the last priced variant of a published product cannot lose its price.
    expect(await codeOf(app(asAdmin, (tx) => upsertProduct(tx, accountA, adminA, productId, { version: 1, name: 'Old' })))).toBe('conflict');
    expect(await codeOf(app(asAdmin, (tx) => upsertVariant(tx, accountA, adminA, productId, variantId, { price_minor: null }))))
      .toBe('needs_priced_variant');
    expect(await codeOf(app(asAdmin, (tx) => upsertVariant(tx, accountA, adminA, productId, variantId, { archived: true }))))
      .toBe('needs_priced_variant');
    const audits = (await db.query(`SELECT action, metadata FROM audit_logs WHERE account_id=$1 AND action LIKE 'commerce.%' ORDER BY created_at`,
      [accountA])).rows;
    expect(audits.map((a) => a.action)).toEqual(expect.arrayContaining(['commerce.product_created', 'commerce.variant_created',
      'commerce.variant_updated', 'commerce.product_published']));
    expect(JSON.stringify(audits)).not.toContain('Root powder');
  });

  it('re-stamps the reviewer when a published product text changes', async () => {
    const before = await app(asAdmin, (tx) => getShopProduct(tx, accountA, productId));
    await new Promise((r) => setTimeout(r, 5));
    const after = await app({ accountId: accountA, userId: ownerA, role: 'owner' }, (tx) =>
      upsertProduct(tx, accountA, ownerA, productId, { version: before.version, description: 'Root powder, 60 capsules' }));
    expect(after).toMatchObject({ status: 'published', content_reviewed_by: ownerA, version: before.version + 1 });
  });

  it('enforces SKUs, prices and images', async () => {
    expect(await codeOf(app(asAdmin, (tx) => upsertVariant(tx, accountA, adminA, productId, null, { sku: 'ASH-60' })))).toBe('sku_taken');
    expect(await codeOf(app(asAdmin, (tx) => upsertVariant(tx, accountA, adminA, productId, null, { sku: 'has space' })))).toBe('invalid');
    expect(await codeOf(app(asAdmin, (tx) => upsertVariant(tx, accountA, adminA, productId, null, { sku: 'X1', price_minor: 1.5 })))).toBe('invalid');
    // The same SKU in another workspace is fine; a price there before the store currency exists is refused.
    const other = await app(asOwnerC, (tx) => upsertProduct(tx, accountC, ownerC, null, { name: 'Other' }));
    expect(await codeOf(app(asOwnerC, (tx) => upsertVariant(tx, accountC, ownerC, other.id, null, { sku: 'ASH-60', price_minor: 100 }))))
      .toBe('store_not_configured');
    await app(asOwnerC, (tx) => upsertVariant(tx, accountC, ownerC, other.id, null, { sku: 'ASH-60' }));
    expect(await codeOf(app(asAdmin, (tx) => upsertProduct(tx, accountA, adminA, productId, { images: [{ url: 'http://x.example.com/a.jpg' }] }))))
      .toBe('invalid');
    expect(await codeOf(app(asAdmin, (tx) => upsertProduct(tx, accountA, adminA, productId, { images: [{ media_id: randomUUID() }] }))))
      .toBe('invalid');
    const withImages = await app(asAdmin, (tx) => upsertProduct(tx, accountA, adminA, productId,
      { images: [{ url: 'https://cdn.example.com/1.jpg' }, { url: 'https://cdn.example.com/2.jpg' }] }));
    expect(withImages.images.map((i) => [i.position, i.display_url])).toEqual([[0, 'https://cdn.example.com/1.jpg'], [1, 'https://cdn.example.com/2.jpg']]);
    // Another workspace's product is a 404.
    expect(await codeOf(app(asOwnerB, (tx) => getShopProduct(tx, accountB, productId)))).toBe('not_found');
    expect(await codeOf(app(asOwnerB, (tx) => upsertVariant(tx, accountB, ownerB, productId, null, { sku: 'Z1' })))).toBe('not_found');
  });

  it('lets agents read, keeps them from writing, and shows viewers nothing', async () => {
    const page = await app(asAgent, (tx) => listShopProducts(tx, accountA, { q: 'ash' }));
    expect(page.products).toEqual([expect.objectContaining({ id: productId, min_price_minor: 49900, available: 0, low_count: 1 })]);
    expect((await app(asAgent, (tx) => listShopProducts(tx, accountA, { q: '%' }))).total).toBe(0);
    expect((await app(asAgent, (tx) => listShopProducts(tx, accountA, { stock: 'out' }))).total).toBe(1);
    await expect(app(asAgent, (tx) => upsertProduct(tx, accountA, agentA, null, { name: 'Sneaky' }))).rejects.toThrow();
    await expect(app(asAgent, (tx) => tx.$executeRaw`UPDATE shop_variants SET price_minor=1 WHERE account_id=${accountA}::uuid`))
      .resolves.toBe(0);
    expect((await app(asViewer, (tx) => listShopProducts(tx, accountA))).total).toBe(0);
    expect(await app(asViewer, (tx) => listCategories(tx, accountA))).toEqual([]);
  });

  it('adjusts stock through stock.ts with permission, a fresh count and an audit entry', async () => {
    await adjustStock(asAdmin, { variantId, kind: 'receipt', delta: 5, reason: 'PO 12', expectedOnHand: 0 });
    // A retried request (same expected count) is refused instead of adding twice.
    expect(await codeOf(adjustStock(asAdmin, { variantId, kind: 'receipt', delta: 5, reason: 'PO 12', expectedOnHand: 0 }))).toBe('stock_changed');
    await db.query('UPDATE inventory_levels SET reserved=2 WHERE account_id=$1 AND variant_id=$2', [accountA, variantId]);
    expect(await codeOf(adjustStock(asAdmin, { variantId, kind: 'write_off', delta: -4, reason: 'damaged', expectedOnHand: 5 }))).toBe('below_reserved');
    const level = await adjustStock(asAdmin, { variantId, kind: 'write_off', delta: -3, reason: 'damaged', expectedOnHand: 5 });
    expect(level).toMatchObject({ onHand: 2, reserved: 2 });
    // Agents and restricted admins are refused; another workspace cannot reach this variant.
    await expect(adjustStock({ ...asAgent, userId: agentA }, { variantId, kind: 'receipt', delta: 1, reason: null, expectedOnHand: 2 }))
      .rejects.toThrow(/role|turned off/i);
    await db.query(`INSERT INTO role_permission_restrictions(account_id,role,permission,created_by) VALUES($1,'admin','commerce.inventory',$2)`,
      [accountA, ownerA]);
    await expect(adjustStock(asAdmin, { variantId, kind: 'receipt', delta: 1, reason: null, expectedOnHand: 2 })).rejects.toThrow(/turned off/);
    await db.query(`DELETE FROM role_permission_restrictions WHERE account_id=$1`, [accountA]);
    expect(await codeOf(adjustStock(asOwnerB, { variantId, kind: 'receipt', delta: 1, reason: null, expectedOnHand: 0 }))).toBe('not_found');
    const movements = await app(asAgent, (tx) => listMovements(tx, accountA, { variantId }));
    expect(movements.movements.map((m) => [m.kind, m.quantity, m.on_hand_after, m.actor_user_id])).toEqual([
      ['write_off', -3, 2, adminA], ['receipt', 5, 5, adminA]]);
    const audit = (await db.query(`SELECT user_id, metadata FROM audit_logs WHERE account_id=$1 AND action='commerce.stock_adjusted' ORDER BY created_at`,
      [accountA])).rows;
    expect(audit).toEqual([
      { user_id: adminA, metadata: { kind: 'receipt', delta: 5, on_hand_after: 5 } },
      { user_id: adminA, metadata: { kind: 'write_off', delta: -3, on_hand_after: 2 } },
    ]);
    const inventory = await app(asAgent, (tx) => listInventory(tx, accountA, { filter: 'out' }));
    expect(inventory.items).toEqual([expect.objectContaining({ variant_id: variantId, on_hand: 2, reserved: 2, available: 0, low: true })]);
    // An untracked (made-to-order) variant has no stock to adjust.
    const mto = await app(asAdmin, (tx) => upsertVariant(tx, accountA, adminA, productId, null, { sku: 'ASH-MTO', track_inventory: false }));
    const mtoId = mto.variants.find((v) => v.sku === 'ASH-MTO')!.id;
    expect(await codeOf(adjustStock(asAdmin, { variantId: mtoId, kind: 'receipt', delta: 1, reason: null, expectedOnHand: 0 }))).toBe('not_tracked');
    // A per-variant low-stock threshold: admins with commerce.inventory only, audited, null back to the store default.
    await setLowStockThreshold(asAdmin, { variantId, threshold: 0 });
    expect((await app(asAgent, (tx) => listInventory(tx, accountA, { filter: 'out' }))).items[0]).toMatchObject({ low_stock_threshold: 0, low: true });
    expect(await codeOf(setLowStockThreshold(asAdmin, { variantId: mtoId, threshold: 3 }))).toBe('not_tracked');
    expect(await codeOf(setLowStockThreshold(asOwnerB, { variantId, threshold: 3 }))).toBe('not_found');
    await expect(setLowStockThreshold({ ...asAgent, userId: agentA }, { variantId, threshold: 3 })).rejects.toThrow(/role|turned off/i);
    await setLowStockThreshold(asAdmin, { variantId, threshold: null });
    expect((await db.query('SELECT low_stock_threshold FROM inventory_levels WHERE account_id=$1 AND variant_id=$2', [accountA, variantId])).rows[0])
      .toEqual({ low_stock_threshold: null });
    expect((await db.query(`SELECT metadata FROM audit_logs WHERE account_id=$1 AND action='commerce.stock_threshold_set' ORDER BY created_at`, [accountA])).rows)
      .toEqual([{ metadata: { threshold: 0 } }, { metadata: { threshold: null } }]);
  });

  it('links the Meta mirror by SKU and imports drafts without overwriting', async () => {
    const report = await app(asAgent, (tx) => linkMetaProducts(tx, accountA));
    expect(report.linked).toEqual([expect.objectContaining({ variant_id: variantId, sku: 'ASH-60', meta_price_minor: 99900, price_minor: 49900 })]);
    expect(report.variants_without_meta.map((v) => v.sku)).toEqual(['ASH-MTO']);
    expect(report.meta_without_variant.map((m) => [m.retailer_id, m.importable]).sort())
      .toEqual([['TULSI-1', true], ['USD-1', true], ['bad sku!', false]]);
    const result = await app(asAdmin, (tx) => importFromMeta(tx, accountA, adminA,
      { meta_product_ids: [metaFresh, metaTaken, metaBadSku, metaUsd, randomUUID()] }));
    expect(result.created.map((c) => c.sku).sort()).toEqual(['TULSI-1', 'USD-1']);
    expect(result.skipped.map((s) => s.reason).sort()).toEqual(['exists', 'invalid_sku', 'not_found']);
    const tulsi = await app(asAdmin, (tx) => getShopProduct(tx, accountA, result.created.find((c) => c.sku === 'TULSI-1')!.product_id));
    expect(tulsi).toMatchObject({ status: 'draft', name: 'Tulsi drops' });
    expect(tulsi.variants[0].price_minor).toBe(25000);
    expect(tulsi.images.map((i) => i.url)).toEqual(['https://cdn.example.com/t.jpg']);
    const usd = await app(asAdmin, (tx) => getShopProduct(tx, accountA, result.created.find((c) => c.sku === 'USD-1')!.product_id));
    expect(usd.variants[0].price_minor).toBeNull();
    expect(usd.images).toEqual([]);
    // The existing ASH-60 product and its price are untouched; a second import creates nothing.
    expect((await app(asAdmin, (tx) => getShopProduct(tx, accountA, productId))).variants.find((v) => v.sku === 'ASH-60')!.price_minor).toBe(49900);
    expect((await app(asAdmin, (tx) => importFromMeta(tx, accountA, adminA, { meta_product_ids: [metaFresh] }))).created).toEqual([]);
    await db.query(`INSERT INTO products(id,account_id,catalog_row_id,retailer_id,name) VALUES($1,$2,$3,'AGENT-1','Agent try')`,
      [metaAgent, accountA, catalogRow]);
    expect(await codeOf(app(asAgent, (tx) => importFromMeta(tx, accountA, agentA, { meta_product_ids: [metaAgent] })))).not.toBe('ok');
  });

  it('archives and restores a product', async () => {
    const archived = await app(asAdmin, (tx) => archiveProduct(tx, accountA, adminA, productId, true));
    expect(archived.status).toBe('archived');
    expect((await app(asAgent, (tx) => listShopProducts(tx, accountA, { q: 'ashwagandha' }))).total).toBe(0);
    expect((await app(asAgent, (tx) => listShopProducts(tx, accountA, { q: 'ashwagandha', status: 'archived' }))).total).toBe(1);
    expect((await app(asAdmin, (tx) => archiveProduct(tx, accountA, adminA, productId, false))).status).toBe('draft');
  });
});
