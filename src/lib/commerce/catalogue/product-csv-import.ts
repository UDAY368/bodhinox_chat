/**
 * Product CSV import and export on the database (the pure part is product-csv.ts).
 *
 * Preview and a small import run inside the admin's request on the app role (RLS: admins write the
 * catalogue). A bigger file is stored in shop_import_jobs and queued; the worker applies it in
 * chunks of IMPORT_CHUNK rows, still on the app role as the requesting admin (the worker role has no
 * grants on the catalogue tables), after checking the requester is still an admin. Stock goes
 * through stock.adjustTx on the worker role, as everywhere else.
 *
 * Idempotent by construction: a row is matched by SKU, so a chunk that runs twice updates what it
 * created; stock is set to the file's number, so a second pass changes nothing. Row contents are
 * never logged, and errors carry the row, the column and a code only.
 */
import { getPrisma, getWorkerPrisma } from '@/lib/db/prisma';
import { withTenant, type TenantContext, type TenantTransaction } from '@/lib/db/tenant';
import { enqueueJob } from '@/lib/jobs/queue';
import { adjustTx, StockError } from '../stock';
import {
  archiveProduct, auditCatalogue, CatalogueError, getShopProduct, listCategories, publishProduct, unpublishProduct, upsertProduct, upsertVariant,
  type ProductStatus,
} from './products';
import {
  buildProductCsv, CsvError, IMPORT_CHUNK, INLINE_MAX_ROWS, MAX_CSV_BYTES, MAX_EXPORT_ROWS, MAX_REPORTED_ERRORS, parseProductCsv, planImport,
  validateRow, type ExistingSku, type ImportPlan, type ImportRow, type PlannedRow, type RowError,
} from './product-csv';

export const PRODUCT_IMPORT_JOB = 'commerce.product_import';

// ------------------------------------------------------------ export

/** Admin export: one row per active variant, every product status. At most MAX_EXPORT_ROWS rows. */
export async function exportProductsCsv(tx: TenantTransaction, accountId: string): Promise<{ csv: string; rows: number }> {
  const settings = await tx.$queryRaw<{ currency: string }[]>`SELECT currency FROM commerce_settings WHERE account_id=${accountId}::uuid`;
  const currency = settings[0]?.currency ?? null;
  const rows = await tx.$queryRaw<{
    sku: string; name: string; description: string | null; category: string | null; parent: string | null; tags: string[]; brand: string | null;
    product_type: string | null; status: string; option_values: Record<string, string> | null; price: bigint | null; compare_at: bigint | null;
    on_hand: number | null; track_inventory: boolean; weight_grams: number | null; urls: string[] | null;
  }[]>`
    SELECT v.sku, p.name, p.description, c.name AS category, pc.name AS parent, p.tags, p.brand, p.product_type, p.status, v.option_values,
      v.price_minor AS price, v.compare_at_minor AS compare_at, l.on_hand, v.track_inventory, v.weight_grams,
      (SELECT array_agg(i.url ORDER BY i.position) FROM shop_product_images i
        WHERE i.account_id=p.account_id AND i.product_id=p.id AND i.url IS NOT NULL) AS urls
    FROM shop_variants v
    JOIN shop_products p ON p.account_id=v.account_id AND p.id=v.product_id
    LEFT JOIN shop_categories c ON c.account_id=p.account_id AND c.id=p.category_id
    LEFT JOIN shop_categories pc ON pc.account_id=c.account_id AND pc.id=c.parent_id
    LEFT JOIN inventory_levels l ON l.account_id=v.account_id AND l.variant_id=v.id
    WHERE v.account_id=${accountId}::uuid AND v.archived_at IS NULL
    ORDER BY lower(p.name), p.id, v.position, v.created_at, v.id
    LIMIT ${MAX_EXPORT_ROWS}`;
  const csv = buildProductCsv(rows.map((r) => ({
    sku: r.sku, name: r.name, description: r.description, category: r.parent ? `${r.parent} > ${r.category}` : r.category, tags: r.tags,
    brand: r.brand, productType: r.product_type, status: r.status, options: r.option_values ?? {},
    priceMinor: r.price === null ? null : Number(r.price), compareAtMinor: r.compare_at === null ? null : Number(r.compare_at),
    stock: r.track_inventory ? Number(r.on_hand ?? 0) : null, trackInventory: r.track_inventory, weightGrams: r.weight_grams,
    imageUrls: r.urls ?? [],
  })), currency);
  return { csv, rows: rows.length };
}

