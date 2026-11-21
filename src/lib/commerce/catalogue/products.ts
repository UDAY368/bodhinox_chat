/**
 * The sellable catalogue Bodhinox owns (design E1, section 3 "Catalogue"):
 * categories, products, variants and images in the shop_* tables.
 *
 * Tenancy: every function runs inside the caller's withTenant transaction on
 * the app role. RLS lets agents read and only admins write these tables; the
 * routes also check the role first. Every change writes an audit entry with
 * ids and field names only (never customer content).
 *
 * The Meta `products` mirror is never written here. A variant matches a
 * mirrored product by products.retailer_id = shop_variants.sku;
 * importFromMeta creates drafts from the mirror and never overwrites.
 */
import type { TenantTransaction } from '@/lib/db/tenant';
import { mediaObjectUrl } from '@/lib/storage/client';
import { likePattern } from '../catalog';
import { minorFromDb, MAX_MINOR } from '../money';
import { normaliseTag } from './collection-rules';
import { PUBLIC_SHOP_PATH } from '../shop-templates';
import { appOrigin } from '@/lib/auth/csrf';
import { bundleAvailability, parseScheduleTime, parseShipDate, preorderProblem, scheduleProblem } from '../selling-rules';
import { nextSlug, parseSlugInput, recordSlugMove } from './slugs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const SKU = /^[A-Za-z0-9._-]{1,64}$/;
const HSN = /^[0-9]{4,8}$/;
export const isId = (v: unknown): v is string => typeof v === 'string' && UUID.test(v);

export const PRODUCT_STATUSES = ['draft', 'published', 'archived'] as const;
export type ProductStatus = (typeof PRODUCT_STATUSES)[number];
export const STOCK_FILTERS = ['in_stock', 'low', 'out'] as const;
export type StockFilter = (typeof STOCK_FILTERS)[number];
export const MAX_IMAGES = 10;
export const MAX_OPTIONS = 4;
export const MAX_TAGS = 20;
export const MAX_DETAILS = 12;
export const IMPORT_MAX = 100;
/** Search engine listing limits (store Batch 6; the database checks the same). */
export const SEO_TITLE_MAX = 70;
export const SEO_DESCRIPTION_MAX = 160;

// ------------------------------------------------------------ errors

export type CatalogueErrorCode =
  | 'invalid' | 'not_found' | 'conflict' | 'sku_taken' | 'store_not_configured'
  | 'slug_taken' | 'needs_priced_variant' | 'category_depth' | 'category_has_children' | 'not_tracked' | 'stock_changed' | 'below_reserved'
  | 'import_running' | 'csv_empty' | 'csv_too_large' | 'csv_too_many_rows' | 'csv_too_many_columns' | 'csv_cell_too_long'
  | 'csv_unterminated_quote' | 'csv_missing_sku_column' | 'platform_not_connected' | 'shopify_scope_missing' | 'woo_https_required'
  | 'meta_not_connected' | 'meta_sync_off' | 'meta_unavailable' | 'reconcile_too_soon'
  // Stock locations, transfers and purchase orders (store plan Phase 8)
  | 'insufficient_stock' | 'location_in_use' | 'location_inactive' | 'name_taken' | 'key_reused' | 'po_state' | 'over_receive';

const STATUS: Record<CatalogueErrorCode, number> = {
  invalid: 400, not_found: 404, conflict: 409, sku_taken: 409, slug_taken: 409, store_not_configured: 409,
  needs_priced_variant: 409, category_depth: 409, category_has_children: 409, not_tracked: 409, stock_changed: 409, below_reserved: 409,
  import_running: 409, csv_empty: 400, csv_too_large: 413, csv_too_many_rows: 413, csv_too_many_columns: 400, csv_cell_too_long: 400,
  csv_unterminated_quote: 400, csv_missing_sku_column: 400, platform_not_connected: 409, shopify_scope_missing: 409, woo_https_required: 409,
  meta_not_connected: 409, meta_sync_off: 409, meta_unavailable: 502, reconcile_too_soon: 409,
  insufficient_stock: 409, location_in_use: 409, location_inactive: 409, name_taken: 409, key_reused: 409, po_state: 409, over_receive: 409,
};

/** A refusal with a stable code (Commerce.catalogue.errors.<code>); `field`/`detail` name the input, never echo it. */
export class CatalogueError extends Error {
  readonly status: number;
  constructor(readonly code: CatalogueErrorCode, readonly field?: string, readonly detail?: string) {
    super(code);
    this.name = 'CatalogueError';
    this.status = STATUS[code];
  }
}

// ------------------------------------------------------------ input parsing

type Body = Record<string, unknown>;
export const has = (b: Body, k: string) => Object.hasOwn(b, k) && b[k] !== undefined;

export function asBody(value: unknown): Body {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new CatalogueError('invalid');
  return value as Body;
}
function text(b: Body, k: string, min: number, max: number): string {
  const v = b[k];
  if (typeof v !== 'string' || v.trim().length < min || v.trim().length > max) throw new CatalogueError('invalid', k);
  return v.trim();
}
function optText(b: Body, k: string, max: number): string | null {
  const v = b[k];
  if (v === null || v === '') return null;
  if (typeof v !== 'string' || v.trim().length > max) throw new CatalogueError('invalid', k);
  return v.trim() || null;
}
export function int(b: Body, k: string, min: number, max: number): number {
  const v = b[k];
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < min || v > max) throw new CatalogueError('invalid', k);
  return v;
}
function optInt(b: Body, k: string, min: number, max: number): number | null {
  return b[k] === null ? null : int(b, k, min, max);
}
function bool(b: Body, k: string): boolean {
  if (typeof b[k] !== 'boolean') throw new CatalogueError('invalid', k);
  return b[k] as boolean;
}
/** An optional ISO date-time (null clears it); an unreadable value is invalid. */
function scheduleTime(b: Body, k: string): Date | null {
  const t = parseScheduleTime(b[k]);
  if (t === undefined) throw new CatalogueError('invalid', k);
  return t;
}
function shipDate(b: Body, k: string): string | null {
  if (b[k] === null || b[k] === '') return null;
  const d = parseShipDate(b[k]);
  if (!d) throw new CatalogueError('invalid', k);
  return d;
}
/** An optional https URL without credentials (null clears it). */
function optHttpsUrl(b: Body, k: string): string | null {
  const v = optText(b, k, 2048);
  if (v === null) return null;
  let parsed: URL;
  try { parsed = new URL(v); } catch { throw new CatalogueError('invalid', k); }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password) throw new CatalogueError('invalid', k);
  return v;
}
function optId(b: Body, k: string): string | null {
  const v = b[k];
  if (v === null || v === '') return null;
  if (!isId(v)) throw new CatalogueError('invalid', k);
  return v;
}
function optVersion(b: Body): number | null {
  return has(b, 'version') ? int(b, 'version', 1, 2_147_483_647) : null;
}

/** {"Size": "M"}: at most four pairs of short non-empty strings. */
export function parseOptionValues(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new CatalogueError('invalid', 'option_values');
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > MAX_OPTIONS) throw new CatalogueError('invalid', 'option_values', 'too_many');
  const out: Record<string, string> = {};
  for (const [key, val] of entries) {
    const k = key.trim(), v = typeof val === 'string' ? val.trim() : '';
    if (!k || k.length > 40 || !v || v.length > 80 || Object.hasOwn(out, k)) throw new CatalogueError('invalid', 'option_values');
    out[k] = v;
  }
  return out;
}

const CONTROL = /[\u0000-\u001f\u007f]/;

/** A short plain-text line (brand, product type, a detail label): control characters refused, whitespace folded. */
function plainLine(value: unknown, max: number, field: string): string {
  if (typeof value !== 'string' || CONTROL.test(value)) throw new CatalogueError('invalid', field);
  const text = value.replace(/\s+/g, ' ').trim();
  if (!text || text.length > max) throw new CatalogueError('invalid', field);
  return text;
}
function optPlainLine(b: Body, k: string, max: number): string | null {
  return b[k] === null || b[k] === '' ? null : plainLine(b[k], max, k);
}

/** Tags: at most 20, each trimmed, folded to lower case, at most 40 characters, no commas; duplicates merge. */
export function parseTags(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > MAX_TAGS) throw new CatalogueError('invalid', 'tags');
  const out: string[] = [];
  for (const raw of value) {
    const tag = normaliseTag(raw);
    if (!tag) throw new CatalogueError('invalid', 'tags');
    if (!out.includes(tag)) out.push(tag);
  }
  return out;
}

export interface ProductDetail { label: string; value: string }

/** Detail rows shown on the product page: at most 12 plain-text {label, value} pairs (label 40, value 200 characters). Unknown keys are dropped. */
export function parseDetails(value: unknown): ProductDetail[] {
  if (!Array.isArray(value) || value.length > MAX_DETAILS) throw new CatalogueError('invalid', 'details');
  return value.map((row) => {
    if (!row || typeof row !== 'object' || Array.isArray(row)) throw new CatalogueError('invalid', 'details');
    const r = row as Record<string, unknown>;
    return { label: plainLine(r.label, 40, 'details'), value: plainLine(r.value, 200, 'details') };
  });
}

function mapDbError(error: unknown, field: string): never {
  const e = error as { code?: string; meta?: { code?: string }; message?: string };
  const code = e?.meta?.code ?? e?.code;
  const message = error instanceof Error ? error.message : '';
  if (code === '23505' || /23505|unique constraint/i.test(message)) {
    // The slug's unique index names itself (shop_products_slug_key / shop_categories_slug_key).
    if (/slug/i.test(message)) throw new CatalogueError('slug_taken', 'slug');
    throw new CatalogueError(field === 'sku' ? 'sku_taken' : 'conflict', field);
  }
  if (code === '23503' || code === '23514' || /2350[34]|23514|foreign key|check constraint/i.test(message)) throw new CatalogueError('invalid', field);
  throw error;
}

