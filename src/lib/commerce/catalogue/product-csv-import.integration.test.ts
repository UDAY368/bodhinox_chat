import { randomUUID } from 'node:crypto';
import { config } from 'dotenv';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { disconnectDatabases, getPrisma } from '@/lib/db/prisma';
import { withTenant, type TenantContext } from '@/lib/db/tenant';
import { enqueueJob } from '@/lib/jobs/queue';
import { createCategory, upsertProduct, upsertVariant } from './products';
import { parseCsv, toCsv } from './product-csv';
import {
  exportProductsCsv, handleProductImportJob, importInline, listImportJobs, PRODUCT_IMPORT_JOB, queueImport, prepareImport,
} from './product-csv-import';

// Store plan Phase 4 (package 2) on PostgreSQL: product CSV import and export. Matching is by SKU inside
// one workspace only, a bad row never blocks the good ones, an import can be replayed without duplicates,
// only admins can import, and the queued path survives a restart and a lost admin role.
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
const asAdmin = { accountId: accountA, userId: adminA, role: 'admin' } as TenantContext & { userId: string };
const asAgent = { accountId: accountA, userId: agentA, role: 'agent' } as TenantContext & { userId: string };
const asViewer = { accountId: accountA, userId: viewerA, role: 'viewer' } as TenantContext & { userId: string };
const asOwnerB = { accountId: accountB, userId: ownerB, role: 'owner' } as TenantContext & { userId: string };
let db: pg.Client;

const HEADER = ['sku', 'name', 'description', 'category', 'tags', 'brand', 'product_type', 'status', 'options', 'price', 'compare_at_price', 'stock',
  'track_inventory', 'weight_grams', 'image_urls'];
/** A CSV from partial rows (missing columns are blank). */
const csv = (rows: Record<string, string>[]) => toCsv([HEADER, ...rows.map((r) => HEADER.map((h) => r[h] ?? ''))]);
const count = async (sql: string, values: unknown[]) => Number((await db.query(sql, values)).rows[0].n);