// ------------------------------------------------------------ preparing

export interface Prepared {
  /** Data rows in the file (blank lines excluded). */
  totalRows: number;
  ignoredColumns: number;
  /** Every refusal, by row: bad cells, unknown category, duplicate SKU, missing name. */
  errors: RowError[];
  plan: ImportPlan;
  /** Category name (or "Parent > Child") in lower case to its id. */
  categories: Map<string, string>;
  existing: Map<string, ExistingSku>;
}

export function checkCsvText(text: unknown): string {
  if (typeof text !== 'string') throw new CatalogueError('invalid', 'csv');
  if (Buffer.byteLength(text) > MAX_CSV_BYTES) throw new CatalogueError('csv_too_large');
  return text;
}

/** CsvError to the catalogue refusal with the matching code. */
export function asCatalogueError(error: unknown): unknown {
  return error instanceof CsvError ? new CatalogueError(`csv_${error.code}` as 'csv_empty') : error;
}

async function categoryMap(tx: TenantTransaction, accountId: string): Promise<Map<string, string>> {
  const all = (await listCategories(tx, accountId)).filter((c) => !c.archived);
  const byId = new Map(all.map((c) => [c.id, c]));
  const out = new Map<string, string>();
  const bare = new Map<string, string | null>();
  for (const c of all) {
    const parent = c.parent_id ? byId.get(c.parent_id) : null;
    if (c.parent_id && !parent) continue;
    out.set((parent ? `${parent.name} > ${c.name}` : c.name).toLowerCase(), c.id);
    if (parent) bare.set(c.name.toLowerCase(), bare.has(c.name.toLowerCase()) ? null : c.id);
  }
  for (const [name, id] of bare) if (id && !out.has(name)) out.set(name, id);
  return out;
}

/** Parse, validate and plan a file against the workspace (read only). Throws CsvError for an unusable file. */
export async function prepareImport(tx: TenantTransaction, accountId: string, csv: string): Promise<Prepared> {
  const file = parseProductCsv(csv);
  const settings = await tx.$queryRaw<{ currency: string }[]>`SELECT currency FROM commerce_settings WHERE account_id=${accountId}::uuid`;
  const currency = settings[0]?.currency ?? null;
  const errors: RowError[] = [];
  const rows: ImportRow[] = [];
  for (const raw of file.rows) {
    const result = validateRow(raw, currency);
    if ('errors' in result) errors.push(...result.errors); else rows.push(result.row);
  }
  const categories = await categoryMap(tx, accountId);
  const checked = rows.filter((row) => {
    if (row.category && !categories.has(row.category.toLowerCase())) {
      errors.push({ row: row.rowNumber, field: 'category', code: 'unknown_category' });
      return false;
    }
    return true;
  });
  const skus = [...new Set(checked.map((r) => r.sku))];
  const found = skus.length ? await tx.$queryRaw<{ sku: string; product_id: string; id: string }[]>`
    SELECT sku, product_id::text AS product_id, id::text AS id FROM shop_variants
    WHERE account_id=${accountId}::uuid AND sku = ANY(${skus}::text[])` : [];
  const existing = new Map(found.map((f) => [f.sku, { productId: f.product_id, variantId: f.id }]));
  const plan = planImport(checked, existing);
  return {
    totalRows: file.rows.length, ignoredColumns: file.ignoredColumns, categories, existing, plan,
    errors: [...errors, ...plan.errors].sort((a, b) => a.row - b.row),
  };
}

export interface ImportPreview {
  mode: 'inline' | 'queued';
  total_rows: number;
  create: number;
  update: number;
  new_products: number;
  error_count: number;
  ignored_columns: number;
  errors: RowError[];
  errors_capped: boolean;
  sample: { row: number; sku: string; kind: 'create' | 'update' }[];
}