export async function auditCatalogue(tx: TenantTransaction, accountId: string, userId: string | null, action: string,
  resourceId: string, metadata: object = {}) {
  await tx.$executeRaw`INSERT INTO audit_logs(account_id,user_id,action,resource_id,metadata)
    VALUES(${accountId}::uuid,${userId}::uuid,${action},${resourceId},${JSON.stringify(metadata)}::jsonb)`;
}

const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);

// ------------------------------------------------------------ categories

export interface ShopCategory {
  id: string;
  name: string;
  /** The readable address /s/<handle>/c/<slug> (null only for a row made before the slug migration finished). */
  slug: string | null;
  parent_id: string | null;
  position: number;
  archived: boolean;
  product_count: number;
}

export async function listCategories(tx: TenantTransaction, accountId: string): Promise<ShopCategory[]> {
  const rows = await tx.$queryRaw<{ id: string; name: string; slug: string | null; parent_id: string | null; position: number; archived_at: Date | null; n: bigint }[]>`
    SELECT c.id::text AS id, c.name, c.slug, c.parent_id::text AS parent_id, c.position, c.archived_at,
      (SELECT count(*) FROM shop_products p WHERE p.account_id=c.account_id AND p.category_id=c.id AND p.status<>'archived') AS n
    FROM shop_categories c WHERE c.account_id=${accountId}::uuid
    ORDER BY (c.archived_at IS NOT NULL), c.position, lower(c.name), c.id`;
  return rows.map((r) => ({ id: r.id, name: r.name, slug: r.slug, parent_id: r.parent_id, position: r.position, archived: !!r.archived_at, product_count: Number(r.n) }));
}

/** Depth at most two: a parent must be top-level, and a category with children cannot get a parent. */
async function checkParent(tx: TenantTransaction, accountId: string, id: string | null, parentId: string | null) {
  if (!parentId) return;
  if (parentId === id) throw new CatalogueError('category_depth', 'parent_id');
  const parent = await tx.$queryRaw<{ parent_id: string | null }[]>`
    SELECT parent_id::text AS parent_id FROM shop_categories WHERE account_id=${accountId}::uuid AND id=${parentId}::uuid AND archived_at IS NULL`;
  if (!parent[0]) throw new CatalogueError('invalid', 'parent_id');
  if (parent[0].parent_id) throw new CatalogueError('category_depth', 'parent_id');
  if (id) {
    const children = await tx.$queryRaw<{ n: bigint }[]>`
      SELECT count(*) AS n FROM shop_categories WHERE account_id=${accountId}::uuid AND parent_id=${id}::uuid`;
    if (Number(children[0]?.n ?? 0) > 0) throw new CatalogueError('category_has_children', 'parent_id');
  }
}

export async function createCategory(tx: TenantTransaction, accountId: string, userId: string, raw: unknown): Promise<ShopCategory> {
  const b = asBody(raw);
  const name = text(b, 'name', 1, 80);
  const parentId = has(b, 'parent_id') ? optId(b, 'parent_id') : null;
  const position = has(b, 'position') ? int(b, 'position', 0, 10000) : 0;
  await checkParent(tx, accountId, null, parentId);
  const slug = await nextSlug(tx, accountId, 'category', { id: null, name, current: null, requested: parseSlugInput(b.slug) });
  const rows = await tx.$queryRaw<{ id: string }[]>`
    INSERT INTO shop_categories(account_id,name,parent_id,position,slug) VALUES(${accountId}::uuid,${name},${parentId}::uuid,${position},${slug})
    RETURNING id::text AS id`.catch((e) => mapDbError(e, 'name'));
  await auditCatalogue(tx, accountId, userId, 'commerce.category_created', rows[0].id);
  return (await listCategories(tx, accountId)).find((c) => c.id === rows[0].id)!;
}

export async function updateCategory(tx: TenantTransaction, accountId: string, userId: string, id: string, raw: unknown): Promise<ShopCategory> {
  const b = asBody(raw);
  const current = (await listCategories(tx, accountId)).find((c) => c.id === id);
  if (!current) throw new CatalogueError('not_found');
  const name = has(b, 'name') ? text(b, 'name', 1, 80) : current.name;
  const parentId = has(b, 'parent_id') ? optId(b, 'parent_id') : current.parent_id;
  const position = has(b, 'position') ? int(b, 'position', 0, 10000) : current.position;
  const archived = has(b, 'archived') ? bool(b, 'archived') : current.archived;
  if (parentId !== current.parent_id) await checkParent(tx, accountId, id, parentId);
  const slug = await nextSlug(tx, accountId, 'category', { id, name, current: { slug: current.slug, name: current.name }, requested: parseSlugInput(b.slug) });
  await tx.$executeRaw`UPDATE shop_categories SET name=${name}, parent_id=${parentId}::uuid, position=${position}, slug=${slug},
      archived_at=CASE WHEN ${archived} THEN COALESCE(archived_at, now()) ELSE NULL END
    WHERE account_id=${accountId}::uuid AND id=${id}::uuid`.catch((e) => mapDbError(e, 'name'));
  if (current.slug && current.slug !== slug) await recordSlugMove(tx, accountId, userId, 'category', current.slug, slug);
  await auditCatalogue(tx, accountId, userId, 'commerce.category_updated', id, { fields: Object.keys(b).filter((k) => has(b, k)) });
  return (await listCategories(tx, accountId)).find((c) => c.id === id)!;
}

// ------------------------------------------------------------ products: reads

export interface ShopProductSummary {
  id: string;
  name: string;
  status: ProductStatus;
  category_id: string | null;
  category_name: string | null;
  version: number;
  variant_count: number;
  min_price_minor: number | null;
  max_price_minor: number | null;
  /** Sum of on_hand - reserved over tracked, non-archived variants. */
  available: number;
  tracked_count: number;
  /** Made-to-order variants (never reserved). */
  untracked_count: number;
  /** Tracked variants at or below their low-stock threshold. */
  low_count: number;
  image_url: string | null;
  updated_at: string;
  /** The only active variant when there is exactly one (inline price and stock edits), else null. */
  single_variant_id: string | null;
  /** That variant's units on hand (null when it does not track stock or there is not exactly one variant). */
  single_on_hand: number | null;
}

export interface ShopProductQuery {
  q?: string;
  categoryId?: string;
  /** Default: everything except archived. */
  status?: ProductStatus | 'all';
  stock?: StockFilter;
  limit?: number;
  offset?: number;
}

export function parseShopProductQuery(params: URLSearchParams): ShopProductQuery {
  const q = (params.get('q') ?? '').trim().slice(0, 100);
  const status = params.get('status') ?? '';
  const stock = params.get('stock') ?? '';
  const category = params.get('category_id') ?? '';
  const limit = Number(params.get('limit') ?? 50), offset = Number(params.get('offset') ?? 0);
  return {
    q: q || undefined,
    categoryId: isId(category) ? category : undefined,
    status: status === 'all' || (PRODUCT_STATUSES as readonly string[]).includes(status) ? (status as ProductStatus | 'all') : undefined,
    stock: (STOCK_FILTERS as readonly string[]).includes(stock) ? (stock as StockFilter) : undefined,
    limit: Number.isInteger(limit) ? Math.min(Math.max(limit, 1), 100) : 50,
    offset: Number.isInteger(offset) ? Math.min(Math.max(offset, 0), 100_000) : 0,
  };
}

const imageUrl = (url: string | null, bucket: string | null, key: string | null) =>
  url ?? (bucket && key ? mediaObjectUrl(bucket, key) : null);

type SummaryRow = {
  id: string; name: string; status: ProductStatus; category_id: string | null; category_name: string | null; version: number;
  variant_count: number; min_price: bigint | null; max_price: bigint | null; available: bigint; tracked: number; untracked: number;
  low_count: number; img_url: string | null; img_bucket: string | null; img_key: string | null; updated_at: Date; total: bigint;
  single_variant_id: string | null; single_on_hand: number | null;
};

