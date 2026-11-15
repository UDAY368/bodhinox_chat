"use client";

// Browser-side calls to /api/commerce/shop/** and /api/commerce/inventory/**.
// Every request goes through authFetch, which adds the session and the
// mutation-origin (CSRF) headers. Errors come back as codes, never input text.

import { authFetch } from "@/lib/auth/client";
import type {
  MetaLinkReport, ProductStatus, ShopCategory, ShopProduct, ShopProductSummary, StockFilter,
} from "@/lib/commerce/catalogue/products";
import type { ShopCollection, ShopCollectionDetail } from "@/lib/commerce/catalogue/collections";
import type { CollectionRule } from "@/lib/commerce/catalogue/collection-rules";
import type { AdjustKind, InventoryFilter, InventoryRow, MovementRow } from "@/lib/commerce/catalogue/inventory";
import type { ImportJobView, ImportPreview } from "@/lib/commerce/catalogue/product-csv-import";
import type { RowError } from "@/lib/commerce/catalogue/product-csv";
import type { PlatformStatus } from "@/lib/commerce/catalogue/platform-import-job";
import type { MetaSyncView } from "@/lib/commerce/catalogue/meta-sync-job";
export type { MetaSyncView, MetaSyncProblem } from "@/lib/commerce/catalogue/meta-sync-job";
export type { ImportPreview, ImportJobView } from "@/lib/commerce/catalogue/product-csv-import";
export type { RowError } from "@/lib/commerce/catalogue/product-csv";
export type { PlatformImportView, PlatformStatus } from "@/lib/commerce/catalogue/platform-import-job";

export type { ShopCollection, ShopCollectionDetail, CollectionRule };
export type { MetaLinkReport, ProductStatus, ShopCategory, ShopProduct, ShopProductSummary, StockFilter, AdjustKind, InventoryFilter, InventoryRow, MovementRow };

export type ApiResult<T> = { ok: true; data: T } | { ok: false; status: number; code?: string; field?: string; error?: string };

async function result<T>(res: Response, pick: (json: Record<string, unknown>) => T): Promise<ApiResult<T>> {
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (res.ok) return { ok: true, data: pick(json) };
  const str = (v: unknown) => (typeof v === "string" ? v : undefined);
  return { ok: false, status: res.status, code: str(json.code), field: str(json.field), error: str(json.error) };
}

const send = (url: string, method: string, body?: unknown) =>
  authFetch(url, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const get = (url: string) => authFetch(url, { cache: "no-store" });
const qs = (params: Record<string, string | number | undefined>) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== "") p.set(k, String(v));
  const text = p.toString();
  return text ? `?${text}` : "";
};
const productUrl = (id: string) => `/api/commerce/shop/products/${encodeURIComponent(id)}`;
const asProduct = (json: Record<string, unknown>) => json.product as ShopProduct;

export interface ProductListFilter {
  q?: string;
  status?: ProductStatus | "all";
  categoryId?: string;
  stock?: StockFilter;
  limit?: number;
  offset?: number;
}

export async function fetchShopProducts(f: ProductListFilter):
  Promise<ApiResult<{ products: ShopProductSummary[]; total: number; currency: string | null }>> {
  const res = await get(`/api/commerce/shop/products${qs({ q: f.q?.trim(), status: f.status, category_id: f.categoryId, stock: f.stock, limit: f.limit, offset: f.offset })}`);
  return result(res, (j) => ({ products: (j.products as ShopProductSummary[]) ?? [], total: Number(j.total ?? 0), currency: (j.currency as string | null) ?? null }));
}

export async function fetchShopProduct(id: string): Promise<ApiResult<ShopProduct>> {
  return result(await get(productUrl(id)), asProduct);
}

export type ProductBody = Partial<Pick<ShopProduct, "name" | "description" | "disclosure" | "category_id" | "follow_up_template"
  | "follow_up_template_language" | "follow_up_after_days" | "repurchase_after_days" | "cod_available" | "tags" | "brand" | "product_type" | "details">> & { version?: number; images?: ({ url: string } | { media_id: string })[] };

export async function createShopProduct(body: ProductBody): Promise<ApiResult<ShopProduct>> {
  return result(await send("/api/commerce/shop/products", "POST", body), asProduct);
}

export async function updateShopProduct(id: string, body: ProductBody): Promise<ApiResult<ShopProduct>> {
  return result(await send(productUrl(id), "PATCH", body), asProduct);
}

export async function publishShopProduct(id: string, version: number): Promise<ApiResult<ShopProduct>> {
  return result(await send(`${productUrl(id)}/publish`, "POST", { version }), asProduct);
}

export async function unpublishShopProduct(id: string): Promise<ApiResult<ShopProduct>> {
  return result(await send(`${productUrl(id)}/publish`, "DELETE"), asProduct);
}

