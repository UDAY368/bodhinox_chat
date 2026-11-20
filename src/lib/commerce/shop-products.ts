/**
 * The one product loader of the shops (store Batch 6): the public shop (/s/<handle>), the token storefront (/shop/<token>, staff
 * WhatsApp links), the theme editor's preview, search, link pages and new-arrival messages all read products here.
 *
 * - loadProductsWith: published products with a priced live variant (shop_product_live), their live variants with stock, their
 *   images (through an `imageUrl` strategy: the public image route, the signed-in preview route, or the bare id) and ratings.
 *   Four queries for any number of products; never one per product.
 * - loadProductPage: one page of a filtered, sorted list, filtered, sorted and paged in SQL with a keyset cursor (price range in
 *   minor units, one option name:value, a category with its sub-categories, search words), then the cards of that page only.
 *
 * Every query runs in the caller's tenant transaction and names the account, so a shop only ever reads its own rows.
 */
import { Prisma } from '@prisma/client';
import type { TenantTransaction } from '@/lib/db/tenant';
import { minorFromDb } from './money';
import { loadRatingSummaries } from './review-data';
import type { RatingSummary } from './reviews';
import { likeContains, likePrefix } from './shop-insights-rules';
import { isUuid } from './store-settings';

export interface PublicVariant {
  id: string; options: Record<string, string>; priceMinor: number; compareAtMinor: number | null; inStock: boolean; imageIndex: number | null;
  /** Units that can be bought now (shop_variant_availability); null = no limit (not tracked, or not known on this page). */
  available: number | null;
  /** Pre-order: ships by this date (YYYY-MM-DD). */
  shipsBy: string | null;
}

export interface PublicProduct {
  id: string;
  /** Store Batch 6: the readable address segment (/p/<slug>); null only for a row without one yet. Build links with productPath(). */
  slug: string | null;
  name: string;
  description: string | null;
  disclosure: string | null;
  categoryId: string | null;
  categoryName: string | null;
  /** Store Batch 6: the category's slug for categoryPath(); null when there is none. */
  categorySlug: string | null;
  images: string[];
  /** Label and value rows from the product's details (plain text). */
  details: Array<{ label: string; value: string }>;
  /** `imageIndex`: the position in `images` this variant shows, or null. */
  variants: PublicVariant[];
  /** A digital download: nothing is shipped. */
  digital: boolean;
  /** Average and count of the published reviews (store plan Phase 3); null until there is one. */
  rating: RatingSummary | null;
}

/** A loaded product with each variant's SKU (the token storefront shows it; the public card shape leaves it out). */
export type LoadedProduct = Omit<PublicProduct, 'variants'> & { variants: Array<PublicVariant & { sku: string }> };

export interface ProductImageRow { id: string; url: string | null; bucket: string | null; object_key: string | null }
/** Turns an image row into what the page shows (a URL, or the id), or null to leave the image out. */
export type ImageUrlStrategy = (image: ProductImageRow) => string | null;

export interface ProductWhere { productId?: string; productSlug?: string; productIds?: string[]; categoryId?: string; limit: number }

const LAST_POSITION = 2_147_483_647;