/** A page of products with price range and stock summary (agents and above). The search matches name or any SKU, LIKE-escaped. */
export async function listShopProducts(tx: TenantTransaction, accountId: string, query: ShopProductQuery = {}):
  Promise<{ products: ShopProductSummary[]; total: number; currency: string | null; shop_url: string | null }> {
  const pattern = query.q ? likePattern(query.q) : null;
  const status = query.status ?? null;
  const stock = query.stock ?? null;
  const limit = Math.min(Math.max(query.limit ?? 50, 1), 100);
  const offset = Math.max(query.offset ?? 0, 0);
  const rows = await tx.$queryRaw<SummaryRow[]>`
    SELECT p.id::text AS id, p.name, p.status, p.category_id::text AS category_id, c.name AS category_name, p.version,
      s.variant_count, s.min_price, s.max_price, s.available, s.tracked, s.untracked, s.low_count, s.single_variant_id, s.single_on_hand,
      img.url AS img_url, img.bucket AS img_bucket, img.object_key AS img_key, p.updated_at, count(*) OVER() AS total
    FROM shop_products p
    LEFT JOIN commerce_settings st ON st.account_id=p.account_id
    LEFT JOIN shop_categories c ON c.account_id=p.account_id AND c.id=p.category_id
    CROSS JOIN LATERAL (
      SELECT count(*)::int AS variant_count, min(v.price_minor) AS min_price, max(v.price_minor) AS max_price,
        COALESCE(sum(GREATEST(COALESCE(l.on_hand,0)-COALESCE(l.reserved,0),0)) FILTER (WHERE v.track_inventory),0)::bigint AS available,
        count(*) FILTER (WHERE v.track_inventory)::int AS tracked,
        count(*) FILTER (WHERE NOT v.track_inventory)::int AS untracked,
        count(*) FILTER (WHERE v.track_inventory AND COALESCE(l.on_hand,0)-COALESCE(l.reserved,0)
          <= COALESCE(l.low_stock_threshold, st.low_stock_default, 5))::int AS low_count,
        CASE WHEN count(*)=1 THEN min(v.id::text) END AS single_variant_id,
        CASE WHEN count(*)=1 AND bool_and(v.track_inventory) THEN min(COALESCE(l.on_hand,0))::int END AS single_on_hand
      FROM shop_variants v LEFT JOIN inventory_levels l ON l.account_id=v.account_id AND l.variant_id=v.id
      WHERE v.account_id=p.account_id AND v.product_id=p.id AND v.archived_at IS NULL) s
    LEFT JOIN LATERAL (
      SELECT i.url, m.bucket, m.object_key FROM shop_product_images i
      LEFT JOIN media_objects m ON m.account_id=i.account_id AND m.id=i.media_id AND m.deleted_at IS NULL
      WHERE i.account_id=p.account_id AND i.product_id=p.id ORDER BY i.position LIMIT 1) img ON true
    WHERE p.account_id=${accountId}::uuid
      AND (${status}::text = 'all' OR (${status}::text IS NULL AND p.status<>'archived') OR p.status=${status})
      AND (${query.categoryId ?? null}::uuid IS NULL OR p.category_id=${query.categoryId ?? null}::uuid
        OR c.parent_id=${query.categoryId ?? null}::uuid)
      AND (${pattern}::text IS NULL OR p.name ILIKE ${pattern} OR EXISTS (SELECT 1 FROM shop_variants v
        WHERE v.account_id=p.account_id AND v.product_id=p.id AND v.sku ILIKE ${pattern}))
      AND (${stock}::text IS NULL
        OR (${stock}='in_stock' AND (s.available > 0 OR s.untracked > 0))
        OR (${stock}='out' AND s.tracked > 0 AND s.available = 0 AND s.untracked = 0)
        OR (${stock}='low' AND s.low_count > 0))
    ORDER BY lower(p.name), p.id
    LIMIT ${limit} OFFSET ${offset}`;
  let total = rows.length ? Number(rows[0].total) : 0;
  if (!rows.length && offset > 0) total = (await listShopProducts(tx, accountId, { ...query, offset: 0, limit: 1 })).total;
  const settings = await tx.$queryRaw<{ currency: string }[]>`SELECT currency FROM commerce_settings WHERE account_id=${accountId}::uuid`;
  // The public shop address (only once the storefront is published), for "Open on shop" and sharing.
  const [site] = await tx.$queryRaw<{ handle: string }[]>`SELECT handle FROM shop_storefronts WHERE account_id=${accountId}::uuid AND published`;
  return {
    total,
    currency: settings[0]?.currency ?? null,
    shop_url: site ? `${appOrigin()}${PUBLIC_SHOP_PATH}${site.handle}` : null,
    products: rows.map((r) => ({
      id: r.id, name: r.name, status: r.status, category_id: r.category_id, category_name: r.category_name, version: r.version,
      variant_count: r.variant_count, min_price_minor: minorFromDb(r.min_price), max_price_minor: minorFromDb(r.max_price),
      available: Number(r.available), tracked_count: r.tracked, untracked_count: r.untracked, low_count: r.low_count,
      image_url: imageUrl(r.img_url, r.img_bucket, r.img_key), updated_at: r.updated_at.toISOString(),
      single_variant_id: r.single_variant_id, single_on_hand: r.single_on_hand,
    })),
  };
}

export interface ShopVariant {
  id: string;
  sku: string;
  option_values: Record<string, string>;
  price_minor: number | null;
  compare_at_minor: number | null;
  tax_rate_bps: number | null;
  hsn_code: string | null;
  track_inventory: boolean;
  weight_grams: number | null;
  position: number;
  /** The product image this variant shows on the product page; always one of the same product's images. */
  image_id: string | null;
  archived: boolean;
  on_hand: number;
  reserved: number;
  available: number;
  low_stock_threshold: number;
  /** People who asked on WhatsApp to be told when it is back (claimed, open back-in-stock alerts). */
  waiting: number;
  /** A mirrored Meta product with retailer_id = sku exists. */
  meta_linked: boolean;
  /** Some order already holds this variant (removing it from the options asks first). */
  ordered: boolean;
  /** Pre-order (Phase 8): sells past zero stock, shown as "Ships by <date>". */
  preorder: boolean;
  /** YYYY-MM-DD; set whenever `preorder` is on. */
  preorder_ship_date: string | null;
  /** The most open pre-order units; null = no limit. */
  preorder_cap: number | null;
}

export interface BundlePartView {
  variant_id: string;
  quantity: number;
  sku: string;
  name: string;
  /** Units on hand minus reserved; null when the part is made to order. */
  available: number | null;
  archived: boolean;
}

export interface ShopImage {
  id: string;
  media_id: string | null;
  url: string | null;
  /** What the dashboard shows: the https URL or the library object's proxy URL. */
  display_url: string | null;
  position: number;
}

export interface ShopProduct {
  id: string;
  name: string;
  description: string | null;
  disclosure: string | null;
  category_id: string | null;
  status: ProductStatus;
  content_reviewed_by: string | null;
  content_reviewed_at: string | null;
  follow_up_template: string | null;
  follow_up_template_language: string | null;
  follow_up_after_days: number | null;
  /** Days after delivery for the repeat-purchase reminder (Phase 9 D13); null = none. */
  repurchase_after_days: number | null;
  /** Cash on delivery may be chosen for a cart holding this product (when the store offers COD). */
  cod_available: boolean;
  tags: string[];
  brand: string | null;
  product_type: string | null;
  /** Label and value rows shown on the product page (plain text). */
  details: ProductDetail[];
  /** Scheduled publish and hide (ISO date-times, Phase 8); a published product shows only inside this window. */
  publish_at: string | null;
  hide_at: string | null;
  /** A digital product: no shipping; a file from the media library or an https URL, sent after payment. */
  is_digital: boolean;
  digital_media_id: string | null;
  digital_url: string | null;
  /** A bundle: its variants are sold at the bundle's own price and take their parts from stock. */
  is_bundle: boolean;
  /** The readable address /s/<handle>/p/<slug> (null only for a row made before the slug migration finished; it gets one on save). */
  slug: string | null;
  /** Search engine listing; null = the name, the description and the first image. `seo_image_id` is one of `images`. */
  seo_title: string | null;
  seo_description: string | null;
  seo_image_id: string | null;
  bundle_parts: BundlePartView[];
  /** How many bundles the parts allow now (null = no limit). */
  bundle_available: number | null;
  version: number;
  created_at: string;
  updated_at: string;
  currency: string | null;
  variants: ShopVariant[];
  images: ShopImage[];
}

type ProductRow = Omit<ShopProduct, 'content_reviewed_at' | 'created_at' | 'updated_at' | 'variants' | 'images' | 'currency' | 'publish_at' | 'hide_at'
  | 'bundle_parts' | 'bundle_available'> & {
  content_reviewed_at: Date | null; created_at: Date; updated_at: Date; currency: string | null; publish_at: Date | null; hide_at: Date | null;
};
type VariantRow = Omit<ShopVariant, 'price_minor' | 'compare_at_minor' | 'archived' | 'available'> & {
  price_minor: bigint | null; compare_at_minor: bigint | null; archived_at: Date | null;
};

