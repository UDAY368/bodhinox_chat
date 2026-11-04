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
export const IMPORT_MAX = 100;

// ------------------------------------------------------------ errors

export type CatalogueErrorCode =
  | 'invalid' | 'not_found' | 'conflict' | 'sku_taken' | 'store_not_configured'
  | 'needs_priced_variant' | 'category_depth' | 'category_has_children' | 'not_tracked' | 'stock_changed' | 'below_reserved';

const STATUS: Record<CatalogueErrorCode, number> = {
  invalid: 400, not_found: 404, conflict: 409, sku_taken: 409, store_not_configured: 409,
  needs_priced_variant: 409, category_depth: 409, category_has_children: 409, not_tracked: 409, stock_changed: 409, below_reserved: 409,
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

function mapDbError(error: unknown, field: string): never {
  const e = error as { code?: string; meta?: { code?: string }; message?: string };
  const code = e?.meta?.code ?? e?.code;
  const message = error instanceof Error ? error.message : '';
  if (code === '23505' || /23505|unique constraint/i.test(message)) throw new CatalogueError(field === 'sku' ? 'sku_taken' : 'conflict', field);
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
  parent_id: string | null;
  position: number;
  archived: boolean;
  product_count: number;
}

export async function listCategories(tx: TenantTransaction, accountId: string): Promise<ShopCategory[]> {
  const rows = await tx.$queryRaw<{ id: string; name: string; parent_id: string | null; position: number; archived_at: Date | null; n: bigint }[]>`
    SELECT c.id::text AS id, c.name, c.parent_id::text AS parent_id, c.position, c.archived_at,
      (SELECT count(*) FROM shop_products p WHERE p.account_id=c.account_id AND p.category_id=c.id AND p.status<>'archived') AS n
    FROM shop_categories c WHERE c.account_id=${accountId}::uuid
    ORDER BY (c.archived_at IS NOT NULL), c.position, lower(c.name), c.id`;
  return rows.map((r) => ({ id: r.id, name: r.name, parent_id: r.parent_id, position: r.position, archived: !!r.archived_at, product_count: Number(r.n) }));
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
  const rows = await tx.$queryRaw<{ id: string }[]>`
    INSERT INTO shop_categories(account_id,name,parent_id,position) VALUES(${accountId}::uuid,${name},${parentId}::uuid,${position})
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
  await tx.$executeRaw`UPDATE shop_categories SET name=${name}, parent_id=${parentId}::uuid, position=${position},
      archived_at=CASE WHEN ${archived} THEN COALESCE(archived_at, now()) ELSE NULL END
    WHERE account_id=${accountId}::uuid AND id=${id}::uuid`.catch((e) => mapDbError(e, 'name'));
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
};

/** A page of products with price range and stock summary (agents and above). The search matches name or any SKU, LIKE-escaped. */
export async function listShopProducts(tx: TenantTransaction, accountId: string, query: ShopProductQuery = {}):
  Promise<{ products: ShopProductSummary[]; total: number; currency: string | null }> {
  const pattern = query.q ? likePattern(query.q) : null;
  const status = query.status ?? null;
  const stock = query.stock ?? null;
  const limit = Math.min(Math.max(query.limit ?? 50, 1), 100);
  const offset = Math.max(query.offset ?? 0, 0);
  const rows = await tx.$queryRaw<SummaryRow[]>`
    SELECT p.id::text AS id, p.name, p.status, p.category_id::text AS category_id, c.name AS category_name, p.version,
      s.variant_count, s.min_price, s.max_price, s.available, s.tracked, s.untracked, s.low_count,
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
          <= COALESCE(l.low_stock_threshold, st.low_stock_default, 5))::int AS low_count
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
  return {
    total,
    currency: settings[0]?.currency ?? null,
    products: rows.map((r) => ({
      id: r.id, name: r.name, status: r.status, category_id: r.category_id, category_name: r.category_name, version: r.version,
      variant_count: r.variant_count, min_price_minor: minorFromDb(r.min_price), max_price_minor: minorFromDb(r.max_price),
      available: Number(r.available), tracked_count: r.tracked, untracked_count: r.untracked, low_count: r.low_count,
      image_url: imageUrl(r.img_url, r.img_bucket, r.img_key), updated_at: r.updated_at.toISOString(),
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
  archived: boolean;
  on_hand: number;
  reserved: number;
  available: number;
  low_stock_threshold: number;
  /** A mirrored Meta product with retailer_id = sku exists. */
  meta_linked: boolean;
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
  version: number;
  created_at: string;
  updated_at: string;
  currency: string | null;
  variants: ShopVariant[];
  images: ShopImage[];
}

type ProductRow = Omit<ShopProduct, 'content_reviewed_at' | 'created_at' | 'updated_at' | 'variants' | 'images' | 'currency'> & {
  content_reviewed_at: Date | null; created_at: Date; updated_at: Date; currency: string | null;
};
type VariantRow = Omit<ShopVariant, 'price_minor' | 'compare_at_minor' | 'archived' | 'available'> & {
  price_minor: bigint | null; compare_at_minor: bigint | null; archived_at: Date | null;
};

export async function getShopProduct(tx: TenantTransaction, accountId: string, id: string): Promise<ShopProduct> {
  if (!isId(id)) throw new CatalogueError('not_found');
  const rows = await tx.$queryRaw<ProductRow[]>`
    SELECT p.id::text AS id, p.name, p.description, p.disclosure, p.category_id::text AS category_id, p.status,
      p.content_reviewed_by::text AS content_reviewed_by, p.content_reviewed_at, p.follow_up_template, p.follow_up_template_language,
      p.follow_up_after_days, p.repurchase_after_days, p.version, p.created_at, p.updated_at, st.currency
    FROM shop_products p LEFT JOIN commerce_settings st ON st.account_id=p.account_id
    WHERE p.account_id=${accountId}::uuid AND p.id=${id}::uuid`;
  const p = rows[0];
  if (!p) throw new CatalogueError('not_found');
  const variants = await tx.$queryRaw<VariantRow[]>`
    SELECT v.id::text AS id, v.sku, v.option_values, v.price_minor, v.compare_at_minor, v.tax_rate_bps, v.hsn_code, v.track_inventory,
      v.weight_grams, v.position, v.archived_at, COALESCE(l.on_hand,0) AS on_hand, COALESCE(l.reserved,0) AS reserved,
      COALESCE(l.low_stock_threshold, st.low_stock_default, 5) AS low_stock_threshold,
      EXISTS (SELECT 1 FROM products m WHERE m.account_id=v.account_id AND m.retailer_id=v.sku) AS meta_linked
    FROM shop_variants v
    LEFT JOIN inventory_levels l ON l.account_id=v.account_id AND l.variant_id=v.id
    LEFT JOIN commerce_settings st ON st.account_id=v.account_id
    WHERE v.account_id=${accountId}::uuid AND v.product_id=${id}::uuid
    ORDER BY (v.archived_at IS NOT NULL), v.position, v.created_at, v.id`;
  const images = await tx.$queryRaw<{ id: string; media_id: string | null; url: string | null; bucket: string | null; object_key: string | null; position: number }[]>`
    SELECT i.id::text AS id, i.media_id::text AS media_id, i.url, m.bucket, m.object_key, i.position
    FROM shop_product_images i LEFT JOIN media_objects m ON m.account_id=i.account_id AND m.id=i.media_id AND m.deleted_at IS NULL
    WHERE i.account_id=${accountId}::uuid AND i.product_id=${id}::uuid ORDER BY i.position`;
  return {
    ...p,
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
  };
  if (next.follow_up_template && !next.follow_up_template_language) throw new CatalogueError('invalid', 'follow_up_template_language');
  if (!next.follow_up_template) { next.follow_up_template_language = null; next.follow_up_after_days = null; }
  if (next.category_id && next.category_id !== current?.category_id) {
    const cat = await tx.$queryRaw<{ id: string }[]>`SELECT id::text AS id FROM shop_categories
      WHERE account_id=${accountId}::uuid AND id=${next.category_id}::uuid AND archived_at IS NULL`;
    if (!cat[0]) throw new CatalogueError('invalid', 'category_id');
  }
  let productId = id;
  if (!current) {
    const rows = await tx.$queryRaw<{ id: string }[]>`
      INSERT INTO shop_products(account_id,name,description,disclosure,category_id,follow_up_template,follow_up_template_language,
        follow_up_after_days,repurchase_after_days,created_by)
      VALUES(${accountId}::uuid,${next.name},${next.description},${next.disclosure},${next.category_id}::uuid,${next.follow_up_template},
        ${next.follow_up_template_language},${next.follow_up_after_days},${next.repurchase_after_days},${userId}::uuid)
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
        repurchase_after_days=${next.repurchase_after_days},
        content_reviewed_by=CASE WHEN ${rereview} THEN ${userId}::uuid ELSE content_reviewed_by END,
        content_reviewed_at=CASE WHEN ${rereview} THEN now() ELSE content_reviewed_at END,
        version=version+1
      WHERE account_id=${accountId}::uuid AND id=${current.id}::uuid AND version=${current.version}`.catch((e) => mapDbError(e, 'name'));
    if (changed !== 1) throw new CatalogueError('conflict', 'version');
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
  await tx.$executeRaw`DELETE FROM shop_product_images WHERE account_id=${accountId}::uuid AND product_id=${productId}::uuid`;
  for (const [position, image] of images.entries())
    await tx.$executeRaw`INSERT INTO shop_product_images(account_id,product_id,media_id,url,position)
      VALUES(${accountId}::uuid,${productId}::uuid,${image.mediaId}::uuid,${image.url},${position})`;
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

// ------------------------------------------------------------ variants

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
  let current: { sku: string; option_values: unknown; price_minor: bigint | null; compare_at_minor: bigint | null; tax_rate_bps: number | null;
    hsn_code: string | null; track_inventory: boolean; weight_grams: number | null; position: number; archived_at: Date | null } | undefined;
  if (variantId) {
    if (!isId(variantId)) throw new CatalogueError('not_found');
    current = (await tx.$queryRaw<NonNullable<typeof current>[]>`
      SELECT sku, option_values, price_minor, compare_at_minor, tax_rate_bps, hsn_code, track_inventory, weight_grams, position, archived_at
      FROM shop_variants WHERE account_id=${accountId}::uuid AND id=${variantId}::uuid AND product_id=${productId}::uuid FOR UPDATE`)[0];
    if (!current) throw new CatalogueError('not_found');
  }
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
  };
  if (next.hsn_code && !HSN.test(next.hsn_code)) throw new CatalogueError('invalid', 'hsn_code');
  if (next.price_minor !== null || next.compare_at_minor !== null) {
    // Shared lock: a concurrent currency change (FOR UPDATE, then currencyInUse) commits first or sees this price.
    const settings = await tx.$queryRaw<{ currency: string }[]>`SELECT currency FROM commerce_settings WHERE account_id=${accountId}::uuid FOR SHARE`;
    if (!settings[0]) throw new CatalogueError('store_not_configured', 'price_minor');
  }
  const stillPriced = next.price_minor !== null && !next.archived;
  if (product.status === 'published' && !stillPriced && (await pricedVariantCount(tx, accountId, productId, variantId)) === 0)
    throw new CatalogueError('needs_priced_variant', 'price_minor');
  const options = JSON.stringify(next.option_values);
  if (!current) {
    const rows = await tx.$queryRaw<{ id: string }[]>`
      INSERT INTO shop_variants(account_id,product_id,sku,option_values,price_minor,compare_at_minor,tax_rate_bps,hsn_code,track_inventory,
        weight_grams,position,archived_at)
      VALUES(${accountId}::uuid,${productId}::uuid,${next.sku},${options}::jsonb,${next.price_minor}::bigint,${next.compare_at_minor}::bigint,
        ${next.tax_rate_bps},${next.hsn_code},${next.track_inventory},${next.weight_grams},${next.position},
        CASE WHEN ${next.archived} THEN now() END)
      RETURNING id::text AS id`.catch((e) => mapDbError(e, 'sku'));
    await auditCatalogue(tx, accountId, userId, 'commerce.variant_created', rows[0].id, { product_id: productId });
  } else {
    await tx.$executeRaw`
      UPDATE shop_variants SET sku=${next.sku}, option_values=${options}::jsonb, price_minor=${next.price_minor}::bigint,
        compare_at_minor=${next.compare_at_minor}::bigint, tax_rate_bps=${next.tax_rate_bps}, hsn_code=${next.hsn_code},
        track_inventory=${next.track_inventory}, weight_grams=${next.weight_grams}, position=${next.position},
        archived_at=CASE WHEN ${next.archived} THEN COALESCE(archived_at, now()) ELSE NULL END
      WHERE account_id=${accountId}::uuid AND id=${variantId}::uuid`.catch((e) => mapDbError(e, 'sku'));
    const priceChanged = minorFromDb(current.price_minor) !== next.price_minor;
    await auditCatalogue(tx, accountId, userId, 'commerce.variant_updated', variantId!, {
      product_id: productId, fields: Object.keys(b).filter((k) => has(b, k)),
      // Prices are the seller's own configuration, not customer content.
      ...(priceChanged ? { price_from: minorFromDb(current.price_minor), price_to: next.price_minor } : {}),
    });
  }
  await tx.$executeRaw`UPDATE shop_products SET version=version+1 WHERE account_id=${accountId}::uuid AND id=${productId}::uuid`;
  return getShopProduct(tx, accountId, productId);
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