/** Published products with a priced live variant, in catalogue order (category position, name, id), with their variants and SKUs. */
export async function loadProductRows(tx: TenantTransaction, accountId: string, where: ProductWhere, imageUrl: ImageUrlStrategy): Promise<LoadedProduct[]> {
  const productId = where.productId ?? null;
  // Store Batch 6: a product page asks by slug (/p/<slug>); always inside this account.
  const productSlug = where.productSlug ?? null;
  const productIds = where.productIds ?? null;
  const categoryId = where.categoryId ?? null;
  if (productIds && !productIds.length) return [];
  const rows = await tx.$queryRaw<{ id: string; slug: string | null; name: string; description: string | null; disclosure: string | null; details: unknown;
    category_id: string | null; category: string | null; category_slug: string | null; is_digital: boolean }[]>`
    SELECT p.id::text AS id, p.slug, p.name, p.description, p.disclosure, p.details, c.id::text AS category_id, c.name AS category,
      c.slug AS category_slug, p.is_digital FROM shop_products p
    LEFT JOIN shop_categories c ON c.account_id=p.account_id AND c.id=p.category_id AND c.archived_at IS NULL
    WHERE p.account_id=${accountId}::uuid AND shop_product_live(p.status, p.publish_at, p.hide_at)
      AND EXISTS (SELECT 1 FROM shop_variants v WHERE v.account_id=p.account_id AND v.product_id=p.id AND v.archived_at IS NULL AND v.price_minor IS NOT NULL)
      AND (${productId}::uuid IS NULL OR p.id=${productId}::uuid)
      AND (${productSlug}::text IS NULL OR p.slug=${productSlug}::text)
      AND (${productIds}::uuid[] IS NULL OR p.id = ANY(${productIds}::uuid[]))
      AND (${categoryId}::uuid IS NULL OR c.id=${categoryId}::uuid OR c.parent_id=${categoryId}::uuid)
    ORDER BY COALESCE(c.position, ${LAST_POSITION}::int), p.name, p.id LIMIT ${where.limit}`;
  if (!rows.length) return [];
  const ids = rows.map((r) => r.id);
  const variants = await tx.$queryRaw<{ id: string; product_id: string; sku: string; option_values: Record<string, string>; price_minor: bigint;
    compare_at_minor: bigint | null; in_stock: boolean; available: number | null; image_id: string | null; ship_date: string | null }[]>`
    SELECT v.id::text AS id, v.product_id::text AS product_id, v.sku, v.option_values, v.price_minor, v.compare_at_minor, v.image_id::text AS image_id,
      COALESCE(a.n, 1) > 0 AS in_stock, a.n AS available,
      CASE WHEN v.preorder THEN to_char(v.preorder_ship_date, 'YYYY-MM-DD') END AS ship_date
    FROM shop_variants v CROSS JOIN LATERAL (SELECT shop_variant_availability(v.account_id, v.id) AS n) a
    WHERE v.account_id=${accountId}::uuid AND v.product_id = ANY(${ids}::uuid[]) AND v.archived_at IS NULL AND v.price_minor IS NOT NULL
    ORDER BY v.position, v.sku`;
  const images = await tx.$queryRaw<(ProductImageRow & { product_id: string })[]>`
    SELECT i.id::text AS id, i.product_id::text AS product_id, i.url, m.bucket, m.object_key FROM shop_product_images i
    LEFT JOIN media_objects m ON m.account_id=i.account_id AND m.id=i.media_id AND m.deleted_at IS NULL
    WHERE i.account_id=${accountId}::uuid AND i.product_id = ANY(${ids}::uuid[]) ORDER BY i.position`;
  // One grouped query for every product on the page.
  const ratings = await loadRatingSummaries(tx, accountId, ids);
  return rows.map((p) => {
    // Only images with a URL are shown; a variant's picture is its place among those.
    const shown = images.filter((i) => i.product_id === p.id).map((i) => ({ id: i.id, url: imageUrl(i) })).filter((i): i is { id: string; url: string } => !!i.url);
    return {
      id: p.id, slug: p.slug, name: p.name, description: p.description, disclosure: p.disclosure, categoryId: p.category_id, categoryName: p.category,
      categorySlug: p.category_slug, digital: p.is_digital, rating: ratings.get(p.id) ?? null,
      details: publicDetails(p.details),
      images: shown.map((i) => i.url),
      variants: variants.filter((v) => v.product_id === p.id).map((v) => {
        const at = v.image_id ? shown.findIndex((i) => i.id === v.image_id) : -1;
        return {
          id: v.id, sku: v.sku, options: v.option_values ?? {}, priceMinor: minorFromDb(v.price_minor) ?? 0,
          compareAtMinor: minorFromDb(v.compare_at_minor), inStock: v.in_stock, available: v.available === null ? null : Number(v.available),
          imageIndex: at >= 0 ? at : null, shipsBy: v.ship_date,
        };
      }),
    };
  });
}

/** The public card shape: the same product without SKUs. */
export const toPublicProduct = (p: LoadedProduct): PublicProduct => ({
  ...p,
  variants: p.variants.map((v) => ({ id: v.id, options: v.options, priceMinor: v.priceMinor, compareAtMinor: v.compareAtMinor, inStock: v.inStock,
    imageIndex: v.imageIndex, available: v.available, shipsBy: v.shipsBy })),
});

/**
 * Published products with a priced live variant, in catalogue order. `imageUrl` turns an image row into a URL: the public image
 * route for visitors, the signed-in media route for the theme editor's preview.
 */
export async function loadProductsWith(tx: TenantTransaction, accountId: string, where: ProductWhere, imageUrl: ImageUrlStrategy): Promise<PublicProduct[]> {
  return (await loadProductRows(tx, accountId, where, imageUrl)).map(toPublicProduct);
}

/** Stored detail rows read back leniently: only plain label/value strings, at most twelve. */
function publicDetails(value: unknown): Array<{ label: string; value: string }> {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 12).flatMap((row) => {
    const r = row as { label?: unknown; value?: unknown } | null;
    return r && typeof r.label === 'string' && typeof r.value === 'string' && r.label && r.value ? [{ label: r.label, value: r.value }] : [];
  });
}

// ---------------------------------------------------------------------------
// Lists paged in SQL

/** Products per list page (category, collection, all products, search, the token catalogue). */
export const LIST_PAGE_SIZE = 24;

export const LIST_SORTS = ['featured', 'price_asc', 'price_desc', 'name', 'newest', 'relevance'] as const;
export type ListSort = (typeof LIST_SORTS)[number];