export async function getShopProduct(tx: TenantTransaction, accountId: string, id: string): Promise<ShopProduct> {
  if (!isId(id)) throw new CatalogueError('not_found');
  const rows = await tx.$queryRaw<ProductRow[]>`
    SELECT p.id::text AS id, p.name, p.description, p.disclosure, p.category_id::text AS category_id, p.status,
      p.content_reviewed_by::text AS content_reviewed_by, p.content_reviewed_at, p.follow_up_template, p.follow_up_template_language,
      p.follow_up_after_days, p.repurchase_after_days, p.cod_available, p.tags, p.brand, p.product_type, p.details,
      p.version, p.created_at, p.updated_at, st.currency,
      p.publish_at, p.hide_at, p.is_digital, p.digital_media_id::text AS digital_media_id, p.digital_url, p.is_bundle,
      p.slug, p.seo_title, p.seo_description, p.seo_image_id::text AS seo_image_id
    FROM shop_products p LEFT JOIN commerce_settings st ON st.account_id=p.account_id
    WHERE p.account_id=${accountId}::uuid AND p.id=${id}::uuid`;
  const p = rows[0];
  if (!p) throw new CatalogueError('not_found');
  const variants = await tx.$queryRaw<VariantRow[]>`
    SELECT v.id::text AS id, v.sku, v.option_values, v.price_minor, v.compare_at_minor, v.tax_rate_bps, v.hsn_code, v.track_inventory,
      v.weight_grams, v.position, v.image_id::text AS image_id, v.archived_at, COALESCE(l.on_hand,0) AS on_hand, COALESCE(l.reserved,0) AS reserved,
      COALESCE(l.low_stock_threshold, st.low_stock_default, 5) AS low_stock_threshold,
      (SELECT count(*) FROM shop_stock_alerts a WHERE a.account_id=v.account_id AND a.variant_id=v.id
        AND a.claimed_at IS NOT NULL AND a.closed_at IS NULL)::int AS waiting,
      EXISTS (SELECT 1 FROM products m WHERE m.account_id=v.account_id AND m.retailer_id=v.sku) AS meta_linked,
      EXISTS (SELECT 1 FROM order_items oi WHERE oi.account_id=v.account_id AND oi.variant_id=v.id) AS ordered,
      v.preorder, to_char(v.preorder_ship_date, 'YYYY-MM-DD') AS preorder_ship_date, v.preorder_cap
    FROM shop_variants v
    LEFT JOIN inventory_levels l ON l.account_id=v.account_id AND l.variant_id=v.id
    LEFT JOIN commerce_settings st ON st.account_id=v.account_id
    WHERE v.account_id=${accountId}::uuid AND v.product_id=${id}::uuid
    ORDER BY (v.archived_at IS NOT NULL), v.position, v.created_at, v.id`;
  const images = await tx.$queryRaw<{ id: string; media_id: string | null; url: string | null; bucket: string | null; object_key: string | null; position: number }[]>`
    SELECT i.id::text AS id, i.media_id::text AS media_id, i.url, m.bucket, m.object_key, i.position
    FROM shop_product_images i LEFT JOIN media_objects m ON m.account_id=i.account_id AND m.id=i.media_id AND m.deleted_at IS NULL
    WHERE i.account_id=${accountId}::uuid AND i.product_id=${id}::uuid ORDER BY i.position`;
  const parts = p.is_bundle ? await tx.$queryRaw<{ variant_id: string; quantity: number; sku: string; name: string; option_values: Record<string, string> | null;
    track: boolean; available: number | null; archived_at: Date | null }[]>`
    SELECT b.part_variant_id::text AS variant_id, b.quantity, pv.sku, pp.name, pv.option_values, pv.track_inventory AS track, pv.archived_at,
      COALESCE(l.on_hand - l.reserved, 0) AS available
    FROM shop_bundle_parts b
    JOIN shop_variants pv ON pv.account_id=b.account_id AND pv.id=b.part_variant_id
    JOIN shop_products pp ON pp.account_id=pv.account_id AND pp.id=pv.product_id
    LEFT JOIN inventory_levels l ON l.account_id=pv.account_id AND l.variant_id=pv.id
    WHERE b.account_id=${accountId}::uuid AND b.product_id=${id}::uuid ORDER BY b.position, pp.name, pv.sku` : [];
  const bundleParts: BundlePartView[] = parts.map((r) => {
    const options = Object.values(r.option_values ?? {}).filter(Boolean).join(' / ');
    return { variant_id: r.variant_id, quantity: r.quantity, sku: r.sku, name: options ? `${r.name} (${options})` : r.name,
      available: r.track ? Math.max(Number(r.available ?? 0), 0) : null, archived: !!r.archived_at };
  });
  return {
    ...p,
    details: (Array.isArray(p.details) ? p.details : []) as ProductDetail[],
    publish_at: iso(p.publish_at), hide_at: iso(p.hide_at),
    bundle_parts: bundleParts,
    bundle_available: p.is_bundle ? bundleAvailability(bundleParts.map((b) => ({ quantity: b.quantity, available: b.available, archived: b.archived }))) : null,
    content_reviewed_at: iso(p.content_reviewed_at),
    created_at: p.created_at.toISOString(),
    updated_at: p.updated_at.toISOString(),
    variants: variants.map(({ archived_at, ...v }) => ({
      ...v,
      option_values: (v.option_values ?? {}) as Record<string, string>,
      price_minor: minorFromDb(v.price_minor),
      compare_at_minor: minorFromDb(v.compare_at_minor),
      archived: !!archived_at,
      on_hand: Number(v.on_hand),
      reserved: Number(v.reserved),
      available: Math.max(Number(v.on_hand) - Number(v.reserved), 0),
      low_stock_threshold: Number(v.low_stock_threshold),
      waiting: Number(v.waiting),
    })),
    images: images.map((i) => ({ id: i.id, media_id: i.media_id, url: i.url, display_url: imageUrl(i.url, i.bucket, i.object_key), position: i.position })),
  };
}

// ------------------------------------------------------------ products: writes

const CONTENT_FIELDS = ['name', 'description', 'disclosure'] as const;

/**
 * Create (id null) or update a product. `version`, when given, must match
 * (optimistic concurrency, 409 conflict). Status is changed only by
 * publishProduct / archiveProduct. Editing the content of a published product
 * records the editing admin as its reviewer, so the reviewed text is always
 * the shown text.
 */
export async function upsertProduct(tx: TenantTransaction, accountId: string, userId: string, id: string | null, raw: unknown): Promise<ShopProduct> {
  const b = asBody(raw);
  const current = id ? await getShopProduct(tx, accountId, id) : null;
  const expected = optVersion(b);
  if (current && expected !== null && expected !== current.version) throw new CatalogueError('conflict', 'version');
  const next = {
    name: has(b, 'name') ? text(b, 'name', 1, 200) : current?.name ?? text(b, 'name', 1, 200),
    description: has(b, 'description') ? optText(b, 'description', 5000) : current?.description ?? null,
    disclosure: has(b, 'disclosure') ? optText(b, 'disclosure', 2000) : current?.disclosure ?? null,
    category_id: has(b, 'category_id') ? optId(b, 'category_id') : current?.category_id ?? null,
    follow_up_template: has(b, 'follow_up_template') ? optText(b, 'follow_up_template', 512) : current?.follow_up_template ?? null,
    follow_up_template_language: has(b, 'follow_up_template_language') ? optText(b, 'follow_up_template_language', 15)
      : current?.follow_up_template_language ?? null,
    follow_up_after_days: has(b, 'follow_up_after_days') ? optInt(b, 'follow_up_after_days', 1, 365) : current?.follow_up_after_days ?? null,
    repurchase_after_days: has(b, 'repurchase_after_days') ? optInt(b, 'repurchase_after_days', 1, 365) : current?.repurchase_after_days ?? null,
    cod_available: has(b, 'cod_available') ? bool(b, 'cod_available') : current?.cod_available ?? true,
    tags: has(b, 'tags') ? parseTags(b.tags) : current?.tags ?? [],
    brand: has(b, 'brand') ? optPlainLine(b, 'brand', 80) : current?.brand ?? null,
    product_type: has(b, 'product_type') ? optPlainLine(b, 'product_type', 80) : current?.product_type ?? null,
    details: has(b, 'details') ? parseDetails(b.details) : current?.details ?? [],
    publish_at: has(b, 'publish_at') ? scheduleTime(b, 'publish_at') : current ? (current.publish_at ? new Date(current.publish_at) : null) : null,
    hide_at: has(b, 'hide_at') ? scheduleTime(b, 'hide_at') : current ? (current.hide_at ? new Date(current.hide_at) : null) : null,
    is_digital: has(b, 'is_digital') ? bool(b, 'is_digital') : current?.is_digital ?? false,
    digital_media_id: has(b, 'digital_media_id') ? optId(b, 'digital_media_id') : current?.digital_media_id ?? null,
    digital_url: has(b, 'digital_url') ? optHttpsUrl(b, 'digital_url') : current?.digital_url ?? null,
    is_bundle: has(b, 'is_bundle') ? bool(b, 'is_bundle') : current?.is_bundle ?? false,
    seo_title: has(b, 'seo_title') ? optPlainLine(b, 'seo_title', SEO_TITLE_MAX) : current?.seo_title ?? null,
    seo_description: has(b, 'seo_description') ? optPlainLine(b, 'seo_description', SEO_DESCRIPTION_MAX) : current?.seo_description ?? null,
    seo_image_id: has(b, 'seo_image_id') ? optId(b, 'seo_image_id') : current?.seo_image_id ?? null,
  };
  // The share image is one of the product's own saved images (the database checks it too).
  if (next.seo_image_id && !current?.images.some((i) => i.id === next.seo_image_id)) throw new CatalogueError('invalid', 'seo_image_id');
  if (scheduleProblem(next.publish_at, next.hide_at)) throw new CatalogueError('invalid', 'hide_at');
  if (next.is_digital && next.is_bundle) throw new CatalogueError('invalid', 'is_bundle');
  if (!next.is_digital) { next.digital_media_id = null; next.digital_url = null; }
  else {
    // Exactly one source: a library file or an https URL.
    if ((next.digital_media_id === null) === (next.digital_url === null)) throw new CatalogueError('invalid', 'digital_url');
    if (next.digital_media_id && next.digital_media_id !== current?.digital_media_id) {
      const media = await tx.$queryRaw<{ id: string }[]>`SELECT id::text AS id FROM media_objects
        WHERE account_id=${accountId}::uuid AND id=${next.digital_media_id}::uuid AND deleted_at IS NULL`;
      if (!media[0]) throw new CatalogueError('invalid', 'digital_media_id');
    }
  }
  if (next.is_digital && current && !current.is_digital && current.variants.some((v) => v.preorder)) throw new CatalogueError('invalid', 'is_digital');
  if (next.follow_up_template && !next.follow_up_template_language) throw new CatalogueError('invalid', 'follow_up_template_language');
  if (!next.follow_up_template) { next.follow_up_template_language = null; next.follow_up_after_days = null; }
  if (next.category_id && next.category_id !== current?.category_id) {
    const cat = await tx.$queryRaw<{ id: string }[]>`SELECT id::text AS id FROM shop_categories
      WHERE account_id=${accountId}::uuid AND id=${next.category_id}::uuid AND archived_at IS NULL`;
    if (!cat[0]) throw new CatalogueError('invalid', 'category_id');
  }
  let productId = id;
  // Last before the write: takes the workspace's slug lock.
  const slug = await nextSlug(tx, accountId, 'product', {
    id: current?.id ?? null, name: next.name, current: current ? { slug: current.slug, name: current.name } : null, requested: parseSlugInput(b.slug),
  });
  if (!current) {
    const rows = await tx.$queryRaw<{ id: string }[]>`
      INSERT INTO shop_products(account_id,name,description,disclosure,category_id,follow_up_template,follow_up_template_language,
        follow_up_after_days,repurchase_after_days,cod_available,tags,brand,product_type,details,created_by,
        publish_at,hide_at,is_digital,digital_media_id,digital_url,is_bundle,slug,seo_title,seo_description)
      VALUES(${accountId}::uuid,${next.name},${next.description},${next.disclosure},${next.category_id}::uuid,${next.follow_up_template},
        ${next.follow_up_template_language},${next.follow_up_after_days},${next.repurchase_after_days},${next.cod_available},
        ${next.tags}::text[],${next.brand},${next.product_type},${JSON.stringify(next.details)}::jsonb,${userId}::uuid,
        ${next.publish_at}::timestamptz,${next.hide_at}::timestamptz,${next.is_digital},${next.digital_media_id}::uuid,${next.digital_url},${next.is_bundle},
        ${slug},${next.seo_title},${next.seo_description})
      RETURNING id::text AS id`.catch((e) => mapDbError(e, 'name'));
    productId = rows[0].id;
    await auditCatalogue(tx, accountId, userId, 'commerce.product_created', productId);
  } else {
    const contentChanged = CONTENT_FIELDS.some((k) => next[k] !== current[k]);
    const rereview = contentChanged && current.status === 'published';
    const changed = await tx.$executeRaw`
      UPDATE shop_products SET name=${next.name}, description=${next.description}, disclosure=${next.disclosure},
        category_id=${next.category_id}::uuid, follow_up_template=${next.follow_up_template},
        follow_up_template_language=${next.follow_up_template_language}, follow_up_after_days=${next.follow_up_after_days},
        repurchase_after_days=${next.repurchase_after_days}, cod_available=${next.cod_available},
        tags=${next.tags}::text[], brand=${next.brand}, product_type=${next.product_type}, details=${JSON.stringify(next.details)}::jsonb,
        publish_at=${next.publish_at}::timestamptz, hide_at=${next.hide_at}::timestamptz, is_digital=${next.is_digital},
        digital_media_id=${next.digital_media_id}::uuid, digital_url=${next.digital_url}, is_bundle=${next.is_bundle},
        slug=${slug}, seo_title=${next.seo_title}, seo_description=${next.seo_description}, seo_image_id=${next.seo_image_id}::uuid,
        content_reviewed_by=CASE WHEN ${rereview} THEN ${userId}::uuid ELSE content_reviewed_by END,
        content_reviewed_at=CASE WHEN ${rereview} THEN now() ELSE content_reviewed_at END,
        version=version+1
      WHERE account_id=${accountId}::uuid AND id=${current.id}::uuid AND version=${current.version}`.catch((e) => mapDbError(e, 'name'));
    if (changed !== 1) throw new CatalogueError('conflict', 'version');
    if (current.slug && current.slug !== slug) await recordSlugMove(tx, accountId, userId, 'product', current.slug, slug);
    await auditCatalogue(tx, accountId, userId, 'commerce.product_updated', current.id,
      { fields: Object.keys(b).filter((k) => has(b, k) && k !== 'version' && k !== 'images'), rereviewed: rereview });
  }
  if (has(b, 'images')) await replaceImages(tx, accountId, userId, productId!, b.images);
  return getShopProduct(tx, accountId, productId!);
}

