import { randomUUID } from 'node:crypto';
import { config } from 'dotenv';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { disconnectDatabases, getPrisma, getWorkerPrisma } from '@/lib/db/prisma';
import { withTenant, type TenantTransaction } from '@/lib/db/tenant';
import { encrypt } from '@/lib/whatsapp/encryption';
import type { MetaCatalogItemUpdate } from '@/lib/whatsapp/meta-api';
import { pushCatalogChanges, type CatalogUpdater } from './catalog-push';
import { getStoreSettings, parseStoreSettings, saveStoreSettings } from './store-settings';

// Audit finding 20 on PostgreSQL: price, stock and status changes of a variant linked to a Meta
// catalogue item queue one push per workspace per minute (database triggers, any role), and the push
// sends only differences, records them in the mirror, and never touches unlinked items or other workspaces.
const configured = config({ path: '.env.test', quiet: true }).parsed;
const ownerUrl = process.env.TEST_DATABASE_URL;
const appUrl = process.env.TEST_APP_DATABASE_URL || configured?.DATABASE_URL;
const workerUrl = process.env.TEST_WORKER_DATABASE_URL || configured?.WORKER_DATABASE_URL;
if (appUrl) process.env.DATABASE_URL = appUrl;
if (workerUrl) process.env.WORKER_DATABASE_URL = workerUrl;
process.env.ENCRYPTION_KEY ??= 'a'.repeat(64);

const accountA = randomUUID(), accountB = randomUUID(), ownerA = randomUUID(), ownerB = randomUUID();
const productA = randomUUID(), linked = randomUUID(), unlinked = randomUUID(), productB = randomUUID(), variantB = randomUUID();
const seed = String(Date.now()).slice(-9);
let db: pg.Client;
let catalogRow = '';

const pushJobs = async (account: string) => (await db.query(
  "SELECT dedupe_key, run_at FROM jobs WHERE type='commerce.catalog_push' AND tenant_id=$1 ORDER BY dedupe_key", [account])).rows;
const mirror = async (sku: string) => (await db.query(
  'SELECT price_minor::int AS price, currency, availability FROM products WHERE account_id=$1 AND retailer_id=$2', [accountA, sku])).rows[0];
const fakeMeta = () => {
  const calls: { catalogId: string; accessToken: string; items: MetaCatalogItemUpdate[] }[] = [];
  const update = vi.fn(async (args: { catalogId: string; accessToken: string; items: MetaCatalogItemUpdate[] }) => {
    calls.push(args);
    return { handles: ['h1'] };
  }) as unknown as CatalogUpdater;
  return { update, calls };
};

