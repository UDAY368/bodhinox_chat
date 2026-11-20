/**
 * The one-page product form (batch 4): the product, its photos, every variant
 * of the options matrix and a bundle's parts are written in ONE transaction on
 * the app role (RLS: admins write). A new product always gets a default
 * variant, and a variant saved without a SKU gets a generated one, unique in
 * the account. Stock is the worker's table, so the stock counts typed in the
 * form come back as a plan that the route applies right after through
 * inventory.setStockLevels (commerce.inventory, stale-count checked, audited).
 *
 * Bulk list actions (Live, Hidden, archive, set category) are set-based single
 * statements over at most MAX_BULK ids of the caller's account.
 */
import type { TenantTransaction } from '@/lib/db/tenant';
import {
  applyVariant, asBody, CatalogueError, getShopProduct, has, int, isId, lockVariants, upsertProduct, writeBundleParts,
  type ShopProduct, type VariantCurrent, type VariantWriteCache,
} from './products';
import { MAX_VARIANTS, optionKey, skuBase, skuCandidates } from './variant-matrix';

export const MAX_BULK = 100;
const MAX_STOCK = 1_000_000;

/** A stock count to apply after the save: on hand moves from `expectedOnHand` to `onHand`. */
export interface StockTarget { variantId: string; expectedOnHand: number; onHand: number }

interface RowInput {
  id: string | null;
  body: Record<string, unknown>;
  sku: string | null;
  imageIndex: number | null | undefined;
  stock: number | null;
  expectedOnHand: number;
}

function parseRows(raw: unknown): RowInput[] {
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > MAX_VARIANTS) throw new CatalogueError('invalid', 'variants');
  const seen = new Set<string>();
  const keys = new Set<string>();
  return raw.map((item) => {
    const b = { ...asBody(item) };
    const id = has(b, 'id') && b.id !== null ? b.id : null;
    if (id !== null && (!isId(id) || seen.has(id.toLowerCase()))) throw new CatalogueError('invalid', 'variants');
    if (id) seen.add(id.toLowerCase());
    const options = (has(b, 'option_values') ? b.option_values : {}) as Record<string, string>;
    if (!options || typeof options !== 'object' || Array.isArray(options)) throw new CatalogueError('invalid', 'option_values');
    const key = optionKey(Object.fromEntries(Object.entries(options).map(([k, v]) => [k, String(v)])));
    if (keys.has(key)) throw new CatalogueError('invalid', 'option_values', 'duplicate');
    keys.add(key);
    const sku = typeof b.sku === 'string' && b.sku.trim() ? b.sku.trim() : null;
    const imageIndex = has(b, 'image_index') ? (b.image_index === null ? null : int(b, 'image_index', 0, 9)) : undefined;
    const stock = has(b, 'stock') && b.stock !== null ? int(b, 'stock', 0, MAX_STOCK) : null;
    const expectedOnHand = has(b, 'expected_on_hand') ? int(b, 'expected_on_hand', 0, 2_147_483_647) : 0;
    for (const k of ['id', 'sku', 'image_index', 'stock', 'expected_on_hand', 'archived', 'position', 'image_id']) delete b[k];
    return { id: id as string | null, body: b, sku, imageIndex, stock, expectedOnHand };
  });
}

/** Free SKUs for the rows saved without one: "<NAME>-<VALUES>", then -2, -3 ... unique in the account and in this save. */
async function generateSkus(tx: TenantTransaction, accountId: string, name: string, rows: { values: Record<string, string> }[], taken: Set<string>):
  Promise<string[]> {
  if (!rows.length) return [];
  // One generator at a time per account, so two saves cannot pick the same free SKU.
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`shop-sku-gen:${accountId}`}, 0))`;
  const lists = rows.map((r) => skuCandidates(skuBase(name, r.values)));
  const all = [...new Set(lists.flat())];
  const used = await tx.$queryRaw<{ sku: string }[]>`SELECT sku FROM shop_variants
    WHERE account_id=${accountId}::uuid AND sku = ANY(${all}::text[])`;
  for (const r of used) taken.add(r.sku.toLowerCase());
  return lists.map((candidates) => {
    let sku = candidates.find((c) => !taken.has(c.toLowerCase()));
    // Twenty taken in a row: a short random tail keeps it unique (the unique key still guards a race).
    sku ??= `${candidates[0].slice(0, 57)}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
    taken.add(sku.toLowerCase());
    return sku;
  });
}