export function previewOf(p: Prepared): ImportPreview {
  return {
    mode: p.totalRows > INLINE_MAX_ROWS ? 'queued' : 'inline',
    total_rows: p.totalRows, create: p.plan.counts.create, update: p.plan.counts.update, new_products: p.plan.counts.newProducts,
    error_count: p.errors.length, ignored_columns: p.ignoredColumns,
    errors: p.errors.slice(0, MAX_REPORTED_ERRORS), errors_capped: p.errors.length > MAX_REPORTED_ERRORS,
    sample: p.plan.planned.slice(0, 10).map((x) => ({ row: x.row.rowNumber, sku: x.row.sku, kind: x.kind })),
  };
}

// ------------------------------------------------------------ applying

interface StockTarget { row: number; variantId: string; stock: number }
export interface ApplyResult { created: number; updated: number; errors: RowError[]; stock: StockTarget[] }

let savepoints = 0;
/** Run `work` under a savepoint so a refused row leaves the rest of the transaction usable. Returns the error code or null. */
async function attempt(tx: TenantTransaction, work: () => Promise<void>): Promise<{ field: string; code: string } | null> {
  const name = `sp_import_${++savepoints}`;
  await tx.$executeRawUnsafe(`SAVEPOINT ${name}`);
  try {
    await work();
    await tx.$executeRawUnsafe(`RELEASE SAVEPOINT ${name}`);
    return null;
  } catch (error) {
    await tx.$executeRawUnsafe(`ROLLBACK TO SAVEPOINT ${name}`);
    if (error instanceof CatalogueError) return { field: error.field ?? 'row', code: error.code };
    // Never log the error text: it can quote a value from the file.
    console.error('[product-import] a row failed unexpectedly', { name: (error as Error)?.name });
    return { field: 'row', code: 'failed' };
  }
}

const hasKeys = (o: object) => Object.keys(o).length > 0;

/**
 * Apply planned rows in order on `tx` (the caller's transaction on the app role). `created` maps a new
 * product's group key to its id across calls of one run; after a restart the SKUs already written
 * make the same plan point at the existing product instead.
 */
export async function applyRows(tx: TenantTransaction, accountId: string, userId: string, rows: readonly PlannedRow[],
  categories: ReadonlyMap<string, string>, existing: ReadonlyMap<string, ExistingSku>, created: Map<string, string>): Promise<ApplyResult> {
  const result: ApplyResult = { created: 0, updated: 0, errors: [], stock: [] };
  for (const item of rows) {
    const { row } = item;
    const e = existing.get(row.sku);
    const failed = await attempt(tx, async () => {
      const categoryId = item.patch.category ? categories.get(item.patch.category.toLowerCase()) ?? null : null;
      const productFields = {
        ...(item.patch.description !== undefined ? { description: item.patch.description } : {}),
        ...(categoryId ? { category_id: categoryId } : {}),
        ...(item.patch.tags ? { tags: item.patch.tags } : {}),
        ...(item.patch.brand !== undefined ? { brand: item.patch.brand } : {}),
        ...(item.patch.productType !== undefined ? { product_type: item.patch.productType } : {}),
        ...(item.patch.imageUrls ? { images: item.patch.imageUrls.map((url) => ({ url })) } : {}),
      };
      let productId = item.key.startsWith('p:') ? item.key.slice(2) : created.get(item.key) ?? null;
      if (!productId) {
        const name = item.patch.name ?? row.name;
        if (!name) throw new CatalogueError('invalid', 'name');
        productId = (await upsertProduct(tx, accountId, userId, null, { name, ...productFields })).id;
        created.set(item.key, productId);
      } else if (item.first && (item.patch.name !== undefined || hasKeys(productFields))) {
        await upsertProduct(tx, accountId, userId, productId, { ...(item.patch.name !== undefined ? { name: item.patch.name } : {}), ...productFields });
      }
      const product = await upsertVariant(tx, accountId, userId, productId, e?.variantId ?? null, {
        sku: row.sku,
        ...(row.options ? { option_values: row.options } : {}),
        ...(row.priceMinor !== undefined ? { price_minor: row.priceMinor } : {}),
        ...(row.compareAtMinor !== undefined ? { compare_at_minor: row.compareAtMinor } : {}),
        ...(row.trackInventory !== undefined ? { track_inventory: row.trackInventory } : {}),
        ...(row.weightGrams !== undefined ? { weight_grams: row.weightGrams } : {}),
      });
      if (row.stock !== undefined) {
        const variant = product.variants.find((v) => v.sku === row.sku);
        // The row itself stays applied; only its stock count is refused.
        if (!variant || !variant.track_inventory || variant.archived) result.errors.push({ row: row.rowNumber, field: 'stock', code: 'not_tracked' });
        else result.stock.push({ row: row.rowNumber, variantId: variant.id, stock: row.stock });
      }
    });
    if (failed) { result.errors.push({ row: row.rowNumber, ...failed }); continue; }
    if (item.kind === 'create') result.created++; else result.updated++;
    if (item.last && item.status) {
      const productId = item.key.startsWith('p:') ? item.key.slice(2) : created.get(item.key)!;
      const bad = await attempt(tx, () => applyStatus(tx, accountId, userId, productId, item.status!));
      if (bad) result.errors.push({ row: row.rowNumber, field: 'status', code: bad.code });
    }
  }
  return result;
}