describe.skipIf(!ownerUrl || !appUrl || !workerUrl)('Meta catalogue push on PostgreSQL (audit finding 20)', { timeout: 120_000 }, () => {
  beforeAll(async () => {
    db = new pg.Client({ connectionString: ownerUrl });
    await db.connect();
    if (!/test/i.test((await db.query('SELECT current_database() AS name')).rows[0].name)) throw new Error('Requires an isolated test database');
    const role = await getPrisma().$queryRaw<{ role: string }[]>`SELECT current_user AS role`;
    if (role[0].role !== 'bodhinox_app') throw new Error('Requires constrained test app credentials');
    await db.query("INSERT INTO auth_users(id,email,full_name,password_hash) SELECT x, x::text || '@example.invalid', 'Push test', 'test-only-hash' FROM unnest($1::uuid[]) x", [[ownerA, ownerB]]);
    await db.query("INSERT INTO accounts(id,name,owner_user_id) VALUES($1,'Push A',$2),($3,'Push B',$4)", [accountA, ownerA, accountB, ownerB]);
    await db.query("INSERT INTO account_memberships(account_id,user_id,role) VALUES($1,$2,'owner'),($3,$4,'owner')", [accountA, ownerA, accountB, ownerB]);
    const number = (await db.query(
      "INSERT INTO whatsapp_config(account_id,user_id,phone_number_id,waba_id,access_token,status,is_default) VALUES($1,$2,$3,$4,$5,'connected',true) RETURNING id",
      [accountA, ownerA, `91${seed}`, `92${seed}`, encrypt('test-only-token')])).rows[0].id;
    catalogRow = (await db.query('INSERT INTO whatsapp_catalogs(account_id,whatsapp_config_id,catalog_id) VALUES($1,$2,$3) RETURNING id',
      [accountA, number, `93${seed}`])).rows[0].id;
    // The mirror as the last sync read it: PUSH-1 in stock at 1299.00, and a Meta item no variant matches.
    await db.query(`INSERT INTO products(account_id,catalog_row_id,retailer_id,name,price_minor,currency,availability) VALUES
      ($1,$2,'PUSH-1','Linked',129900,'INR','in stock'),($1,$2,'META-ONLY','Meta only',5000,'INR','in stock')`, [accountA, catalogRow]);
    for (const account of [accountA, accountB])
      await db.query(`INSERT INTO commerce_settings(account_id,currency,prices_include_tax,default_tax_rate_bps,checkout_enabled,reservation_minutes)
        VALUES($1,'INR',true,0,true,30)`, [account]);
    await db.query("INSERT INTO shop_products(id,account_id,name,status,content_reviewed_at) VALUES($1,$2,'Shoe','published',now())", [productA, accountA]);
    // B sells a variant with the same SKU but has no catalogue: nothing of B is ever queued or pushed.
    await db.query("INSERT INTO shop_products(id,account_id,name,status,content_reviewed_at) VALUES($1,$2,'Shoe','published',now())", [productB, accountB]);
    await db.query("INSERT INTO shop_variants(id,account_id,product_id,sku,price_minor) VALUES($1,$2,$3,'PUSH-1',129900)", [variantB, accountB, productB]);
  });
  beforeEach(async () => {
    await db.query("DELETE FROM jobs WHERE type='commerce.catalog_push' AND tenant_id=ANY($1::uuid[])", [[accountA, accountB]]);
  });
  afterAll(async () => {
    if (db) {
      await db.query('DELETE FROM jobs WHERE tenant_id=ANY($1::uuid[])', [[accountA, accountB]]);
      await db.query('DELETE FROM accounts WHERE id=ANY($1::uuid[])', [[accountA, accountB]]);
      await db.query('DELETE FROM auth_users WHERE id=ANY($1::uuid[])', [[ownerA, ownerB]]);
      await db.end();
    }
    await disconnectDatabases();
  });

  it('queues one push per minute when a linked variant is added or repriced, from the app role, and none for unlinked SKUs', async () => {
    await db.query("INSERT INTO shop_variants(id,account_id,product_id,sku,price_minor) VALUES($1,$2,$3,'NOT-IN-META',100)", [unlinked, accountA, productA]);
    expect(await pushJobs(accountA)).toEqual([]);
    await db.query("INSERT INTO shop_variants(id,account_id,product_id,sku,price_minor) VALUES($1,$2,$3,'PUSH-1',129900)", [linked, accountA, productA]);
    const queued = await pushJobs(accountA);
    expect(queued).toHaveLength(1);
    expect(queued[0].dedupe_key).toMatch(new RegExp(`^catalog-push:${accountA}:\\d+$`));
    // It runs after the minute ends, so later changes in the same minute are read by the same push.
    expect(new Date(queued[0].run_at).getUTCSeconds()).toBe(0);
    expect(new Date(queued[0].run_at).getTime()).toBeGreaterThan(Date.now() - 1000);
    // A price change by an admin through the app role (RLS) queues it too.
    await db.query("DELETE FROM jobs WHERE type='commerce.catalog_push' AND tenant_id=$1", [accountA]);
    await withTenant({ accountId: accountA, userId: ownerA, role: 'owner' }, (tx) =>
      tx.$executeRaw`UPDATE shop_variants SET price_minor=139900 WHERE account_id=${accountA}::uuid AND id=${linked}::uuid`);
    expect(await pushJobs(accountA)).toHaveLength(1);
    // Many changes in one minute make one job (now() is fixed within a transaction, so this is deterministic).
    await db.query("DELETE FROM jobs WHERE type='commerce.catalog_push' AND tenant_id=$1", [accountA]);
    await db.query('BEGIN');
    await db.query('UPDATE shop_variants SET price_minor=145000 WHERE id=$1', [linked]);
    await db.query('UPDATE shop_variants SET price_minor=149900 WHERE id=$1', [linked]);
    await db.query('UPDATE shop_variants SET archived_at=now() WHERE id=$1', [linked]);
    await db.query('UPDATE shop_variants SET archived_at=NULL WHERE id=$1', [linked]);
    await db.query('COMMIT');
    expect(await pushJobs(accountA)).toHaveLength(1);
    // A change that cannot move price or availability queues nothing.
    await db.query("DELETE FROM jobs WHERE type='commerce.catalog_push' AND tenant_id=$1", [accountA]);
    await db.query('UPDATE shop_variants SET weight_grams=250 WHERE id=$1', [linked]);
    await db.query('UPDATE shop_variants SET price_minor=price_minor WHERE id=$1', [unlinked]);
    expect(await pushJobs(accountA)).toEqual([]);
    expect(await pushJobs(accountB)).toEqual([]);
  });

  it('pushes only the differences, records them in the mirror and sends nothing the second time', async () => {
    const meta = fakeMeta();
    // PUSH-1 now costs 1499.00 and tracks stock with none on hand: out of stock.
    expect(await pushCatalogChanges(accountA, meta.update)).toEqual({ catalogs: 1, pushed: 1, skipped: 0 });
    expect(meta.calls).toEqual([{ catalogId: `93${seed}`, accessToken: 'test-only-token',
      items: [{ retailerId: 'PUSH-1', price: '1499.00 INR', availability: 'out of stock' }] }]);
    expect(await mirror('PUSH-1')).toEqual({ price: 149900, currency: 'INR', availability: 'out of stock' });
    expect(await mirror('META-ONLY')).toEqual({ price: 5000, currency: 'INR', availability: 'in stock' });
    const again = fakeMeta();
    expect(await pushCatalogChanges(accountA, again.update)).toMatchObject({ pushed: 0 });
    expect(again.calls).toEqual([]);
    // Another workspace is never pushed (B has no catalogue, and A's push reads A only).
    expect(await pushCatalogChanges(accountB, again.update)).toEqual({ catalogs: 0, pushed: 0, skipped: 0 });
  });

  it('queues a push when stock comes in or sells out (worker role), not on every stock move', async () => {
    const worker = (sql: (tx: TenantTransaction) => Promise<unknown>) =>
      withTenant({ accountId: accountA, role: 'owner' }, sql, getWorkerPrisma());
    await worker((tx) => tx.$executeRaw`INSERT INTO inventory_levels(account_id,variant_id,on_hand) VALUES(${accountA}::uuid,${linked}::uuid,0)`);
    expect(await pushJobs(accountA)).toHaveLength(1);
    await db.query("DELETE FROM jobs WHERE type='commerce.catalog_push' AND tenant_id=$1", [accountA]);
    await worker((tx) => tx.$executeRaw`UPDATE inventory_levels SET on_hand=5 WHERE account_id=${accountA}::uuid AND variant_id=${linked}::uuid`);
    expect(await pushJobs(accountA)).toHaveLength(1);
    const meta = fakeMeta();
    await pushCatalogChanges(accountA, meta.update);
    expect(meta.calls[0].items).toEqual([{ retailerId: 'PUSH-1', availability: 'in stock' }]);
    await db.query("DELETE FROM jobs WHERE type='commerce.catalog_push' AND tenant_id=$1", [accountA]);
    // 5 -> 3 on hand, 2 reserved: still available, nothing queued; all reserved: sold out, queued.
    await worker((tx) => tx.$executeRaw`UPDATE inventory_levels SET on_hand=3, reserved=2 WHERE account_id=${accountA}::uuid AND variant_id=${linked}::uuid`);
    expect(await pushJobs(accountA)).toEqual([]);
    await worker((tx) => tx.$executeRaw`UPDATE inventory_levels SET reserved=3 WHERE account_id=${accountA}::uuid AND variant_id=${linked}::uuid`);
    expect(await pushJobs(accountA)).toHaveLength(1);
  });

  it('pushes out of stock when the product is unpublished, and keeps the mirror unchanged when Meta refuses', async () => {
    await db.query("UPDATE inventory_levels SET reserved=0 WHERE account_id=$1 AND variant_id=$2", [accountA, linked]);
    await db.query("UPDATE products SET availability='in stock' WHERE account_id=$1 AND retailer_id='PUSH-1'", [accountA]);
    await db.query("DELETE FROM jobs WHERE type='commerce.catalog_push' AND tenant_id=$1", [accountA]);
    await db.query("UPDATE shop_products SET status='draft' WHERE id=$1", [productA]);
    expect(await pushJobs(accountA)).toHaveLength(1);
    const refusing = vi.fn(async () => { throw new Error('Meta API error: 403'); }) as unknown as CatalogUpdater;
    await expect(pushCatalogChanges(accountA, refusing)).rejects.toThrow('403');
    expect(await mirror('PUSH-1')).toMatchObject({ availability: 'in stock' });
    const meta = fakeMeta();
    await pushCatalogChanges(accountA, meta.update);
    expect(meta.calls[0].items).toEqual([{ retailerId: 'PUSH-1', availability: 'out of stock' }]);
  });

  it('leaves the Meta catalogue alone while checkout is off, and queues a push when an admin turns checkout on', async () => {
    const admin = { accountId: accountA, userId: ownerA, role: 'owner' as const };
    const save = async (checkout: boolean) => {
      const current = await getStoreSettings(admin);
      await saveStoreSettings(admin, parseStoreSettings({ ...current, checkout_enabled: checkout }));
    };
    await save(false);
    await db.query("UPDATE shop_products SET status='published' WHERE id=$1", [productA]);
    const meta = fakeMeta();
    // Published and in stock again, but WhatsApp orders are handled by hand: Meta's catalogue is the seller's own.
    expect(await pushCatalogChanges(accountA, meta.update)).toEqual({ catalogs: 0, pushed: 0, skipped: 0 });
    expect(meta.calls).toEqual([]);
    await db.query("DELETE FROM jobs WHERE type='commerce.catalog_push' AND tenant_id=$1", [accountA]);
    await save(true);
    expect(await pushJobs(accountA)).toHaveLength(1);
    await pushCatalogChanges(accountA, meta.update);
    expect(meta.calls[0].items).toEqual([{ retailerId: 'PUSH-1', availability: 'in stock' }]);
  });
});
