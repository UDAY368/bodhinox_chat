import { randomUUID } from 'node:crypto';
import { config } from 'dotenv';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { disconnectDatabases, getPrisma } from '@/lib/db/prisma';
import { withTenant, type TenantContext } from '@/lib/db/tenant';
import { CatalogueError, createCategory, getShopProduct } from './products';
import { bulkUpdateProducts, saveProductForm } from './product-form';
import { setStockLevels } from './inventory';

// Batch 4: the one-page product form and the list's bulk actions on PostgreSQL.
// A new product gets its default variant and a generated, account-unique SKU in
// the same transaction; the options matrix is written (and old rows archived) in
// one transaction; the typed stock goes through the worker with a stale-count
// check; bulk actions are admin-only and never touch another account's products.
const configured = config({ path: '.env.test', quiet: true }).parsed;
const ownerUrl = process.env.TEST_DATABASE_URL;
const appUrl = process.env.TEST_APP_DATABASE_URL || configured?.DATABASE_URL;
const workerUrl = process.env.TEST_WORKER_DATABASE_URL || configured?.WORKER_DATABASE_URL;
if (appUrl) process.env.DATABASE_URL = appUrl;
if (workerUrl) process.env.WORKER_DATABASE_URL = workerUrl;

const accountA = randomUUID(), accountB = randomUUID();
const ownerA = randomUUID(), adminA = randomUUID(), agentA = randomUUID(), ownerB = randomUUID();
const users = [ownerA, adminA, agentA, ownerB];
const asAdmin = { accountId: accountA, userId: adminA, role: 'admin' } as const;
const asAgent: TenantContext = { accountId: accountA, userId: agentA, role: 'agent' };
const asOwnerB = { accountId: accountB, userId: ownerB, role: 'owner' } as const;
let db: pg.Client;

const app = <T,>(ctx: TenantContext, fn: Parameters<typeof withTenant<T>>[1]) => withTenant(ctx, fn);
const codeOf = (p: Promise<unknown>) => p.then(() => 'ok', (e) => (e instanceof CatalogueError ? e.code : String(e?.message ?? e)));
const save = (ctx: typeof asAdmin | typeof asOwnerB, id: string | null, body: unknown) =>
  app(ctx, (tx) => saveProductForm(tx, ctx.accountId, ctx.userId, id, body));