/**
 * Create (id null) or update a product with its variants. The body is the
 * product body of upsertProduct plus, optionally:
 *   variants: the complete list of active variants, in order, each
 *     { id?, option_values, sku? (blank = generated), price_minor, compare_at_minor, tax_rate_bps, hsn_code, track_inventory,
 *       weight_grams, image_index (into the saved images), preorder, preorder_ship_date, preorder_cap, stock?, expected_on_hand? }.
 *     An active variant left out is archived (never deleted: orders keep it); an archived one listed again is restored.
 *   parts: a bundle's parts, as for setBundleParts.
 * A new product without `variants` gets one default variant with a generated SKU.
 */
export async function saveProductForm(tx: TenantTransaction, accountId: string, userId: string, id: string | null, raw: unknown):
  Promise<{ product: ShopProduct; stock: StockTarget[] }> {
  const b = asBody(raw);
  const rowsRaw = has(b, 'variants') ? b.variants : id ? undefined : [{}];
  const rows = rowsRaw === undefined ? null : parseRows(rowsRaw);
  const productBody: Record<string, unknown> = { ...b };
  delete productBody.variants;
  delete productBody.parts;
  const saved = await upsertProduct(tx, accountId, userId, id, productBody);
  const product = { id: saved.id, status: saved.status };

  const stock: StockTarget[] = [];
  if (rows) {
    const current = await lockVariants(tx, accountId, saved.id);
    const byId = new Map(current.map((v) => [v.id, v]));
    if (rows.some((r) => r.id && !byId.has(r.id))) throw new CatalogueError('invalid', 'variants');
    const listed = new Set(rows.flatMap((r) => (r.id ? [r.id] : [])));
    const taken = new Set(rows.flatMap((r) => (r.sku ? [r.sku.toLowerCase()] : [])));
    for (const v of current) if (!listed.has(v.id)) taken.add(v.sku.toLowerCase());
    const missing = rows.filter((r) => !r.sku && !(r.id && byId.get(r.id)));
    const generated = await generateSkus(tx, accountId, saved.name,
      missing.map((r) => ({ values: (r.body.option_values ?? {}) as Record<string, string> })), taken);
    missing.forEach((r, i) => { r.sku = generated[i]; });
    const cache: VariantWriteCache = { kind: { is_bundle: saved.is_bundle, is_digital: saved.is_digital } };
    // Archive the variants no longer listed first, so a restored or renamed row never collides with them.
    for (const v of current) {
      if (!listed.has(v.id) && !v.archived_at) await applyVariant(tx, accountId, userId, product, v, { archived: true }, { checkPriced: false, cache });
    }
    for (const [position, row] of rows.entries()) {
      const before: VariantCurrent | undefined = row.id ? byId.get(row.id) : undefined;
      const imageId = row.imageIndex === undefined ? undefined : row.imageIndex === null ? null : saved.images[row.imageIndex]?.id;
      if (imageId === undefined && row.imageIndex !== undefined) throw new CatalogueError('invalid', 'image_index');
      const body: Record<string, unknown> = { ...row.body, sku: row.sku ?? before?.sku, position, archived: false, ...(imageId !== undefined ? { image_id: imageId } : {}) };
      const variantId = await applyVariant(tx, accountId, userId, product, before, body, { checkPriced: false, cache });
      const track = typeof body.track_inventory === 'boolean' ? body.track_inventory : before?.track_inventory ?? true;
      if (track && row.stock !== null) {
        const expected = before ? row.expectedOnHand : 0;
        if (row.stock !== expected) stock.push({ variantId, expectedOnHand: expected, onHand: row.stock });
      }
    }
    if (saved.status === 'published') {
      const [priced] = await tx.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM shop_variants WHERE account_id=${accountId}::uuid
        AND product_id=${saved.id}::uuid AND archived_at IS NULL AND price_minor IS NOT NULL`;
      if (!priced?.n) throw new CatalogueError('needs_priced_variant', 'price_minor');
    }
  }
  if (has(b, 'parts') && saved.is_bundle) await writeBundleParts(tx, accountId, userId, saved.id, { parts: b.parts });
  if (id && (rows || has(b, 'parts'))) {
    await tx.$executeRaw`UPDATE shop_products SET version=version+1 WHERE account_id=${accountId}::uuid AND id=${saved.id}::uuid`;
  }
  return { product: rows || has(b, 'parts') ? await getShopProduct(tx, accountId, saved.id) : saved, stock };
}

// ------------------------------------------------------------ bulk actions from the product list

export const BULK_ACTIONS = ['live', 'hidden', 'archive', 'category'] as const;
export type BulkAction = (typeof BULK_ACTIONS)[number];

/**
 * One list action over up to 100 products of the caller's account (admins). A
 * product the action does not fit (another account's id, already archived, or
 * not ready to go live: no priced active variant, or a bundle without parts)
 * is skipped and counted, never an error. Every changed product gets its own
 * audit entry (ids only).
 */
export async function bulkUpdateProducts(tx: TenantTransaction, accountId: string, userId: string, raw: unknown):
  Promise<{ changed: number; skipped: number }> {
  const b = asBody(raw);
  const action = b.action as BulkAction;
  if (!(BULK_ACTIONS as readonly unknown[]).includes(action)) throw new CatalogueError('invalid', 'action');
  const ids = b.ids;
  if (!Array.isArray(ids) || ids.length < 1 || ids.length > MAX_BULK || !ids.every(isId)) throw new CatalogueError('invalid', 'ids');
  const unique = [...new Set((ids as string[]).map((x) => x.toLowerCase()))];
  let changed: { id: string }[];
  if (action === 'live') {
    changed = await tx.$queryRaw<{ id: string }[]>`
      UPDATE shop_products p SET status='published', content_reviewed_by=${userId}::uuid, content_reviewed_at=now(), version=version+1
      WHERE p.account_id=${accountId}::uuid AND p.id = ANY(${unique}::uuid[]) AND p.status='draft'
        AND EXISTS (SELECT 1 FROM shop_variants v WHERE v.account_id=p.account_id AND v.product_id=p.id AND v.archived_at IS NULL
          AND v.price_minor IS NOT NULL)
        AND (NOT p.is_bundle OR EXISTS (SELECT 1 FROM shop_bundle_parts x WHERE x.account_id=p.account_id AND x.product_id=p.id))
      RETURNING p.id::text AS id`;
  } else if (action === 'hidden') {
    changed = await tx.$queryRaw<{ id: string }[]>`
      UPDATE shop_products SET status='draft', version=version+1
      WHERE account_id=${accountId}::uuid AND id = ANY(${unique}::uuid[]) AND status='published' RETURNING id::text AS id`;
  } else if (action === 'archive') {
    changed = await tx.$queryRaw<{ id: string }[]>`
      UPDATE shop_products SET status='archived', version=version+1
      WHERE account_id=${accountId}::uuid AND id = ANY(${unique}::uuid[]) AND status<>'archived' RETURNING id::text AS id`;
  } else {
    const categoryId = b.category_id === null ? null : b.category_id;
    if (categoryId !== null && !isId(categoryId)) throw new CatalogueError('invalid', 'category_id');
    if (categoryId) {
      const [cat] = await tx.$queryRaw<{ id: string }[]>`SELECT id::text AS id FROM shop_categories
        WHERE account_id=${accountId}::uuid AND id=${categoryId}::uuid AND archived_at IS NULL`;
      if (!cat) throw new CatalogueError('invalid', 'category_id');
    }
    changed = await tx.$queryRaw<{ id: string }[]>`
      UPDATE shop_products SET category_id=${categoryId}::uuid, version=version+1
      WHERE account_id=${accountId}::uuid AND id = ANY(${unique}::uuid[]) AND category_id IS DISTINCT FROM ${categoryId}::uuid
      RETURNING id::text AS id`;
  }
  if (changed.length) {
    const action_name = `commerce.products_bulk_${action}`;
    await tx.$executeRaw`INSERT INTO audit_logs(account_id,user_id,action,resource_id,metadata)
      SELECT ${accountId}::uuid, ${userId}::uuid, ${action_name}, x, '{"bulk":true}'::jsonb FROM unnest(${changed.map((c) => c.id)}::text[]) x`;
  }
  return { changed: changed.length, skipped: unique.length - changed.length };
}