/** Replace the product's images (at most ten, in order): a library image id or an https URL each. */
async function replaceImages(tx: TenantTransaction, accountId: string, userId: string, productId: string, raw: unknown) {
  if (!Array.isArray(raw) || raw.length > MAX_IMAGES) throw new CatalogueError('invalid', 'images');
  const images = raw.map((item) => {
    const b = asBody(item);
    const mediaId = has(b, 'media_id') ? optId(b, 'media_id') : null;
    const url = has(b, 'url') ? optText(b, 'url', 2048) : null;
    if ((mediaId === null) === (url === null)) throw new CatalogueError('invalid', 'images');
    if (url) {
      let parsed: URL;
      try { parsed = new URL(url); } catch { throw new CatalogueError('invalid', 'images'); }
      if (parsed.protocol !== 'https:' || parsed.username || parsed.password) throw new CatalogueError('invalid', 'images');
    }
    return { mediaId, url };
  });
  const mediaIds = images.flatMap((i) => (i.mediaId ? [i.mediaId] : []));
  if (mediaIds.length) {
    const found = await tx.$queryRaw<{ id: string }[]>`SELECT id::text AS id FROM media_objects
      WHERE account_id=${accountId}::uuid AND id = ANY(${mediaIds}::uuid[]) AND deleted_at IS NULL AND content_type LIKE 'image/%'`;
    if (new Set(found.map((r) => r.id)).size !== new Set(mediaIds).size) throw new CatalogueError('invalid', 'images', 'media');
  }
  // Deleting an image clears the variants pointing at it, so remember each pick and restore it onto the same picture (media or URL) afterwards.
  const picks = await tx.$queryRaw<{ id: string; media_id: string | null; url: string | null }[]>`
    SELECT v.id::text AS id, i.media_id::text AS media_id, i.url FROM shop_variants v
    JOIN shop_product_images i ON i.account_id=v.account_id AND i.product_id=v.product_id AND i.id=v.image_id
    WHERE v.account_id=${accountId}::uuid AND v.product_id=${productId}::uuid`;
  // The share image (seo_image_id) is cleared by the same delete; it is put back onto the same picture when that picture stays.
  const [share] = await tx.$queryRaw<{ media_id: string | null; url: string | null }[]>`
    SELECT i.media_id::text AS media_id, i.url FROM shop_products p
    JOIN shop_product_images i ON i.account_id=p.account_id AND i.product_id=p.id AND i.id=p.seo_image_id
    WHERE p.account_id=${accountId}::uuid AND p.id=${productId}::uuid`;
  await tx.$executeRaw`DELETE FROM shop_product_images WHERE account_id=${accountId}::uuid AND product_id=${productId}::uuid`;
  for (const [position, image] of images.entries())
    await tx.$executeRaw`INSERT INTO shop_product_images(account_id,product_id,media_id,url,position)
      VALUES(${accountId}::uuid,${productId}::uuid,${image.mediaId}::uuid,${image.url},${position})`;
  for (const pick of picks)
    await tx.$executeRaw`UPDATE shop_variants SET image_id=(
        SELECT id FROM shop_product_images WHERE account_id=${accountId}::uuid AND product_id=${productId}::uuid
          AND ((${pick.media_id}::uuid IS NOT NULL AND media_id=${pick.media_id}::uuid) OR (${pick.url}::text IS NOT NULL AND url=${pick.url}))
        ORDER BY position LIMIT 1)
      WHERE account_id=${accountId}::uuid AND id=${pick.id}::uuid`;
  if (share)
    await tx.$executeRaw`UPDATE shop_products SET seo_image_id=(
        SELECT id FROM shop_product_images WHERE account_id=${accountId}::uuid AND product_id=${productId}::uuid
          AND ((${share.media_id}::uuid IS NOT NULL AND media_id=${share.media_id}::uuid) OR (${share.url}::text IS NOT NULL AND url=${share.url}))
        ORDER BY position LIMIT 1)
      WHERE account_id=${accountId}::uuid AND id=${productId}::uuid`;
  await auditCatalogue(tx, accountId, userId, 'commerce.product_images_set', productId, { count: images.length });
}

async function lockProduct(tx: TenantTransaction, accountId: string, id: string) {
  if (!isId(id)) throw new CatalogueError('not_found');
  const rows = await tx.$queryRaw<{ status: ProductStatus; version: number }[]>`SELECT status, version FROM shop_products
    WHERE account_id=${accountId}::uuid AND id=${id}::uuid FOR UPDATE`;
  if (!rows[0]) throw new CatalogueError('not_found');
  return rows[0];
}