export interface ListFilter {
  sort: ListSort;
  categoryId?: string | null;
  /** With the category's direct sub-categories (the category pages and sections do; the token catalogue's chips do not). */
  withChildren?: boolean;
  /** Some live variant priced inside [minMinor, maxMinor] (minor units) and carrying `option` (one name:value), the same variant. */
  minMinor?: number | null;
  maxMinor?: number | null;
  option?: { name: string; value: string } | null;
  /** Search words: each must match the name, a SKU or the category name. */
  terms?: string[];
}

/** Where a page ended: the sort, the sort key of its last product (position, price, time or relevance), its name and id. */
export interface ListCursor { sort: ListSort; key: number; name: string; id: string }

export function encodeListCursor(cursor: ListCursor): string {
  return Buffer.from(JSON.stringify([cursor.sort, cursor.key, cursor.name, cursor.id]), 'utf8').toString('base64url');
}

/** The cursor a client sent back for this sort, or null (not one this server made, or of another sort: the first page). */
export function decodeListCursor(value: unknown, sort: ListSort): ListCursor | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > 500) return null;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
    if (!Array.isArray(parsed) || parsed.length !== 4) return null;
    const [s, key, name, id] = parsed as unknown[];
    if (s !== sort || typeof key !== 'number' || !Number.isSafeInteger(key)) return null;
    if (typeof name !== 'string' || name.length > 300 || typeof id !== 'string' || !isUuid(id)) return null;
    return { sort, key, name, id };
  } catch {
    return null;
  }
}

const LIVE_PRICE = Prisma.sql`CROSS JOIN LATERAL (SELECT min(v.price_minor) AS low FROM shop_variants v
  WHERE v.account_id=p.account_id AND v.product_id=p.id AND v.archived_at IS NULL AND v.price_minor IS NOT NULL) lp`;

/** The sort key (a bigint) and its direction; ties are always broken by (name, id) ascending. */
function sortKey(filter: ListFilter): { key: Prisma.Sql; desc: boolean } {
  switch (filter.sort) {
    case 'price_asc': return { key: Prisma.sql`lp.low`, desc: false };
    case 'price_desc': return { key: Prisma.sql`lp.low`, desc: true };
    case 'name': return { key: Prisma.sql`0::bigint`, desc: false };
    case 'newest': return { key: Prisma.sql`(extract(epoch from p.created_at) * 1000000)::bigint`, desc: true };
    case 'relevance': {
      const first = filter.terms?.[0];
      // Products whose name starts with the first word come first.
      if (first) return { key: Prisma.sql`(CASE WHEN p.name ILIKE ${likePrefix(first)} ESCAPE '\\' THEN 1 ELSE 0 END)::bigint`, desc: true };
      return { key: Prisma.sql`COALESCE(c.position, ${LAST_POSITION}::int)::bigint`, desc: false };
    }
    default: return { key: Prisma.sql`COALESCE(c.position, ${LAST_POSITION}::int)::bigint`, desc: false };
  }
}

/** FROM and WHERE of a list: the account's live, priced products narrowed by the filter. Values are bound parameters. */
function listFrom(accountId: string, filter: ListFilter): Prisma.Sql {
  const where: Prisma.Sql[] = [Prisma.sql`p.account_id=${accountId}::uuid`, Prisma.sql`shop_product_live(p.status, p.publish_at, p.hide_at)`,
    Prisma.sql`lp.low IS NOT NULL`];
  if (filter.categoryId) {
    where.push(filter.withChildren ? Prisma.sql`(c.id=${filter.categoryId}::uuid OR c.parent_id=${filter.categoryId}::uuid)` : Prisma.sql`c.id=${filter.categoryId}::uuid`);
  }
  const min = filter.minMinor ?? null, max = filter.maxMinor ?? null, option = filter.option ?? null;
  if (min !== null || max !== null || option) {
    where.push(Prisma.sql`EXISTS (SELECT 1 FROM shop_variants v WHERE v.account_id=p.account_id AND v.product_id=p.id AND v.archived_at IS NULL
      AND v.price_minor IS NOT NULL
      ${min !== null ? Prisma.sql`AND v.price_minor >= ${min}::bigint` : Prisma.empty}
      ${max !== null ? Prisma.sql`AND v.price_minor <= ${max}::bigint` : Prisma.empty}
      ${option ? Prisma.sql`AND v.option_values->>${option.name} = ${option.value}` : Prisma.empty})`);
  }
  if (filter.terms?.length) {
    where.push(Prisma.sql`NOT EXISTS (
      SELECT 1 FROM unnest(${filter.terms.map(likeContains)}::text[]) AS w(pattern)
      WHERE NOT (p.name ILIKE w.pattern ESCAPE '\\' OR COALESCE(c.name, '') ILIKE w.pattern ESCAPE '\\'
        OR EXISTS (SELECT 1 FROM shop_variants v WHERE v.account_id=p.account_id AND v.product_id=p.id AND v.archived_at IS NULL AND v.sku ILIKE w.pattern ESCAPE '\\')))`);
  }
  return Prisma.sql`FROM shop_products p
    LEFT JOIN shop_categories c ON c.account_id=p.account_id AND c.id=p.category_id AND c.archived_at IS NULL
    ${LIVE_PRICE}
    WHERE ${Prisma.join(where, ' AND ')}`;
}