describe.skipIf(!ownerUrl || !appUrl || !workerUrl)('store plan phase 4: product CSV import on PostgreSQL', { timeout: 300_000 }, () => {
  beforeAll(async () => {
    db = new pg.Client({ connectionString: ownerUrl });
    await db.connect();
    if (!/test/i.test((await db.query('SELECT current_database() AS name')).rows[0].name)) throw new Error('Requires an isolated test database');
    const role = await getPrisma().$queryRaw<{ role: string }[]>`SELECT current_user AS role`;
    if (role[0].role !== 'bodhinox_app') throw new Error('Requires constrained test app credentials');
    await db.query("INSERT INTO auth_users(id,email,full_name,password_hash) SELECT x, x::text || '@example.invalid', 'P4 csv', 'test-only-hash' FROM unnest($1::uuid[]) x", [users]);
    await db.query("INSERT INTO accounts(id,name,owner_user_id) VALUES($1,'P4 CSV A',$2),($3,'P4 CSV B',$4)", [accountA, ownerA, accountB, ownerB]);
    await db.query("INSERT INTO account_subscriptions(account_id,plan_id) VALUES($1,'basic'),($2,'basic')", [accountA, accountB]);
    await db.query(`INSERT INTO account_memberships(account_id,user_id,role) VALUES ($1,$2,'owner'),($1,$3,'admin'),($1,$4,'agent'),($1,$5,'viewer'),($6,$7,'owner')`,
      [accountA, ownerA, adminA, agentA, viewerA, accountB, ownerB]);
    await db.query(`INSERT INTO commerce_settings(account_id,currency,default_tax_rate_bps) VALUES($1,'INR',1800),($2,'INR',1800)`, [accountA, accountB]);
    await withTenant(asAdmin, (tx) => createCategory(tx, accountA, adminA, { name: 'Oils' }));
    // Workspace B owns a product whose SKU workspace A will also use.
    await withTenant(asOwnerB, async (tx) => {
      const p = await upsertProduct(tx, accountB, ownerB, null, { name: 'B original' });
      await upsertVariant(tx, accountB, ownerB, p.id, null, { sku: 'CSV-SHARED', price_minor: 11100 });
    });
  });

  afterAll(async () => {
    if (db) {
      await db.query('DELETE FROM jobs WHERE tenant_id=ANY($1::uuid[])', [[accountA, accountB]]);
      await db.query('DELETE FROM accounts WHERE id=ANY($1::uuid[])', [[accountA, accountB]]);
      await db.query('DELETE FROM auth_users WHERE id=ANY($1::uuid[])', [users]);
      await db.end();
    }
    await disconnectDatabases();
  });

  it('imports a small file inline as drafts, skips only the bad rows, and the same file again duplicates nothing', async () => {
    const file = csv([
      { sku: 'CSV-T1', name: 'Tee', description: 'Soft', category: 'Oils', tags: 'Gift|summer', brand: 'Acme', options: 'Size=S', price: '499.00', stock: '10', image_urls: 'https://img.example/t.png' },
      { sku: 'CSV-T2', name: 'Tee', options: 'Size=M', price: '549', compare_at_price: '699' },
      { sku: 'CSV-HAT', name: 'Hat', status: 'published', price: '100', stock: '3' },
      { sku: 'CSV-BAD', name: 'Broken', price: 'abc' },
      { sku: 'CSV-NONAME', price: '5' },
      { sku: 'CSV-CAT', name: 'Lost', category: 'Nope', price: '5' },
    ]);
    const first = await importInline(asAdmin, file);
    expect(first).toMatchObject({ mode: 'inline', created: 3, updated: 0, error_count: 3 });
    expect(first.errors).toEqual([{ row: 5, field: 'price', code: 'invalid' }, { row: 6, field: 'name', code: 'name_required' }, { row: 7, field: 'category', code: 'unknown_category' }]);

    const tee = (await db.query("SELECT id, status, brand, tags, description, category_id FROM shop_products WHERE account_id=$1 AND name='Tee'", [accountA])).rows;
    expect(tee).toHaveLength(1);
    expect(tee[0]).toMatchObject({ status: 'draft', brand: 'Acme', tags: ['gift', 'summer'], description: 'Soft' });
    expect(tee[0].category_id).not.toBeNull();
    const variants = (await db.query('SELECT sku, price_minor, compare_at_minor, option_values FROM shop_variants WHERE product_id=$1 ORDER BY sku', [tee[0].id])).rows;
    expect(variants.map((v) => [v.sku, Number(v.price_minor), v.compare_at_minor === null ? null : Number(v.compare_at_minor)])).toEqual([['CSV-T1', 49900, null], ['CSV-T2', 54900, 69900]]);
    expect((await db.query('SELECT url FROM shop_product_images WHERE product_id=$1', [tee[0].id])).rows).toEqual([{ url: 'https://img.example/t.png' }]);
    expect((await db.query("SELECT status FROM shop_products WHERE account_id=$1 AND name='Hat'", [accountA])).rows[0].status).toBe('published');
    expect(await count("SELECT count(*) AS n FROM shop_products WHERE account_id=$1 AND name IN ('Broken','Lost')", [accountA])).toBe(0);
    const stock = (await db.query("SELECT v.sku, l.on_hand FROM inventory_levels l JOIN shop_variants v ON v.id=l.variant_id WHERE l.account_id=$1 ORDER BY v.sku", [accountA])).rows;
    expect(stock).toEqual([{ sku: 'CSV-HAT', on_hand: 3 }, { sku: 'CSV-T1', on_hand: 10 }]);

    // The same file again: every good row is an update, no new product or variant, no stock movement.
    const movements = await count("SELECT count(*) AS n FROM inventory_movements WHERE account_id=$1", [accountA]);
    const again = await importInline(asAdmin, file);
    expect(again).toMatchObject({ created: 0, updated: 3, error_count: 3 });
    expect(await count("SELECT count(*) AS n FROM shop_products WHERE account_id=$1 AND name IN ('Tee','Hat')", [accountA])).toBe(2);
    expect(await count("SELECT count(*) AS n FROM shop_variants WHERE account_id=$1 AND sku LIKE 'CSV-%'", [accountA])).toBe(3);
    expect(await count("SELECT count(*) AS n FROM inventory_movements WHERE account_id=$1", [accountA])).toBe(movements);

    // A changed count is applied as the difference; blank cells leave everything else alone.
    await importInline(asAdmin, csv([{ sku: 'CSV-T1', stock: '4' }]));
    expect((await db.query("SELECT l.on_hand FROM inventory_levels l JOIN shop_variants v ON v.id=l.variant_id WHERE v.account_id=$1 AND v.sku='CSV-T1'", [accountA])).rows[0].on_hand).toBe(4);
    const kept = (await db.query("SELECT p.description, v.price_minor FROM shop_variants v JOIN shop_products p ON p.id=v.product_id WHERE v.account_id=$1 AND v.sku='CSV-T1'", [accountA])).rows[0];
    expect(kept.description).toBe('Soft');
    expect(Number(kept.price_minor)).toBe(49900);

    // The audit trail holds counts, never names or file text.
    const audits = (await db.query("SELECT metadata FROM audit_logs WHERE account_id=$1 AND action='commerce.products_csv_imported'", [accountA])).rows;
    expect(audits.length).toBeGreaterThanOrEqual(3);
    expect(JSON.stringify(audits)).not.toMatch(/Tee|Hat|CSV-/);
  });

  it('matches SKUs inside one workspace only: a same-SKU product in another workspace is never read or changed', async () => {
    const file = csv([{ sku: 'CSV-SHARED', name: 'A version', price: '1.00' }]);
    const prepared = await withTenant(asAdmin, (tx) => prepareImport(tx, accountA, file));
    expect(prepared.existing.size).toBe(0);
    expect(prepared.plan.counts).toEqual({ create: 1, update: 0, newProducts: 1 });
    expect(await importInline(asAdmin, file)).toMatchObject({ created: 1, updated: 0, error_count: 0 });
    // B is untouched, A has its own product.
    const b = (await db.query("SELECT p.name, v.price_minor FROM shop_variants v JOIN shop_products p ON p.id=v.product_id WHERE v.account_id=$1 AND v.sku='CSV-SHARED'", [accountB])).rows;
    expect(b.map((r) => [r.name, Number(r.price_minor)])).toEqual([['B original', 11100]]);
    expect((await db.query("SELECT p.name FROM shop_variants v JOIN shop_products p ON p.id=v.product_id WHERE v.account_id=$1 AND v.sku='CSV-SHARED'", [accountA])).rows).toEqual([{ name: 'A version' }]);
    // A second import in A updates A's row; B still unchanged.
    expect(await importInline(asAdmin, csv([{ sku: 'CSV-SHARED', price: '2.00' }]))).toMatchObject({ created: 0, updated: 1 });
    expect(Number((await db.query("SELECT price_minor FROM shop_variants WHERE account_id=$1 AND sku='CSV-SHARED'", [accountB])).rows[0].price_minor)).toBe(11100);
    // And the other way round: B importing a SKU A owns creates B's own, never A's.
    expect(await importInline(asOwnerB, csv([{ sku: 'CSV-T1', name: 'B tee', price: '3' }]))).toMatchObject({ created: 1, updated: 0 });
    expect(Number((await db.query("SELECT price_minor FROM shop_variants WHERE account_id=$1 AND sku='CSV-T1'", [accountA])).rows[0].price_minor)).toBe(49900);
    // The export of each workspace holds its own rows only.
    const exportA = (await withTenant(asAdmin, (tx) => exportProductsCsv(tx, accountA))).csv;
    const exportB = (await withTenant(asOwnerB, (tx) => exportProductsCsv(tx, accountB))).csv;
    expect(exportA).toContain('CSV-T1');
    expect(exportA).not.toContain('B original');
    expect(exportA).not.toContain('B tee');
    expect(exportB).toContain('B original');
    expect(exportB).not.toContain('A version');
  });

  it('lets only admins write: an agent or viewer changes nothing and cannot queue or read import jobs', async () => {
    for (const ctx of [asAgent, asViewer]) {
      const result = await importInline(ctx, csv([{ sku: `CSV-DENIED-${ctx.role}`, name: 'Denied', price: '9' }]));
      expect(result.created).toBe(0);
      // Refused by the database (an agent) or by the store settings it cannot read (a viewer): one refused row either way.
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toMatchObject({ row: 2 });
      await expect(queueImport(ctx, csv([{ sku: 'CSV-DENIED-Q', name: 'Denied', price: '9' }]), 1)).rejects.toThrow();
    }
    expect(await count("SELECT count(*) AS n FROM shop_variants WHERE account_id=$1 AND sku LIKE 'CSV-DENIED%'", [accountA])).toBe(0);
    expect(await count("SELECT count(*) AS n FROM shop_import_jobs WHERE account_id=$1", [accountA])).toBe(0);
    // A job row exists for the admin; an agent sees none of it.
    const queued = await queueImport(asAdmin, csv([{ sku: 'CSV-ROLE', name: 'Role', price: '1' }]), 1);
    expect(await withTenant(asAgent, (tx) => listImportJobs(tx, accountA))).toEqual([]);
    expect(await withTenant(asAdmin, (tx) => listImportJobs(tx, accountA))).toHaveLength(1);
    // The uploaded file is never readable through the app role, not even by an admin.
    await expect(withTenant(asAdmin, (tx) => tx.$queryRaw`SELECT csv_text FROM shop_import_jobs WHERE id=${queued.import_id}::uuid`)).rejects.toThrow();
    // Cannot forge another member as the requester.
    await expect(withTenant(asAdmin, (tx) => tx.$executeRaw`INSERT INTO shop_import_jobs(account_id,requested_by,csv_text,total_rows)
      VALUES(${accountA}::uuid,${ownerA}::uuid,'x',1)`)).rejects.toThrow();
    // A job that never runs keeps the slot; clean it for the next test.
    await handleProductImportJob(accountA, { importId: queued.import_id }, { attempts: 1, maxAttempts: 5 });
    expect((await db.query('SELECT status FROM shop_import_jobs WHERE id=$1', [queued.import_id])).rows[0].status).toBe('done');
  });

  it('queues a big file, applies it in chunks, and a replay after a crash creates no duplicate products or variants', async () => {
    const rows: Record<string, string>[] = [];
    // One product whose 150 variants cross the 100-row chunk boundary, then 100 single products.
    for (let i = 0; i < 150; i++) rows.push({ sku: `Q-BIG-${i}`, name: 'Big tee', options: `Size=${i}`, price: '10', stock: String(i), ...(i === 0 ? { brand: 'BigCo' } : {}), ...(i === 149 ? { status: 'published' } : {}) });
    for (let i = 0; i < 100; i++) rows.push({ sku: `Q-ONE-${i}`, name: `One ${i}`, price: '5' });
    rows.push({ sku: 'Q-BAD', name: 'Bad one', price: 'x' });
    const file = csv(rows);

    const queued = await queueImport(asAdmin, file, rows.length);
    // One active import per workspace; a second queue is refused while the first is waiting.
    await expect(queueImport(asAdmin, csv([{ sku: 'Q-2', name: 'Two', price: '1' }]), 1)).rejects.toMatchObject({ code: 'import_running' });
    // The job is on the queue with a dedupe key: queueing the same id again changes nothing.
    const key = `${PRODUCT_IMPORT_JOB}:${queued.import_id}`;
    const again = await enqueueJob(PRODUCT_IMPORT_JOB, { importId: queued.import_id }, { tenantId: accountA, dedupeKey: key });
    expect(await count('SELECT count(*) AS n FROM jobs WHERE dedupe_key=$1', [key])).toBe(1);
    expect((await db.query('SELECT id::text AS id FROM jobs WHERE dedupe_key=$1', [key])).rows[0].id).toBe(again);

    const attempt = { attempts: 1, maxAttempts: 5 };
    await handleProductImportJob(accountA, { importId: queued.import_id }, attempt);
    const job = (await db.query('SELECT status, total_rows, processed_rows, created_count, updated_count, error_count, errors, csv_text FROM shop_import_jobs WHERE id=$1', [queued.import_id])).rows[0];
    expect(job).toMatchObject({ status: 'done', total_rows: 251, processed_rows: 251, created_count: 250, updated_count: 0, error_count: 1, csv_text: null });
    expect(job.errors).toEqual([{ row: 252, field: 'price', code: 'invalid' }]);
    const shape = async () => ({
      big: await count("SELECT count(*) AS n FROM shop_products WHERE account_id=$1 AND name='Big tee'", [accountA]),
      bigVariants: await count("SELECT count(*) AS n FROM shop_variants WHERE account_id=$1 AND sku LIKE 'Q-BIG-%'", [accountA]),
      singles: await count("SELECT count(*) AS n FROM shop_products WHERE account_id=$1 AND name LIKE 'One %'", [accountA]),
      onHand: await count("SELECT coalesce(sum(l.on_hand),0) AS n FROM inventory_levels l JOIN shop_variants v ON v.id=l.variant_id WHERE v.account_id=$1 AND v.sku LIKE 'Q-BIG-%'", [accountA]),
      movements: await count('SELECT count(*) AS n FROM inventory_movements WHERE account_id=$1', [accountA]),
    });
    const done = await shape();
    expect(done).toMatchObject({ big: 1, bigVariants: 150, singles: 100, onHand: (149 * 150) / 2 });
    expect((await db.query("SELECT status, brand FROM shop_products WHERE account_id=$1 AND name='Big tee'", [accountA])).rows[0]).toEqual({ status: 'published', brand: 'BigCo' });

    // A finished job is a no-op when delivered again.
    await handleProductImportJob(accountA, { importId: queued.import_id }, { attempts: 2, maxAttempts: 5 });
    expect(await shape()).toEqual(done);

    // The worker died after writing the products but before saving progress: put the job back at the start and run it again.
    await db.query("UPDATE shop_import_jobs SET status='queued', csv_text=$2, processed_rows=0, created_count=0, updated_count=0, error_count=0, errors='[]'::jsonb, completed_at=NULL WHERE id=$1",
      [queued.import_id, file]);
    await handleProductImportJob(accountA, { importId: queued.import_id }, { attempts: 2, maxAttempts: 5 });
    expect(await shape()).toEqual(done);
    expect((await db.query('SELECT status, created_count, updated_count, error_count FROM shop_import_jobs WHERE id=$1', [queued.import_id])).rows[0])
      .toEqual({ status: 'done', created_count: 0, updated_count: 250, error_count: 1 });

    // Halfway: one chunk already counted, the run restarts at row 101 and finishes the rest.
    const partial = csv(rows.slice(0, 120).map((r) => ({ ...r, sku: r.sku.replace('Q-BIG', 'Q-HALF'), name: 'Half tee' })));
    const q2 = await queueImport(asAdmin, partial, 120);
    await db.query("UPDATE shop_import_jobs SET processed_rows=100 WHERE id=$1", [q2.import_id]);
    await handleProductImportJob(accountA, { importId: q2.import_id }, attempt);
    // Rows 1-100 were never written (processed_rows was set by hand), rows 101-120 attach to a product made now.
    expect(await count("SELECT count(*) AS n FROM shop_variants WHERE account_id=$1 AND sku LIKE 'Q-HALF-%'", [accountA])).toBe(20);
    expect((await db.query('SELECT status, processed_rows FROM shop_import_jobs WHERE id=$1', [q2.import_id])).rows[0]).toEqual({ status: 'done', processed_rows: 120 });
  });

  it('stops a queued import when its admin has lost the role, and writes nothing', async () => {
    const queued = await queueImport(asAdmin, csv([{ sku: 'CSV-LOST', name: 'Lost role', price: '1' }]), 1);
    await db.query("UPDATE account_memberships SET role='agent' WHERE account_id=$1 AND user_id=$2", [accountA, adminA]);
    try {
      await handleProductImportJob(accountA, { importId: queued.import_id }, { attempts: 1, maxAttempts: 5 });
    } finally {
      await db.query("UPDATE account_memberships SET role='admin' WHERE account_id=$1 AND user_id=$2", [accountA, adminA]);
    }
    expect((await db.query('SELECT status, error_code, csv_text FROM shop_import_jobs WHERE id=$1', [queued.import_id])).rows[0])
      .toEqual({ status: 'failed', error_code: 'not_allowed', csv_text: null });
    expect(await count("SELECT count(*) AS n FROM shop_variants WHERE account_id=$1 AND sku='CSV-LOST'", [accountA])).toBe(0);
  });

  it('refuses a file the parser cannot read and records why, without touching the catalogue', async () => {
    const queued = await queueImport(asAdmin, 'sku,name\n"never closed,1', 1);
    await handleProductImportJob(accountA, { importId: queued.import_id }, { attempts: 1, maxAttempts: 5 });
    expect((await db.query('SELECT status, error_code, csv_text FROM shop_import_jobs WHERE id=$1', [queued.import_id])).rows[0])
      .toEqual({ status: 'failed', error_code: 'csv_unterminated_quote', csv_text: null });
  });

  it('exports every active variant with formulas defused, and the export imports back with nothing to change', async () => {
    await withTenant(asAdmin, async (tx) => {
      const p = await upsertProduct(tx, accountA, adminA, null, { name: '=HYPERLINK("http://x","y")', description: '-dash first' });
      await upsertVariant(tx, accountA, adminA, p.id, null, { sku: 'CSV-FORMULA', price_minor: 12345, option_values: { Size: 'M' } });
    });
    const { csv: text, rows } = await withTenant(asAdmin, (tx) => exportProductsCsv(tx, accountA));
    expect(rows).toBeGreaterThan(10);
    const records = parseCsv(text);
    const nameAt = records[0].indexOf('name');
    const line = records.find((r) => r[records[0].indexOf('sku')] === 'CSV-FORMULA')!;
    expect(line[nameAt]).toBe(`'=HYPERLINK("http://x","y")`);
    expect(line[records[0].indexOf('price')]).toBe('123.45');
    for (const record of records) for (const cell of record) expect(cell).not.toMatch(/^[=+\-@\t\r]/);
    // Round trip: nothing is created, nothing is refused.
    const result = await importInline(asAdmin, text);
    const dry = await withTenant(asAdmin, (tx) => prepareImport(tx, accountA, text));
    expect(dry.errors).toEqual([]);
    expect(dry.plan.counts.create).toBe(0);
    expect(result.created).toBe(0);
    expect(result.error_count).toBe(0);
    expect((await db.query("SELECT name, description FROM shop_products WHERE account_id=$1 AND id=(SELECT product_id FROM shop_variants WHERE sku='CSV-FORMULA' AND account_id=$1)", [accountA])).rows[0])
      .toEqual({ name: '=HYPERLINK("http://x","y")', description: '-dash first' });
  });
});