async function pricedVariantCount(tx: TenantTransaction, accountId: string, productId: string, exceptVariant: string | null = null) {
  const rows = await tx.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM shop_variants WHERE account_id=${accountId}::uuid
    AND product_id=${productId}::uuid AND archived_at IS NULL AND price_minor IS NOT NULL
    AND (${exceptVariant}::uuid IS NULL OR id<>${exceptVariant}::uuid)`;
  return Number(rows[0]?.n ?? 0);
}

/** Publish (admin): requires at least one priced, active variant; records the publishing admin as the content reviewer. */
export async function publishProduct(tx: TenantTransaction, accountId: string, userId: string, id: string, raw: unknown = {}): Promise<ShopProduct> {
  const b = asBody(raw ?? {});
  const current = await lockProduct(tx, accountId, id);
  const expected = optVersion(b);
  if (expected !== null && expected !== current.version) throw new CatalogueError('conflict', 'version');
  if ((await pricedVariantCount(tx, accountId, id)) === 0) throw new CatalogueError('needs_priced_variant');
  // A bundle with no parts would sell nothing it can take from stock.
  const [bundle] = await tx.$queryRaw<{ is_bundle: boolean; parts: number }[]>`SELECT p.is_bundle,
    (SELECT count(*)::int FROM shop_bundle_parts b WHERE b.account_id=p.account_id AND b.product_id=p.id) AS parts
    FROM shop_products p WHERE p.account_id=${accountId}::uuid AND p.id=${id}::uuid`;
  if (bundle?.is_bundle && bundle.parts === 0) throw new CatalogueError('invalid', 'parts');
  await tx.$executeRaw`UPDATE shop_products SET status='published', content_reviewed_by=${userId}::uuid, content_reviewed_at=now(),
      version=version+1 WHERE account_id=${accountId}::uuid AND id=${id}::uuid`;
  await auditCatalogue(tx, accountId, userId, 'commerce.product_published', id);
  return getShopProduct(tx, accountId, id);
}

/** Archive (hidden from the storefront and new orders; existing orders keep their snapshots) or restore to draft. */
export async function archiveProduct(tx: TenantTransaction, accountId: string, userId: string, id: string, archived: boolean): Promise<ShopProduct> {
  const current = await lockProduct(tx, accountId, id);
  const status: ProductStatus = archived ? 'archived' : current.status === 'archived' ? 'draft' : current.status;
  if (status !== current.status) {
    await tx.$executeRaw`UPDATE shop_products SET status=${status}, version=version+1 WHERE account_id=${accountId}::uuid AND id=${id}::uuid`;
    await auditCatalogue(tx, accountId, userId, archived ? 'commerce.product_archived' : 'commerce.product_restored', id);
  }
  return getShopProduct(tx, accountId, id);
}

/** Back to draft: off the storefront, content kept. */
export async function unpublishProduct(tx: TenantTransaction, accountId: string, userId: string, id: string): Promise<ShopProduct> {
  const current = await lockProduct(tx, accountId, id);
  if (current.status === 'published') {
    await tx.$executeRaw`UPDATE shop_products SET status='draft', version=version+1 WHERE account_id=${accountId}::uuid AND id=${id}::uuid`;
    await auditCatalogue(tx, accountId, userId, 'commerce.product_unpublished', id);
  }
  return getShopProduct(tx, accountId, id);
}

/** The SKU for a copy: `<sku>-copy`, then `-copy2`, `-copy3`... trimmed to the 64-character limit. */
export function copySku(sku: string, attempt: number): string {
  const suffix = attempt <= 1 ? '-copy' : `-copy${attempt}`;
  return `${sku.slice(0, 64 - suffix.length)}${suffix}`;
}

/** The name for a copy (" copy" appended, within the 200-character limit). */
export const copyName = (name: string, suffix = ' copy'): string => `${name.slice(0, 200 - suffix.length)}${suffix}`;

/**
 * Duplicate a product (admins): a new draft named "<name> copy" with the same
 * content, category (when still active), images and variants (prices and
 * options kept, each SKU suffixed so it stays unique). Stock is never copied:
 * the copy starts at zero on hand. One transaction; audited with ids only.
 */
export async function duplicateProduct(tx: TenantTransaction, accountId: string, userId: string, id: string, raw: unknown = {}): Promise<ShopProduct> {
  const b = asBody(raw ?? {});
  const name = has(b, 'name') ? text(b, 'name', 1, 200) : null;
  const source = await getShopProduct(tx, accountId, id);
  const category = source.category_id ? (await tx.$queryRaw<{ id: string }[]>`SELECT id::text AS id FROM shop_categories
    WHERE account_id=${accountId}::uuid AND id=${source.category_id}::uuid AND archived_at IS NULL`)[0]?.id ?? null : null;
  const copyTitle = name ?? copyName(source.name);
  // The copy gets its own address from its name; the search listing text is copied, the share image is not (new image ids).
  const slug = await nextSlug(tx, accountId, 'product', { id: null, name: copyTitle, current: null });
  const rows = await tx.$queryRaw<{ id: string }[]>`
    INSERT INTO shop_products(account_id,name,description,disclosure,category_id,follow_up_template,follow_up_template_language,
      follow_up_after_days,repurchase_after_days,cod_available,tags,brand,product_type,details,created_by,
      is_digital,digital_media_id,digital_url,is_bundle,slug,seo_title,seo_description)
    VALUES(${accountId}::uuid,${copyTitle},${source.description},${source.disclosure},${category}::uuid,
      ${source.follow_up_template},${source.follow_up_template_language},${source.follow_up_after_days},${source.repurchase_after_days},
      ${source.cod_available},${source.tags}::text[],${source.brand},${source.product_type},${JSON.stringify(source.details)}::jsonb,${userId}::uuid,
      ${source.is_digital},${source.digital_media_id}::uuid,${source.digital_url},${source.is_bundle},${slug},${source.seo_title},${source.seo_description})
    RETURNING id::text AS id`.catch((e) => mapDbError(e, 'name'));
  const copyId = rows[0].id;
  // The copy is a draft with no schedule; a bundle keeps its parts.
  await tx.$executeRaw`INSERT INTO shop_bundle_parts(account_id,product_id,part_variant_id,quantity,position)
    SELECT account_id, ${copyId}::uuid, part_variant_id, quantity, position FROM shop_bundle_parts
    WHERE account_id=${accountId}::uuid AND product_id=${source.id}::uuid`;
  await tx.$executeRaw`INSERT INTO shop_product_images(account_id,product_id,media_id,url,position)
    SELECT account_id, ${copyId}::uuid, media_id, url, position FROM shop_product_images
    WHERE account_id=${accountId}::uuid AND product_id=${source.id}::uuid ORDER BY position`;
  for (const v of source.variants.filter((x) => !x.archived)) {
    let sku: string | null = null;
    for (let attempt = 1; attempt <= 20 && !sku; attempt++) {
      const candidate = copySku(v.sku, attempt);
      const taken = await tx.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM shop_variants
        WHERE account_id=${accountId}::uuid AND sku=${candidate}`;
      if ((taken[0]?.n ?? 0) === 0) sku = candidate;
    }
    if (!sku) throw new CatalogueError('sku_taken', 'sku');
    await tx.$executeRaw`
      INSERT INTO shop_variants(account_id,product_id,sku,option_values,price_minor,compare_at_minor,tax_rate_bps,hsn_code,track_inventory,
        weight_grams,position,image_id,preorder,preorder_ship_date,preorder_cap)
      VALUES(${accountId}::uuid,${copyId}::uuid,${sku},${JSON.stringify(v.option_values)}::jsonb,${v.price_minor}::bigint,
        ${v.compare_at_minor}::bigint,${v.tax_rate_bps},${v.hsn_code},${v.track_inventory},${v.weight_grams},${v.position},
        (SELECT n.id FROM shop_product_images o JOIN shop_product_images n ON n.account_id=o.account_id AND n.position=o.position
          WHERE o.account_id=${accountId}::uuid AND o.id=${v.image_id}::uuid AND n.product_id=${copyId}::uuid),
        ${v.preorder},${v.preorder_ship_date}::date,${v.preorder_cap})`
      .catch((e) => mapDbError(e, 'sku'));
  }
  await auditCatalogue(tx, accountId, userId, 'commerce.product_duplicated', copyId, { source_id: source.id });
  return getShopProduct(tx, accountId, copyId);
}

// ------------------------------------------------------------ variants

/** A variant row as stored (prices raw from the database), as read FOR UPDATE before a change. */
export interface VariantCurrent {
  id: string; sku: string; option_values: unknown; price_minor: bigint | null; compare_at_minor: bigint | null; tax_rate_bps: number | null;
  hsn_code: string | null; track_inventory: boolean; weight_grams: number | null; position: number; image_id: string | null;
  archived_at: Date | null; preorder: boolean; preorder_ship_date: string | null; preorder_cap: number | null;
}

/** The product's variants FOR UPDATE (one variant when `variantId` is given). */
export async function lockVariants(tx: TenantTransaction, accountId: string, productId: string, variantId: string | null = null): Promise<VariantCurrent[]> {
  return tx.$queryRaw<VariantCurrent[]>`
    SELECT id::text AS id, sku, option_values, price_minor, compare_at_minor, tax_rate_bps, hsn_code, track_inventory, weight_grams, position,
      image_id::text AS image_id, archived_at,
      preorder, to_char(preorder_ship_date, 'YYYY-MM-DD') AS preorder_ship_date, preorder_cap
    FROM shop_variants WHERE account_id=${accountId}::uuid AND product_id=${productId}::uuid
      AND (${variantId}::uuid IS NULL OR id=${variantId}::uuid)
    ORDER BY position, created_at, id FOR UPDATE`;
}

/** Facts a batch of variant writes looks up once (product kind, whether the store has a currency). */
export interface VariantWriteCache { kind?: { is_bundle: boolean; is_digital: boolean }; currency?: boolean }

const sameOptions = (a: unknown, b: Record<string, string>) => JSON.stringify(a ?? {}) === JSON.stringify(b);

/**
 * Validate and write one variant (create when `current` is undefined) without
 * reading the product back or bumping its version. Returns the variant id.
 * `checkPriced` keeps a published product's last priced, active variant; a
 * batch that writes several variants checks once at the end instead. An update
 * that changes nothing writes nothing (so no sync trigger fires).
 */
