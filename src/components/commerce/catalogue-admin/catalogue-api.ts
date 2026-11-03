"use client";

// Browser-side calls to /api/commerce/shop/** and /api/commerce/inventory/**.
// Every request goes through authFetch, which adds the session and the
// mutation-origin (CSRF) headers. Errors come back as codes, never input text.

import { authFetch } from "@/lib/auth/client";
import type {
  MetaLinkReport, ProductStatus, ShopCategory, ShopProduct, ShopProductSummary, StockFilter,
} from "@/lib/commerce/catalogue/products";
import type { AdjustKind, InventoryFilter, InventoryRow, MovementRow } from "@/lib/commerce/catalogue/inventory";

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
  | "follow_up_template_language" | "follow_up_after_days">> & { version?: number; images?: ({ url: string } | { media_id: string })[] };

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