async function applyStatus(tx: TenantTransaction, accountId: string, userId: string, productId: string, status: ProductStatus) {
  const current = (await getShopProduct(tx, accountId, productId)).status;
  if (current === status) return;
  if (status === 'published') await publishProduct(tx, accountId, userId, productId);
  else if (status === 'archived') await archiveProduct(tx, accountId, userId, productId, true);
  else if (current === 'archived') await archiveProduct(tx, accountId, userId, productId, false);
  else await unpublishProduct(tx, accountId, userId, productId);
}

/** Set on-hand counts to the file's numbers (worker role: the only writer of stock). A count already right is left alone. */
export async function applyStock(accountId: string, userId: string, targets: readonly StockTarget[]): Promise<RowError[]> {
  const errors: RowError[] = [];
  if (!targets.length) return errors;
  await withTenant({ accountId, userId, role: 'owner' }, async (tx) => {
    for (const t of targets) {
      const failed = await attempt(tx, async () => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`stock-adjust:${accountId}:${t.variantId}`}, 0))`;
        const level = await tx.$queryRaw<{ on_hand: number }[]>`SELECT on_hand FROM inventory_levels
          WHERE account_id=${accountId}::uuid AND variant_id=${t.variantId}::uuid FOR UPDATE`;
        const delta = t.stock - (level[0]?.on_hand ?? 0);
        if (delta === 0) return;
        try {
          await adjustTx(tx, accountId, { variantId: t.variantId, delta, kind: 'adjustment', reason: 'csv_import', actorUserId: userId });
        } catch (error) {
          if (error instanceof StockError) throw new CatalogueError(error.code === 'below_reserved' ? 'below_reserved' : 'invalid', 'stock');
          throw error;
        }
      });
      if (failed) errors.push({ row: t.row, field: 'stock', code: failed.code });
    }
  }, getWorkerPrisma());
  return errors;
}

// ------------------------------------------------------------ inline import

export interface InlineResult { mode: 'inline'; created: number; updated: number; error_count: number; errors: RowError[]; errors_capped: boolean }

/** Apply a small file now: the catalogue in one transaction (a refused row is skipped, the rest apply), then the stock counts. */
export async function importInline(ctx: TenantContext & { userId: string }, csv: string): Promise<InlineResult> {
  const out = await withTenant(ctx, async (tx) => {
    const prepared = await prepareImport(tx, ctx.accountId, csv);
    const applied = await applyRows(tx, ctx.accountId, ctx.userId, prepared.plan.planned, prepared.categories, prepared.existing, new Map());
    return { prepared, applied };
  }, getPrisma(), { timeoutMs: 120_000 });
  const stockErrors = await applyStock(ctx.accountId, ctx.userId, out.applied.stock);
  const errors = [...out.prepared.errors, ...out.applied.errors, ...stockErrors].sort((a, b) => a.row - b.row);
  const { created, updated } = out.applied;
  await withTenant(ctx, (tx) => auditCatalogue(tx, ctx.accountId, ctx.userId, 'commerce.products_csv_imported', 'inline',
    { created, updated, errors: errors.length }));
  return { mode: 'inline', created, updated, error_count: errors.length, errors: errors.slice(0, MAX_REPORTED_ERRORS), errors_capped: errors.length > MAX_REPORTED_ERRORS };
}

// ------------------------------------------------------------ queued import

export interface ImportJobView {
  id: string;
  status: 'queued' | 'running' | 'done' | 'failed';
  total_rows: number;
  processed_rows: number;
  created_count: number;
  updated_count: number;
  error_count: number;
  errors: RowError[];
  error_code: string | null;
  created_at: string;
  completed_at: string | null;
}

export async function listImportJobs(tx: TenantTransaction, accountId: string): Promise<ImportJobView[]> {
  const rows = await tx.$queryRaw<(Omit<ImportJobView, 'id' | 'created_at' | 'completed_at'> & { id: string; created_at: Date; completed_at: Date | null })[]>`
    SELECT id::text AS id, status, total_rows, processed_rows, created_count, updated_count, error_count, errors, error_code, created_at, completed_at
    FROM shop_import_jobs WHERE account_id=${accountId}::uuid ORDER BY created_at DESC, id DESC LIMIT 5`;
  return rows.map((r) => ({ ...r, errors: (r.errors ?? []) as RowError[], created_at: r.created_at.toISOString(), completed_at: r.completed_at?.toISOString() ?? null }));
}

/** Store the file and queue the worker before answering. One import at a time per workspace (import_running). */
export async function queueImport(ctx: TenantContext & { userId: string }, csv: string, totalRows: number): Promise<{ mode: 'queued'; import_id: string }> {
  const id = await withTenant(ctx, async (tx) => {
    const rows = await tx.$queryRaw<{ id: string }[]>`
      INSERT INTO shop_import_jobs(account_id, requested_by, csv_text, total_rows)
      VALUES(${ctx.accountId}::uuid, ${ctx.userId}::uuid, ${csv}, ${totalRows}) RETURNING id::text AS id`
      .catch((e: { code?: string; meta?: { code?: string }; message?: string }) => {
        if ((e?.meta?.code ?? e?.code) === '23505' || /23505|unique constraint/i.test(e?.message ?? '')) throw new CatalogueError('import_running');
        throw e;
      });
    await auditCatalogue(tx, ctx.accountId, ctx.userId, 'commerce.products_csv_queued', rows[0].id, { rows: totalRows });
    return rows[0].id;
  });
  try {
    await enqueueJob(PRODUCT_IMPORT_JOB, { importId: id }, { tenantId: ctx.accountId, dedupeKey: `${PRODUCT_IMPORT_JOB}:${id}` });
  } catch (error) {
    await finishImport(ctx.accountId, id, 'failed', 'queue_failed');
    throw error;
  }
  return { mode: 'queued', import_id: id };
}

const worker = (accountId: string, userId?: string): TenantContext => ({ accountId, userId, role: 'owner' });

async function finishImport(accountId: string, id: string, status: 'done' | 'failed', errorCode: string | null) {
  await withTenant(worker(accountId), (tx) => tx.$executeRaw`
    UPDATE shop_import_jobs SET status=${status}, csv_text=NULL, error_code=${errorCode}, completed_at=now()
    WHERE account_id=${accountId}::uuid AND id=${id}::uuid AND status IN ('queued','running')`, getWorkerPrisma());
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The commerce.product_import job (payload { importId }). Resumable: progress (processed_rows) moves
 * only together with the chunk's stock and counts; a chunk replayed after a crash finds its SKUs and
 * changes nothing twice. A finished or failed import is a no-op.
 */
export async function handleProductImportJob(accountId: string, payload: Record<string, unknown>,
  attempt_: { attempts: number; maxAttempts: number }, assertLease: () => void = () => {}): Promise<void> {
  const id = payload.importId;
  if (typeof id !== 'string' || !UUID.test(id)) throw new Error('Invalid product import job');
  const w = getWorkerPrisma();
  const job = await withTenant(worker(accountId), async (tx) => {
    const rows = await tx.$queryRaw<{ status: string; requested_by: string; csv_text: string | null; processed_rows: number }[]>`
      UPDATE shop_import_jobs SET status='running', started_at=COALESCE(started_at, now())
      WHERE account_id=${accountId}::uuid AND id=${id}::uuid AND status IN ('queued','running')
      RETURNING status, requested_by::text AS requested_by, csv_text, processed_rows`;
    return rows[0] ?? null;
  }, w);
  if (!job || job.csv_text === null) return;
  try {
    // The file was queued by an admin; it applies only while that person still is one.
    const role = await withTenant(worker(accountId), (tx) => tx.$queryRaw<{ role: string }[]>`
      SELECT role FROM account_memberships WHERE account_id=${accountId}::uuid AND user_id=${job.requested_by}::uuid`, w);
    if (!['owner', 'admin'].includes(role[0]?.role ?? '')) return void (await finishImport(accountId, id, 'failed', 'not_allowed'));
    const ctx = { accountId, userId: job.requested_by, role: role[0].role as 'owner' | 'admin' };
    const created = new Map<string, string>();
    let done = job.processed_rows;
    let first = true;
    for (;;) {
      assertLease();
      const prepared = await withTenant(ctx, (tx) => prepareImport(tx, accountId, job.csv_text!), getPrisma(), { timeoutMs: 60_000 });
      if (first && done === 0) {
        // Refusals found while reading the file are recorded once, before the first chunk (a restart at 0 rewrites the same list).
        await withTenant(worker(accountId), (tx) => tx.$executeRaw`
          UPDATE shop_import_jobs SET errors=${JSON.stringify(prepared.errors.slice(0, MAX_REPORTED_ERRORS))}::jsonb, error_count=${prepared.errors.length}
          WHERE account_id=${accountId}::uuid AND id=${id}::uuid AND processed_rows=0`, w);
      }
      first = false;
      if (done >= prepared.totalRows) break;
      const slice = prepared.plan.planned.filter((p) => p.row.rowNumber - 1 > done && p.row.rowNumber - 1 <= done + IMPORT_CHUNK);
      const applied = await withTenant(ctx, (tx) => applyRows(tx, accountId, ctx.userId, slice, prepared.categories, prepared.existing, created),
        getPrisma(), { timeoutMs: 120_000 });
      const stockErrors = await applyStock(accountId, ctx.userId, applied.stock);
      const errors = [...applied.errors, ...stockErrors];
      const next = Math.min(done + IMPORT_CHUNK, prepared.totalRows);
      await withTenant(worker(accountId), async (tx) => {
        const cur = await tx.$queryRaw<{ errors: RowError[] }[]>`SELECT errors FROM shop_import_jobs
          WHERE account_id=${accountId}::uuid AND id=${id}::uuid FOR UPDATE`;
        const merged = [...((cur[0]?.errors ?? []) as RowError[]), ...errors].slice(0, MAX_REPORTED_ERRORS);
        await tx.$executeRaw`UPDATE shop_import_jobs SET processed_rows=${next}, created_count=created_count+${applied.created},
          updated_count=updated_count+${applied.updated}, error_count=error_count+${errors.length}, errors=${JSON.stringify(merged)}::jsonb
          WHERE account_id=${accountId}::uuid AND id=${id}::uuid`;
      }, w);
      done = next;
    }
    await withTenant(worker(accountId, job.requested_by), async (tx) => {
      const fin = await tx.$queryRaw<{ created_count: number; updated_count: number; error_count: number }[]>`
        UPDATE shop_import_jobs SET status='done', csv_text=NULL, completed_at=now()
        WHERE account_id=${accountId}::uuid AND id=${id}::uuid AND status='running'
        RETURNING created_count, updated_count, error_count`;
      if (fin[0]) await auditCatalogue(tx, accountId, job.requested_by, 'commerce.products_csv_imported', id,
        { created: fin[0].created_count, updated: fin[0].updated_count, errors: fin[0].error_count });
    }, w);
  } catch (error) {
    // A file the parser refuses will never apply; anything else is retried until the attempts run out.
    if (error instanceof CsvError) return void (await finishImport(accountId, id, 'failed', `csv_${error.code}`));
    if (attempt_.attempts >= attempt_.maxAttempts) await finishImport(accountId, id, 'failed', 'import_failed');
    throw error;
  }
}