export async function applyVariant(tx: TenantTransaction, accountId: string, userId: string, product: { id: string; status: ProductStatus },
  current: VariantCurrent | undefined, raw: unknown, opts: { checkPriced: boolean; cache?: VariantWriteCache }): Promise<string> {
  const b = asBody(raw);
  const cache = opts.cache ?? {};
  const productId = product.id;
  const sku = has(b, 'sku') ? text(b, 'sku', 1, 64) : current?.sku ?? text(b, 'sku', 1, 64);
  if (!SKU.test(sku)) throw new CatalogueError('invalid', 'sku');
  const next = {
    sku,
    option_values: has(b, 'option_values') ? parseOptionValues(b.option_values) : (current?.option_values ?? {}) as Record<string, string>,
    price_minor: has(b, 'price_minor') ? optInt(b, 'price_minor', 0, MAX_MINOR) : minorFromDb(current?.price_minor),
    compare_at_minor: has(b, 'compare_at_minor') ? optInt(b, 'compare_at_minor', 0, MAX_MINOR) : minorFromDb(current?.compare_at_minor),
    tax_rate_bps: has(b, 'tax_rate_bps') ? optInt(b, 'tax_rate_bps', 0, 10000) : current?.tax_rate_bps ?? null,
    hsn_code: has(b, 'hsn_code') ? optText(b, 'hsn_code', 8) : current?.hsn_code ?? null,
    track_inventory: has(b, 'track_inventory') ? bool(b, 'track_inventory') : current?.track_inventory ?? true,
    weight_grams: has(b, 'weight_grams') ? optInt(b, 'weight_grams', 0, 1_000_000) : current?.weight_grams ?? null,
    position: has(b, 'position') ? int(b, 'position', 0, 10000) : current?.position ?? 0,
    archived: has(b, 'archived') ? bool(b, 'archived') : !!current?.archived_at,
    image_id: has(b, 'image_id') ? optId(b, 'image_id') : current?.image_id ?? null,
    preorder: has(b, 'preorder') ? bool(b, 'preorder') : current?.preorder ?? false,
    preorder_ship_date: has(b, 'preorder_ship_date') ? shipDate(b, 'preorder_ship_date') : current?.preorder_ship_date ?? null,
    preorder_cap: has(b, 'preorder_cap') ? optInt(b, 'preorder_cap', 1, 1_000_000) : current?.preorder_cap ?? null,
  };
  if (current && next.sku === current.sku && sameOptions(current.option_values, next.option_values)
    && next.price_minor === minorFromDb(current.price_minor) && next.compare_at_minor === minorFromDb(current.compare_at_minor)
    && next.tax_rate_bps === current.tax_rate_bps && next.hsn_code === current.hsn_code && next.track_inventory === current.track_inventory
    && next.weight_grams === current.weight_grams && next.position === current.position && next.archived === !!current.archived_at
    && next.image_id === current.image_id && next.preorder === current.preorder && next.preorder_ship_date === current.preorder_ship_date
    && next.preorder_cap === current.preorder_cap) return current.id;
  // Only an image of this product (the composite foreign key says the same underneath).
  if (next.image_id && next.image_id !== current?.image_id) {
    const own = await tx.$queryRaw<{ id: string }[]>`SELECT id::text AS id FROM shop_product_images
      WHERE account_id=${accountId}::uuid AND product_id=${productId}::uuid AND id=${next.image_id}::uuid`;
    if (!own[0]) throw new CatalogueError('invalid', 'image_id');
  }
  if (next.hsn_code && !HSN.test(next.hsn_code)) throw new CatalogueError('invalid', 'hsn_code');
  const pre = preorderProblem({ preorder: next.preorder, shipDate: next.preorder_ship_date, cap: next.preorder_cap });
  if (pre) throw new CatalogueError('invalid', pre === 'ship_date' ? 'preorder_ship_date' : 'preorder_cap');
  if (next.preorder) {
    // A pre-order sells a physical product that is not a bundle or a download.
    cache.kind ??= (await tx.$queryRaw<{ is_bundle: boolean; is_digital: boolean }[]>`SELECT is_bundle, is_digital FROM shop_products
      WHERE account_id=${accountId}::uuid AND id=${productId}::uuid`)[0];
    if (cache.kind?.is_bundle || cache.kind?.is_digital) throw new CatalogueError('invalid', 'preorder');
  }
  if ((next.price_minor !== null || next.compare_at_minor !== null) && !cache.currency) {
    // Shared lock: a concurrent currency change (FOR UPDATE, then currencyInUse) commits first or sees this price.
    const settings = await tx.$queryRaw<{ currency: string }[]>`SELECT currency FROM commerce_settings WHERE account_id=${accountId}::uuid FOR SHARE`;
    if (!settings[0]) throw new CatalogueError('store_not_configured', 'price_minor');
    cache.currency = true;
  }
  const stillPriced = next.price_minor !== null && !next.archived;
  if (opts.checkPriced && product.status === 'published' && !stillPriced && (await pricedVariantCount(tx, accountId, productId, current?.id ?? null)) === 0)
    throw new CatalogueError('needs_priced_variant', 'price_minor');
  const options = JSON.stringify(next.option_values);
  if (!current) {
    const rows = await tx.$queryRaw<{ id: string }[]>`
      INSERT INTO shop_variants(account_id,product_id,sku,option_values,price_minor,compare_at_minor,tax_rate_bps,hsn_code,track_inventory,
        weight_grams,position,image_id,archived_at,preorder,preorder_ship_date,preorder_cap)
      VALUES(${accountId}::uuid,${productId}::uuid,${next.sku},${options}::jsonb,${next.price_minor}::bigint,${next.compare_at_minor}::bigint,
        ${next.tax_rate_bps},${next.hsn_code},${next.track_inventory},${next.weight_grams},${next.position},${next.image_id}::uuid,
        CASE WHEN ${next.archived} THEN now() END,${next.preorder},${next.preorder_ship_date}::date,${next.preorder_cap})
      RETURNING id::text AS id`.catch((e) => mapDbError(e, 'sku'));
    await auditCatalogue(tx, accountId, userId, 'commerce.variant_created', rows[0].id, { product_id: productId });
    return rows[0].id;
  }
  await tx.$executeRaw`
    UPDATE shop_variants SET sku=${next.sku}, option_values=${options}::jsonb, price_minor=${next.price_minor}::bigint,
      compare_at_minor=${next.compare_at_minor}::bigint, tax_rate_bps=${next.tax_rate_bps}, hsn_code=${next.hsn_code},
      track_inventory=${next.track_inventory}, weight_grams=${next.weight_grams}, position=${next.position}, image_id=${next.image_id}::uuid,
      preorder=${next.preorder}, preorder_ship_date=${next.preorder_ship_date}::date, preorder_cap=${next.preorder_cap},
      archived_at=CASE WHEN ${next.archived} THEN COALESCE(archived_at, now()) ELSE NULL END
    WHERE account_id=${accountId}::uuid AND id=${current.id}::uuid`.catch((e) => mapDbError(e, 'sku'));
  const priceChanged = minorFromDb(current.price_minor) !== next.price_minor;
  await auditCatalogue(tx, accountId, userId, 'commerce.variant_updated', current.id, {
    product_id: productId, fields: Object.keys(b).filter((k) => has(b, k)),
    // Prices are the seller's own configuration, not customer content.
    ...(priceChanged ? { price_from: minorFromDb(current.price_minor), price_to: next.price_minor } : {}),
  });
  return current.id;
}

/**
 * Create (variantId null) or update a variant. Prices are integer minor units
 * of the store currency, so setting a price needs the store settings first
 * (store_not_configured). A published product must keep one priced, active
 * variant (needs_priced_variant). Stock is never written here (stock.ts).
 */
export async function upsertVariant(tx: TenantTransaction, accountId: string, userId: string, productId: string,
  variantId: string | null, raw: unknown): Promise<ShopProduct> {
  const b = asBody(raw);
  const product = await lockProduct(tx, accountId, productId);
  let current: VariantCurrent | undefined;
  if (variantId) {
    if (!isId(variantId)) throw new CatalogueError('not_found');
    current = (await lockVariants(tx, accountId, productId, variantId))[0];
    if (!current) throw new CatalogueError('not_found');
  }
  await applyVariant(tx, accountId, userId, { id: productId, status: product.status }, current, b, { checkPriced: true });
  await tx.$executeRaw`UPDATE shop_products SET version=version+1 WHERE account_id=${accountId}::uuid AND id=${productId}::uuid`;
  return getShopProduct(tx, accountId, productId);
}

// ------------------------------------------------------------ bundle parts

export const MAX_BUNDLE_PARTS = 20;

/**
 * Replace a bundle product's parts (admins): at most 20 distinct variants of other, physical products, each with
 * a whole quantity of 1 to 99. The product must be marked as a bundle. The database refuses a part that is
 * itself a bundle or a download (no nesting). The bundle is sold at its own variants' prices; the parts only
 * decide stock (stock.ts reserves them on checkout and puts them back on a return).
 */
export async function setBundleParts(tx: TenantTransaction, accountId: string, userId: string, id: string, raw: unknown): Promise<ShopProduct> {
  await writeBundleParts(tx, accountId, userId, id, raw);
  await tx.$executeRaw`UPDATE shop_products SET version=version+1 WHERE account_id=${accountId}::uuid AND id=${id}::uuid`;
  return getShopProduct(tx, accountId, id);
}