/** Copy a product as a new draft (same content, images and variants with suffixed SKUs; no stock). */
export async function duplicateShopProduct(id: string, name?: string): Promise<ApiResult<ShopProduct>> {
  return result(await send(`${productUrl(id)}/duplicate`, "POST", name ? { name } : {}), asProduct);
}

export async function archiveShopProduct(id: string, archived: boolean): Promise<ApiResult<ShopProduct>> {
  return result(await send(`${productUrl(id)}/archive`, "POST", { archived }), asProduct);
}

export interface VariantBody {
  sku?: string;
  option_values?: Record<string, string>;
  price_minor?: number | null;
  compare_at_minor?: number | null;
  tax_rate_bps?: number | null;
  hsn_code?: string | null;
  track_inventory?: boolean;
  weight_grams?: number | null;
  position?: number;
  archived?: boolean;
  /** One of the product's own images, or null for none. */
  image_id?: string | null;
}

export async function saveVariant(productId: string, variantId: string | null, body: VariantBody): Promise<ApiResult<ShopProduct>> {
  const url = variantId ? `${productUrl(productId)}/variants/${encodeURIComponent(variantId)}` : `${productUrl(productId)}/variants`;
  return result(await send(url, variantId ? "PATCH" : "POST", body), asProduct);
}

export async function fetchCategories(): Promise<ApiResult<ShopCategory[]>> {
  return result(await get("/api/commerce/shop/categories"), (j) => (j.categories as ShopCategory[]) ?? []);
}

export async function saveCategory(id: string | null, body: { name?: string; parent_id?: string | null; position?: number; archived?: boolean }):
  Promise<ApiResult<ShopCategory>> {
  const res = id ? await send(`/api/commerce/shop/categories/${encodeURIComponent(id)}`, "PATCH", body)
    : await send("/api/commerce/shop/categories", "POST", body);
  return result(res, (j) => j.category as ShopCategory);
}

export interface CollectionBody {
  title?: string;
  slug?: string;
  description?: string | null;
  kind?: "manual" | "smart";
  rules?: CollectionRule[];
  match?: "all" | "any";
  sort?: string;
  published?: boolean;
  product_ids?: string[];
}

const collectionUrl = (id: string) => `/api/commerce/shop/collections/${encodeURIComponent(id)}`;

export async function fetchCollections(): Promise<ApiResult<ShopCollection[]>> {
  return result(await get("/api/commerce/shop/collections"), (j) => (j.collections as ShopCollection[]) ?? []);
}

export async function fetchCollection(id: string): Promise<ApiResult<ShopCollectionDetail>> {
  return result(await get(collectionUrl(id)), (j) => j.collection as ShopCollectionDetail);
}

export async function saveCollection(id: string | null, body: CollectionBody): Promise<ApiResult<ShopCollectionDetail>> {
  const res = id ? await send(collectionUrl(id), "PATCH", body) : await send("/api/commerce/shop/collections", "POST", body);
  return result(res, (j) => j.collection as ShopCollectionDetail);
}

export async function deleteCollection(id: string): Promise<ApiResult<true>> {
  return result(await send(collectionUrl(id), "DELETE"), () => true as const);
}

/** How many products a draft collection would show, and the first few names (nothing is saved). */
export async function previewCollection(body: CollectionBody): Promise<ApiResult<{ count: number; sample: { id: string; name: string }[] }>> {
  return result(await send("/api/commerce/shop/collections/preview", "POST", body),
    (j) => ({ count: Number(j.count ?? 0), sample: (j.sample as { id: string; name: string }[]) ?? [] }));
}

export async function fetchMetaLink(): Promise<ApiResult<MetaLinkReport>> {
  return result(await get("/api/commerce/shop/meta-link"), (j) => j as unknown as MetaLinkReport);
}

export async function importMetaProducts(ids: string[]): Promise<ApiResult<{ created: { product_id: string; sku: string }[]; skipped: { reason: string }[] }>> {
  return result(await send("/api/commerce/shop/import", "POST", { meta_product_ids: ids }),
    (j) => ({ created: (j.created as { product_id: string; sku: string }[]) ?? [], skipped: (j.skipped as { reason: string }[]) ?? [] }));
}

export async function fetchInventory(f: { q?: string; filter?: InventoryFilter; limit?: number; offset?: number }):
  Promise<ApiResult<{ items: InventoryRow[]; total: number }>> {
  const res = await get(`/api/commerce/inventory${qs({ q: f.q?.trim(), filter: f.filter, limit: f.limit, offset: f.offset })}`);
  return result(res, (j) => ({ items: (j.items as InventoryRow[]) ?? [], total: Number(j.total ?? 0) }));
}