/** The ids of one page, in order, and the cursor of the next page (null on the last). */
export async function pageProductIds(tx: TenantTransaction, accountId: string, filter: ListFilter, cursor: unknown, limit = LIST_PAGE_SIZE):
  Promise<{ ids: string[]; next: string | null }> {
  const { key, desc } = sortKey(filter);
  const after = decodeListCursor(cursor, filter.sort);
  const tie = after ? Prisma.sql`(p.name, p.id) > (${after.name}::text, ${after.id}::uuid)` : Prisma.empty;
  const seek = after ? Prisma.sql`AND ((${key}) ${desc ? Prisma.sql`<` : Prisma.sql`>`} ${after.key}::bigint OR ((${key}) = ${after.key}::bigint AND ${tie}))` : Prisma.empty;
  const rows = await tx.$queryRaw<{ id: string; name: string; k: bigint }[]>(Prisma.sql`
    SELECT p.id::text AS id, p.name, (${key})::bigint AS k ${listFrom(accountId, filter)} ${seek}
    ORDER BY k ${desc ? Prisma.sql`DESC` : Prisma.sql`ASC`}, p.name, p.id LIMIT ${limit + 1}`);
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  return {
    ids: page.map((r) => r.id),
    next: rows.length > limit && last ? encodeListCursor({ sort: filter.sort, key: Number(last.k), name: last.name, id: last.id }) : null,
  };
}

/** How many products the filter matches (the "N products" line). */
export async function countProducts(tx: TenantTransaction, accountId: string, filter: ListFilter): Promise<number> {
  const [row] = await tx.$queryRaw<{ n: number }[]>(Prisma.sql`SELECT count(*)::int AS n ${listFrom(accountId, filter)}`);
  return row?.n ?? 0;
}

/** Cards of `ids` in that order (ids that are no longer live are left out). */
export async function loadProductsInOrder(tx: TenantTransaction, accountId: string, ids: string[], imageUrl: ImageUrlStrategy): Promise<LoadedProduct[]> {
  if (!ids.length) return [];
  const byId = new Map((await loadProductRows(tx, accountId, { productIds: ids, limit: ids.length }, imageUrl)).map((p) => [p.id, p]));
  return ids.flatMap((id) => (byId.has(id) ? [byId.get(id)!] : []));
}

/** One page of a list: its cards in order and the next cursor. */
export async function loadProductPage(tx: TenantTransaction, accountId: string, filter: ListFilter, cursor: unknown, imageUrl: ImageUrlStrategy,
  limit = LIST_PAGE_SIZE): Promise<{ products: LoadedProduct[]; next: string | null }> {
  const page = await pageProductIds(tx, accountId, filter, cursor, limit);
  return { products: await loadProductsInOrder(tx, accountId, page.ids, imageUrl), next: page.next };
}

/** The most option values a category page offers as filters. */
export const OPTION_FILTER_LIMIT = 200;

/** Option filters on offer for a category (and its sub-categories): name -> values, from its live products' live variants, one query. */
export async function categoryOptionValues(tx: TenantTransaction, accountId: string, categoryId: string): Promise<Record<string, string[]>> {
  const rows = await tx.$queryRaw<{ name: string; value: string }[]>`
    SELECT DISTINCT e.key AS name, e.value AS value FROM shop_products p
    JOIN shop_categories c ON c.account_id=p.account_id AND c.id=p.category_id AND c.archived_at IS NULL
    JOIN shop_variants v ON v.account_id=p.account_id AND v.product_id=p.id AND v.archived_at IS NULL AND v.price_minor IS NOT NULL
    CROSS JOIN LATERAL jsonb_each_text(CASE WHEN jsonb_typeof(v.option_values)='object' THEN v.option_values ELSE '{}'::jsonb END) e
    WHERE p.account_id=${accountId}::uuid AND shop_product_live(p.status, p.publish_at, p.hide_at)
      AND (c.id=${categoryId}::uuid OR c.parent_id=${categoryId}::uuid)
    ORDER BY 1, 2 LIMIT ${OPTION_FILTER_LIMIT}`;
  const out: Record<string, string[]> = {};
  for (const r of rows) (out[r.name] ??= []).push(r.value);
  return out;
}