/** setBundleParts without the version bump and the read back (the product form saves parts with everything else). */
export async function writeBundleParts(tx: TenantTransaction, accountId: string, userId: string, id: string, raw: unknown): Promise<void> {
  const b = asBody(raw);
  if (!isId(id)) throw new CatalogueError('not_found');
  const [product] = await tx.$queryRaw<{ is_bundle: boolean }[]>`SELECT is_bundle FROM shop_products
    WHERE account_id=${accountId}::uuid AND id=${id}::uuid`;
  if (!product) throw new CatalogueError('not_found');
  if (!product.is_bundle) throw new CatalogueError('invalid', 'is_bundle');
  const list = b.parts;
  if (!Array.isArray(list) || list.length > MAX_BUNDLE_PARTS) throw new CatalogueError('invalid', 'parts');
  const parts = list.map((item) => {
    const p = asBody(item);
    return { variantId: has(p, 'variant_id') && isId(p.variant_id) ? p.variant_id.toLowerCase() : null, quantity: int(p, 'quantity', 1, 99) };
  });
  if (parts.some((p) => p.variantId === null) || new Set(parts.map((p) => p.variantId)).size !== parts.length) throw new CatalogueError('invalid', 'parts');
  const ids = parts.map((p) => p.variantId as string);
  if (ids.length) {
    const found = await tx.$queryRaw<{ id: string }[]>`SELECT id::text AS id FROM shop_variants
      WHERE account_id=${accountId}::uuid AND id = ANY(${ids}::uuid[]) AND archived_at IS NULL`;
    if (found.length !== ids.length) throw new CatalogueError('invalid', 'parts');
  }
  await tx.$executeRaw`DELETE FROM shop_bundle_parts WHERE account_id=${accountId}::uuid AND product_id=${id}::uuid`;
  for (const [position, part] of parts.entries())
    await tx.$executeRaw`INSERT INTO shop_bundle_parts(account_id,product_id,part_variant_id,quantity,position)
      VALUES(${accountId}::uuid,${id}::uuid,${part.variantId}::uuid,${part.quantity},${position})`.catch((e) => mapDbError(e, 'parts'));
  await auditCatalogue(tx, accountId, userId, 'commerce.bundle_parts_set', id, { count: parts.length });
}

// ------------------------------------------------------------ Meta mirror

export interface MetaLinkReport {
  /** The store currency of `price_minor` (null before store settings exist). */
  currency: string | null;
  linked: { variant_id: string; product_id: string; product_name: string; sku: string; meta_product_id: string; meta_name: string;
    meta_price_minor: number | null; meta_currency: string | null; price_minor: number | null }[];
  /** Active variants whose SKU has no mirrored Meta product. */
  variants_without_meta: { variant_id: string; product_id: string; product_name: string; sku: string }[];
  /** Mirrored Meta products (not hidden) whose retailer_id matches no variant. */
  meta_without_variant: { meta_product_id: string; retailer_id: string; name: string; price_minor: number | null; currency: string | null;
    importable: boolean }[];
}

const REPORT_CAP = 500;

/** Match by products.retailer_id = shop_variants.sku and list what is unmatched on each side (read-only). */
export async function linkMetaProducts(tx: TenantTransaction, accountId: string): Promise<MetaLinkReport> {
  const linked = await tx.$queryRaw<{ variant_id: string; product_id: string; product_name: string; sku: string; meta_product_id: string;
    meta_name: string; meta_price: bigint | null; meta_currency: string | null; price: bigint | null }[]>`
    SELECT DISTINCT ON (v.id) v.id::text AS variant_id, p.id::text AS product_id, p.name AS product_name, v.sku,
      m.id::text AS meta_product_id, m.name AS meta_name, m.price_minor AS meta_price, m.currency AS meta_currency, v.price_minor AS price
    FROM shop_variants v JOIN shop_products p ON p.account_id=v.account_id AND p.id=v.product_id
    JOIN products m ON m.account_id=v.account_id AND m.retailer_id=v.sku
    WHERE v.account_id=${accountId}::uuid AND v.archived_at IS NULL
    ORDER BY v.id, m.is_hidden, m.synced_at DESC LIMIT ${REPORT_CAP}`;
  const variants = await tx.$queryRaw<MetaLinkReport['variants_without_meta']>`
    SELECT v.id::text AS variant_id, p.id::text AS product_id, p.name AS product_name, v.sku
    FROM shop_variants v JOIN shop_products p ON p.account_id=v.account_id AND p.id=v.product_id
    WHERE v.account_id=${accountId}::uuid AND v.archived_at IS NULL AND p.status<>'archived'
      AND NOT EXISTS (SELECT 1 FROM products m WHERE m.account_id=v.account_id AND m.retailer_id=v.sku)
    ORDER BY lower(p.name), v.sku LIMIT ${REPORT_CAP}`;
  const meta = await tx.$queryRaw<{ meta_product_id: string; retailer_id: string; name: string; price: bigint | null; currency: string | null }[]>`
    SELECT DISTINCT ON (m.retailer_id) m.id::text AS meta_product_id, m.retailer_id, m.name, m.price_minor AS price, m.currency
    FROM products m
    WHERE m.account_id=${accountId}::uuid AND NOT m.is_hidden
      AND NOT EXISTS (SELECT 1 FROM shop_variants v WHERE v.account_id=m.account_id AND v.sku=m.retailer_id)
    ORDER BY m.retailer_id, m.synced_at DESC LIMIT ${REPORT_CAP}`;
  const settings = await tx.$queryRaw<{ currency: string }[]>`SELECT currency FROM commerce_settings WHERE account_id=${accountId}::uuid`;
  return {
    currency: settings[0]?.currency ?? null,
    linked: linked.map(({ meta_price, price, ...r }) => ({ ...r, meta_price_minor: minorFromDb(meta_price), price_minor: minorFromDb(price) })),
    variants_without_meta: variants,
    meta_without_variant: meta.map(({ price, ...r }) => ({ ...r, price_minor: minorFromDb(price), importable: SKU.test(r.retailer_id) })),
  };
}

/**
 * Create draft products (one variant each, SKU = retailer_id) from mirrored
 * Meta products. Never overwrites: a retailer_id that already is a variant SKU
 * is skipped. The Meta price is copied only when it is in the store currency;
 * nothing is published, so an admin reviews every price before selling.
 */
export async function importFromMeta(tx: TenantTransaction, accountId: string, userId: string, raw: unknown):
  Promise<{ created: { product_id: string; sku: string }[]; skipped: { meta_product_id: string; reason: 'exists' | 'invalid_sku' | 'not_found' }[] }> {
  const b = asBody(raw);
  const ids = b.meta_product_ids;
  if (!Array.isArray(ids) || ids.length < 1 || ids.length > IMPORT_MAX || !ids.every(isId)) throw new CatalogueError('invalid', 'meta_product_ids');
  const unique = [...new Set(ids as string[])];
  const settings = await tx.$queryRaw<{ currency: string }[]>`SELECT currency FROM commerce_settings WHERE account_id=${accountId}::uuid FOR SHARE`;
  const storeCurrency = settings[0]?.currency ?? null;
  const rows = await tx.$queryRaw<{ id: string; retailer_id: string; name: string; description: string | null; price: bigint | null;
    currency: string | null; image_url: string | null }[]>`
    SELECT id::text AS id, retailer_id, name, description, price_minor AS price, currency, image_url FROM products
    WHERE account_id=${accountId}::uuid AND id = ANY(${unique}::uuid[]) ORDER BY retailer_id`;
  const created: { product_id: string; sku: string }[] = [];
  const skipped: { meta_product_id: string; reason: 'exists' | 'invalid_sku' | 'not_found' }[] = [];
  const found = new Set(rows.map((r) => r.id));
  for (const id of unique) if (!found.has(id)) skipped.push({ meta_product_id: id, reason: 'not_found' });
  const seen = new Set<string>();
  for (const m of rows) {
    if (!SKU.test(m.retailer_id)) { skipped.push({ meta_product_id: m.id, reason: 'invalid_sku' }); continue; }
    if (seen.has(m.retailer_id)) { skipped.push({ meta_product_id: m.id, reason: 'exists' }); continue; }
    seen.add(m.retailer_id);
    // One import at a time per SKU; a variant created meanwhile by an editor still fails the unique key (sku_taken).
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`shop-sku:${accountId}:${m.retailer_id}`}, 0))`;
    const product = await tx.$queryRaw<{ id: string }[]>`
      WITH p AS (
        INSERT INTO shop_products(account_id,name,description,created_by)
        SELECT ${accountId}::uuid, left(btrim(${m.name}),200), left(${m.description},5000), ${userId}::uuid
        WHERE NOT EXISTS (SELECT 1 FROM shop_variants WHERE account_id=${accountId}::uuid AND sku=${m.retailer_id})
          AND char_length(btrim(${m.name})) > 0
        RETURNING id)
      SELECT id::text AS id FROM p`;
    if (!product[0]) { skipped.push({ meta_product_id: m.id, reason: 'exists' }); continue; }
    const slug = await nextSlug(tx, accountId, 'product', { id: product[0].id, name: m.name.trim().slice(0, 200), current: null });
    await tx.$executeRaw`UPDATE shop_products SET slug=${slug} WHERE account_id=${accountId}::uuid AND id=${product[0].id}::uuid`
      .catch((e) => mapDbError(e, 'name'));
    const price = storeCurrency && m.currency === storeCurrency ? minorFromDb(m.price) : null;
    await tx.$executeRaw`
      INSERT INTO shop_variants(account_id,product_id,sku,price_minor) VALUES(${accountId}::uuid,${product[0].id}::uuid,${m.retailer_id},${price}::bigint)`
      .catch((e) => mapDbError(e, 'sku'));
    if (m.image_url && /^https:\/\//.test(m.image_url) && m.image_url.length <= 2048)
      await tx.$executeRaw`INSERT INTO shop_product_images(account_id,product_id,url,position) VALUES(${accountId}::uuid,${product[0].id}::uuid,${m.image_url},0)`;
    created.push({ product_id: product[0].id, sku: m.retailer_id });
  }
  if (created.length) await auditCatalogue(tx, accountId, userId, 'commerce.products_imported', 'meta', { count: created.length });
  return { created, skipped };
}