describe.skipIf(!ownerUrl || !appUrl || !workerUrl)('batch 4 product form on PostgreSQL', { timeout: 120_000 }, () => {
  beforeAll(async () => {
    db = new pg.Client({ connectionString: ownerUrl });
    await db.connect();
    if (!/test/i.test((await db.query('SELECT current_database() AS name')).rows[0].name)) throw new Error('Requires an isolated test database');
    const role = await getPrisma().$queryRaw<{ role: string }[]>`SELECT current_user AS role`;
    if (role[0].role !== 'bodhinox_app') throw new Error('Requires constrained test app credentials');
    await db.query("INSERT INTO auth_users(id,email,full_name,password_hash) SELECT x, x::text || '@example.invalid', 'B4 form', 'test-only-hash' FROM unnest($1::uuid[]) x", [users]);
    await db.query("INSERT INTO accounts(id,name,owner_user_id) VALUES($1,'Form A',$2),($3,'Form B',$4)", [accountA, ownerA, accountB, ownerB]);
    await db.query("INSERT INTO account_subscriptions(account_id,plan_id) VALUES($1,'basic'),($2,'basic')", [accountA, accountB]);
    await db.query(`INSERT INTO account_memberships(account_id,user_id,role) VALUES ($1,$2,'owner'),($1,$3,'admin'),($1,$4,'agent'),($5,$6,'owner')`,
      [accountA, ownerA, adminA, agentA, accountB, ownerB]);
    await db.query(`INSERT INTO commerce_settings(account_id,currency) VALUES($1,'INR'),($2,'INR')`, [accountA, accountB]);
  });

  afterAll(async () => {
    if (db) {
      await db.query('DELETE FROM accounts WHERE id=ANY($1::uuid[])', [[accountA, accountB]]);
      await db.query('DELETE FROM auth_users WHERE id=ANY($1::uuid[])', [users]);
      await db.end();
    }
    await disconnectDatabases();
  });

  let teeId = '';

  it('creates a product with its default variant and a generated SKU in one save', async () => {
    const { product, stock } = await save(asAdmin, null, { name: 'Cotton Tee' });
    expect(product.variants).toHaveLength(1);
    expect(product.variants[0]).toMatchObject({ sku: 'COTTON-TEE', option_values: {}, archived: false });
    expect(stock).toEqual([]);
    // The same name again gets the next free SKU; another account may reuse the first.
    const second = await save(asAdmin, null, { name: 'Cotton tee', variants: [{ price_minor: 49900, compare_at_minor: 59900, stock: 4 }] });
    expect(second.product.variants[0]).toMatchObject({ sku: 'COTTON-TEE-2', price_minor: 49900, compare_at_minor: 59900 });
    expect(second.stock).toEqual([{ variantId: second.product.variants[0].id, expectedOnHand: 0, onHand: 4 }]);
    await setStockLevels(asAdmin, second.stock);
    expect((await app(asAdmin, (tx) => getShopProduct(tx, accountA, second.product.id))).variants[0].on_hand).toBe(4);
    expect((await save(asOwnerB, null, { name: 'Cotton Tee' })).product.variants[0].sku).toBe('COTTON-TEE');
    // A failing variant rolls the product back too (one transaction).
    const before = await db.query('SELECT count(*)::int AS n FROM shop_products WHERE account_id=$1', [accountA]);
    expect(await codeOf(save(asAdmin, null, { name: 'Broken', variants: [{ sku: 'COTTON-TEE' }] }))).toBe('sku_taken');
    expect((await db.query('SELECT count(*)::int AS n FROM shop_products WHERE account_id=$1', [accountA])).rows[0].n).toBe(before.rows[0].n);
    // An agent cannot create (RLS), and nothing is left behind.
    expect(await codeOf(app(asAgent, (tx) => saveProductForm(tx, accountA, agentA, null, { name: 'Sneaky' })))).not.toBe('ok');
    teeId = second.product.id;
  });

  it('writes the options matrix: the plain variant becomes the first row, new rows get SKUs, removed rows are archived', async () => {
    const tee = await app(asAdmin, (tx) => getShopProduct(tx, accountA, teeId));
    const plain = tee.variants[0];
    const { product } = await save(asAdmin, teeId, {
      version: tee.version,
      variants: [
        { id: plain.id, option_values: { Size: 'S', Colour: 'Red' }, price_minor: 49900, stock: 4, expected_on_hand: 4 },
        { option_values: { Size: 'S', Colour: 'Blue' }, price_minor: 49900 },
        { option_values: { Size: 'M', Colour: 'Red' }, price_minor: 52900, sku: 'TEE-M-RED' },
      ],
    });
    const active = product.variants.filter((v) => !v.archived);
    expect(active.map((v) => [v.option_values, v.sku, v.position])).toEqual([
      [{ Size: 'S', Colour: 'Red' }, 'COTTON-TEE-2', 0],
      [{ Size: 'S', Colour: 'Blue' }, 'COTTON-TEE-S-BLUE', 1],
      [{ Size: 'M', Colour: 'Red' }, 'TEE-M-RED', 2],
    ]);
    expect(active[0].id).toBe(plain.id);
    expect(active[0].on_hand).toBe(4);
    // Removing Blue archives that variant (kept for orders); a stale version is refused; duplicates are refused.
    const next = await save(asAdmin, teeId, {
      version: product.version,
      variants: [active[0], active[2]].map((v) => ({ id: v.id, option_values: v.option_values, price_minor: v.price_minor })),
    });
    expect(next.product.variants.find((v) => v.id === active[1].id)?.archived).toBe(true);
    expect(next.product.variants.filter((v) => !v.archived)).toHaveLength(2);
    expect(await codeOf(save(asAdmin, teeId, { version: product.version, variants: [{ id: active[0].id }] }))).toBe('conflict');
    expect(await codeOf(save(asAdmin, teeId, { variants: [{ option_values: { Size: 'L' } }, { option_values: { size: 'l' } }] }))).toBe('invalid');
    // Typing Blue again restores the archived variant with its SKU.
    const restored = await save(asAdmin, teeId, {
      variants: [...next.product.variants.filter((v) => !v.archived), next.product.variants.find((v) => v.archived)!]
        .map((v) => ({ id: v.id, option_values: v.option_values, price_minor: v.price_minor })),
    });
    expect(restored.product.variants.filter((v) => !v.archived).map((v) => v.sku)).toContain('COTTON-TEE-S-BLUE');
  });

  it('keeps variants to this product and this account', async () => {
    const other = await save(asAdmin, null, { name: 'Other' });
    expect(await codeOf(save(asAdmin, teeId, { variants: [{ id: other.product.variants[0].id }] }))).toBe('invalid');
    // Account B cannot see or write account A's product.
    expect(await codeOf(save(asOwnerB, teeId, { name: 'Taken', variants: [{}] }))).toBe('not_found');
  });

  it('refuses stock that moved since the form was read', async () => {
    const tee = await app(asAdmin, (tx) => getShopProduct(tx, accountA, teeId));
    const red = tee.variants.find((v) => !v.archived && v.on_hand === 4)!;
    expect(await codeOf(setStockLevels(asAdmin, [{ variantId: red.id, expectedOnHand: 9, onHand: 1 }]))).toBe('stock_changed');
    await setStockLevels(asAdmin, [{ variantId: red.id, expectedOnHand: 4, onHand: 1 }]);
    expect((await app(asAdmin, (tx) => getShopProduct(tx, accountA, teeId))).variants.find((v) => v.id === red.id)!.on_hand).toBe(1);
  });

  it('runs bulk actions for admins over their own account only', async () => {
    const cat = await app(asAdmin, (tx) => createCategory(tx, accountA, adminA, { name: 'Tops' }));
    const unpriced = (await save(asAdmin, null, { name: 'No price yet' })).product;
    const foreign = (await save(asOwnerB, null, { name: 'B only', variants: [{ price_minor: 100 }] })).product;
    const bulk = (body: unknown, ctx: typeof asAdmin | TenantContext = asAdmin) =>
      app(ctx, (tx) => bulkUpdateProducts(tx, ctx.accountId, ctx.userId!, body));

    expect(await bulk({ action: 'live', ids: [teeId, unpriced.id, foreign.id] })).toEqual({ changed: 1, skipped: 2 });
    expect((await app(asAdmin, (tx) => getShopProduct(tx, accountA, teeId))).status).toBe('published');
    expect((await app(asOwnerB, (tx) => getShopProduct(tx, accountB, foreign.id))).status).toBe('draft');

    expect(await bulk({ action: 'category', ids: [teeId, unpriced.id, foreign.id], category_id: cat.id })).toEqual({ changed: 2, skipped: 1 });
    expect((await app(asOwnerB, (tx) => getShopProduct(tx, accountB, foreign.id))).category_id).toBeNull();
    // Another account's category is refused.
    const catB = await app(asOwnerB, (tx) => createCategory(tx, accountB, ownerB, { name: 'B cat' }));
    expect(await codeOf(bulk({ action: 'category', ids: [teeId], category_id: catB.id }))).toBe('invalid');

    expect(await bulk({ action: 'hidden', ids: [teeId] })).toEqual({ changed: 1, skipped: 0 });
    expect(await bulk({ action: 'archive', ids: [unpriced.id, foreign.id] })).toEqual({ changed: 1, skipped: 1 });
    expect((await app(asOwnerB, (tx) => getShopProduct(tx, accountB, foreign.id))).status).toBe('draft');

    // An agent changes nothing (the route refuses the role first; RLS underneath writes no row), and the input is capped and checked.
    await codeOf(bulk({ action: 'live', ids: [teeId] }, asAgent));
    expect((await app(asAdmin, (tx) => getShopProduct(tx, accountA, teeId))).status).toBe('draft');
    expect(await codeOf(bulk({ action: 'live', ids: Array.from({ length: 101 }, () => randomUUID()) }))).toBe('invalid');
    expect(await codeOf(bulk({ action: 'delete', ids: [teeId] }))).toBe('invalid');
    const audits = await db.query("SELECT count(*)::int AS n FROM audit_logs WHERE account_id=$1 AND action LIKE 'commerce.products_bulk_%'", [accountA]);
    expect(audits.rows[0].n).toBe(5);
  });
});
