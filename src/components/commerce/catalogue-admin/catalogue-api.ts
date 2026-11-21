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
import type { PurchaseOrder, PurchaseOrderSummary } from "@/lib/commerce/purchase-orders";
import type { LocationQuantity, StockLocation, StockTransfer } from "@/lib/commerce/stock-locations";
import type { PoAction } from "@/lib/commerce/stock-rules";

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

export interface ProductPage { products: ShopProductSummary[]; total: number; currency: string | null; shop_url: string | null }

export async function fetchShopProducts(f: ProductListFilter): Promise<ApiResult<ProductPage>> {
  const res = await get(`/api/commerce/shop/products${qs({ q: f.q?.trim(), status: f.status, category_id: f.categoryId, stock: f.stock, limit: f.limit, offset: f.offset })}`);
  return result(res, (j) => ({ products: (j.products as ShopProductSummary[]) ?? [], total: Number(j.total ?? 0),
    currency: (j.currency as string | null) ?? null, shop_url: (j.shop_url as string | null) ?? null }));
}

export async function fetchShopProduct(id: string): Promise<ApiResult<ShopProduct>> {
  return result(await get(productUrl(id)), asProduct);
}

export type ProductBody = Partial<Pick<ShopProduct, "name" | "description" | "disclosure" | "category_id" | "follow_up_template"
  | "follow_up_template_language" | "follow_up_after_days" | "repurchase_after_days" | "cod_available" | "tags" | "brand" | "product_type" | "details"
  | "publish_at" | "hide_at" | "is_digital" | "digital_media_id" | "digital_url" | "is_bundle" | "slug" | "seo_title" | "seo_description" | "seo_image_id">> & { version?: number; images?: ({ url: string } | { media_id: string })[] };

/** One row of the options matrix as the product form saves it (blank SKU = generated on the server). */
export interface VariantRowBody extends Omit<VariantBody, "archived" | "position" | "image_id"> {
  id?: string | null;
  image_index?: number | null;
  /** Units on hand to set (tracked variants); `expected_on_hand` is the count the form was read with. */
  stock?: number | null;
  expected_on_hand?: number;
}

export type ProductFormBody = ProductBody & { variants?: VariantRowBody[]; parts?: Array<{ variant_id: string; quantity: number }> };

/** The product form's one Save: create (id null) or update the product with its photos, variants and parts. */
export async function saveProductForm(id: string | null, body: ProductFormBody): Promise<ApiResult<{ product: ShopProduct; stockError: string | null }>> {
  const res = id ? await send(productUrl(id), "PATCH", body) : await send("/api/commerce/shop/products", "POST", body);
  return result(res, (j) => ({ product: j.product as ShopProduct, stockError: typeof j.stock_error === "string" ? j.stock_error : null }));
}

export type BulkAction = "live" | "hidden" | "archive" | "category";

/** One list action over the chosen products (admins); products it does not fit are skipped. */
export async function bulkProducts(action: BulkAction, ids: string[], categoryId?: string | null): Promise<ApiResult<{ changed: number; skipped: number }>> {
  return result(await send("/api/commerce/shop/products/bulk", "POST", { action, ids, ...(action === "category" ? { category_id: categoryId ?? null } : {}) }),
    (j) => ({ changed: Number(j.changed ?? 0), skipped: Number(j.skipped ?? 0) }));
}

/** Upload one photo to the media library (the same path the media picker uses); the product links it on Save. */
export async function uploadPhoto(file: File): Promise<ApiResult<{ id: string; url: string }>> {
  const form = new FormData();
  form.set("file", file);
  const res = await authFetch("/api/media/library", { method: "POST", body: form }).catch(() => null);
  if (!res) return { ok: false, status: 0 };
  return result(res, (j) => { const item = j.item as { id: string; url: string }; return { id: item.id, url: item.url }; });
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
  preorder?: boolean;
  preorder_ship_date?: string | null;
  preorder_cap?: number | null;
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

export type { LocationQuantity, PoAction, PurchaseOrder, PurchaseOrderSummary, StockLocation, StockTransfer };

// Stock locations, transfers and purchase orders (store plan Phase 8).
export async function fetchLocations(): Promise<ApiResult<StockLocation[]>> {
  return result(await get("/api/commerce/stock-locations"), (j) => (j.locations as StockLocation[]) ?? []);
}
export async function fetchVariantLocations(variantId: string): Promise<ApiResult<LocationQuantity[]>> {
  return result(await get(`/api/commerce/stock-locations${qs({ variant_id: variantId })}`), (j) => (j.quantities as LocationQuantity[]) ?? []);
}
export async function createLocation(name: string): Promise<ApiResult<StockLocation>> {
  return result(await send("/api/commerce/stock-locations", "POST", { name }), (j) => j.location as StockLocation);
}
export async function updateLocation(id: string, body: { name?: string; active?: boolean }): Promise<ApiResult<StockLocation>> {
  return result(await send(`/api/commerce/stock-locations/${encodeURIComponent(id)}`, "PATCH", body), (j) => j.location as StockLocation);
}
export async function fetchTransfers(): Promise<ApiResult<StockTransfer[]>> {
  return result(await get("/api/commerce/stock-transfers"), (j) => (j.transfers as StockTransfer[]) ?? []);
}
export async function transferStock(body: { client_key: string; from_location_id: string; to_location_id: string; variant_id: string; quantity: number }):
  Promise<ApiResult<{ transferId: string; replayed: boolean }>> {
  return result(await send("/api/commerce/stock-transfers", "POST", body), (j) => j as { transferId: string; replayed: boolean });
}
const poUrl = (id: string) => `/api/commerce/purchase-orders/${encodeURIComponent(id)}`;
const asPo = (json: Record<string, unknown>) => json.order as PurchaseOrder;
export async function fetchPurchaseOrders(): Promise<ApiResult<PurchaseOrderSummary[]>> {
  return result(await get("/api/commerce/purchase-orders"), (j) => (j.orders as PurchaseOrderSummary[]) ?? []);
}
export async function fetchPurchaseOrder(id: string): Promise<ApiResult<PurchaseOrder>> {
  return result(await get(poUrl(id)), asPo);
}
export async function createPurchaseOrder(body: {
  supplier_name: string; reference: string | null; note: string | null; lines: Array<{ variant_id: string; qty_ordered: number; unit_cost_minor: number }>;
}): Promise<ApiResult<PurchaseOrder>> {
  return result(await send("/api/commerce/purchase-orders", "POST", body), asPo);
}
export async function changePurchaseOrderStatus(id: string, action: PoAction): Promise<ApiResult<PurchaseOrder>> {
  return result(await send(`${poUrl(id)}/status`, "POST", { action }), asPo);
}
export async function receivePurchaseOrder(id: string, body: { request_key: string; location_id: string | null; lines: Array<{ line_id: string; quantity: number }> }):
  Promise<ApiResult<PurchaseOrder>> {
  return result(await send(`${poUrl(id)}/receive`, "POST", body), asPo);
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