export async function fetchMovements(f: { variantId?: string; before?: string | null }): Promise<ApiResult<{ movements: MovementRow[]; next: string | null }>> {
  const res = await get(`/api/commerce/inventory/movements${qs({ variant_id: f.variantId, before: f.before ?? undefined })}`);
  return result(res, (j) => ({ movements: (j.movements as MovementRow[]) ?? [], next: (j.next as string | null) ?? null }));
}

export async function adjustInventory(variantId: string, body: { kind: AdjustKind; delta: number; expected_on_hand: number; reason?: string | null }):
  Promise<ApiResult<{ variantId: string; onHand: number; reserved: number }>> {
  return result(await send(`/api/commerce/inventory/${encodeURIComponent(variantId)}/adjust`, "POST", body),
    (j) => j.level as { variantId: string; onHand: number; reserved: number });
}

/** Start a "new arrivals" carousel campaign from the chosen products (POST /api/commerce/new-arrivals). */
export async function sendNewArrivals(body: {
  name: string; templateId: string; productIds: string[]; audience: Record<string, unknown>; bodyValues?: string[];
}): Promise<ApiResult<{ id: string }>> {
  return result(await send("/api/commerce/new-arrivals", "POST", body), (j) => ({ id: String(j.id) }));
}

// ------------------------------------------------------------ product CSV import and export

export type CsvImportResult =
  | { mode: "inline"; created: number; updated: number; error_count: number; errors: RowError[]; errors_capped: boolean }
  | { mode: "queued"; import_id: string };

const sendCsv = (url: string, text: string) => authFetch(url, { method: "POST", headers: { "Content-Type": "text/csv; charset=utf-8" }, body: text });

/** A dry run of the file: counts and per-row errors; nothing is written. */
export async function previewProductCsv(text: string): Promise<ApiResult<ImportPreview>> {
  return result(await sendCsv("/api/commerce/shop/csv/preview", text), (j) => j.preview as ImportPreview);
}

export async function importProductCsv(text: string): Promise<ApiResult<CsvImportResult>> {
  return result(await sendCsv("/api/commerce/shop/csv/import", text), (j) => j.result as CsvImportResult);
}

export async function fetchImportJobs(): Promise<ApiResult<ImportJobView[]>> {
  return result(await get("/api/commerce/shop/csv/jobs"), (j) => (j.jobs as ImportJobView[]) ?? []);
}

/** The catalogue as a CSV file (admins): the browser saves it. */
export async function downloadProductCsv(): Promise<ApiResult<null>> {
  const res = await get("/api/commerce/shop/csv/export");
  if (!res.ok) return result(res, () => null);
  const url = URL.createObjectURL(await res.blob());
  const a = document.createElement("a");
  a.href = url;
  a.download = /filename="([^"]+)"/.exec(res.headers.get("content-disposition") ?? "")?.[1] ?? "products.csv";
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
  return { ok: true, data: null };
}

// ------------------------------------------------------------ import from Shopify or WooCommerce

export async function fetchPlatformStatus(): Promise<ApiResult<PlatformStatus>> {
  return result(await get("/api/commerce/shop/platform-import"), (j) => j.status as PlatformStatus);
}

export async function startPlatformImport(body:
  | { platform: "shopify" }
  | { platform: "woocommerce"; store_id: string; consumer_key: string; consumer_secret: string }): Promise<ApiResult<{ import_id: string }>> {
  return result(await send("/api/commerce/shop/platform-import", "POST", body), (j) => ({ import_id: String(j.import_id) }));
}

export async function cancelPlatformImport(id: string): Promise<ApiResult<null>> {
  return result(await send(`/api/commerce/shop/platform-import/${encodeURIComponent(id)}/cancel`, "POST"), () => null);
}

// ------------------------------------------------------------ full Meta catalogue sync

const asSync = (j: Record<string, unknown>) => j.sync as MetaSyncView;

export async function fetchMetaSync(): Promise<ApiResult<MetaSyncView>> {
  return result(await get("/api/commerce/shop/meta-sync"), asSync);
}

export async function saveMetaSync(body: { enabled?: boolean; scope?: "all" | "selected"; select?: string; deselect?: string }): Promise<ApiResult<MetaSyncView>> {
  return result(await send("/api/commerce/shop/meta-sync", "PUT", body), asSync);
}

export async function runMetaSync(): Promise<ApiResult<null>> {
  return result(await send("/api/commerce/shop/meta-sync/run", "POST"), () => null);
}

export async function reconcileMetaSyncItem(variantId: string): Promise<ApiResult<{ status: "synced" | "not_synced" }>> {
  return result(await send(`/api/commerce/shop/meta-sync/${encodeURIComponent(variantId)}/reconcile`, "POST"),
    (j) => ({ status: j.status === "synced" ? "synced" as const : "not_synced" as const }));
}
