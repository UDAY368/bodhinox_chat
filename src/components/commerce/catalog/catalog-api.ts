"use client";

// Browser-side calls to /api/commerce/catalogs, /api/commerce/products and
// /api/whatsapp/send-product. Every request goes through authFetch, which adds
// the session and the mutation-origin headers.

import { authFetch } from "@/lib/auth/client";
import type { CatalogPublic, MetaCatalogChoice, ProductPublic } from "@/lib/commerce/catalog";

export type { CatalogPublic, MetaCatalogChoice, ProductPublic };

export type ApiResult<T> = { ok: true; data: T } | { ok: false; status: number; error?: string; code?: string };

async function result<T>(res: Response, pick: (json: Record<string, unknown>) => T): Promise<ApiResult<T>> {
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (res.ok) return { ok: true, data: pick(json) };
  return {
    ok: false,
    status: res.status,
    error: typeof json.error === "string" ? json.error : undefined,
    code: typeof json.code === "string" ? json.code : undefined,
  };
}

const jsonInit = (method: string, body?: unknown): RequestInit => ({
  method,
  headers: { "Content-Type": "application/json" },
  body: body === undefined ? undefined : JSON.stringify(body),
});

export async function fetchCatalogs(): Promise<CatalogPublic[]> {
  const res = await authFetch("/api/commerce/catalogs", { cache: "no-store" });
  if (!res.ok) throw new Error(`catalogs ${res.status}`);
  return (((await res.json()) as { catalogs?: CatalogPublic[] }).catalogs) ?? [];
}

export async function fetchMetaCatalogs(whatsappConfigId: string): Promise<ApiResult<MetaCatalogChoice[]>> {
  const res = await authFetch(`/api/commerce/catalogs?whatsapp_config_id=${encodeURIComponent(whatsappConfigId)}`, { cache: "no-store" });
  return result(res, (json) => (json.available as MetaCatalogChoice[] | undefined) ?? []);
}

export async function connectCatalog(body: {
  whatsapp_config_id: string;
  catalog_id: string;
  is_cart_enabled: boolean;
  is_catalog_visible: boolean;
}): Promise<ApiResult<CatalogPublic>> {
  return result(await authFetch("/api/commerce/catalogs", jsonInit("POST", body)), (json) => json.catalog as CatalogPublic);
}

export async function updateCatalog(id: string, patch: { is_cart_enabled?: boolean; is_catalog_visible?: boolean }): Promise<ApiResult<CatalogPublic>> {
  return result(await authFetch(`/api/commerce/catalogs/${encodeURIComponent(id)}`, jsonInit("PATCH", patch)), (json) => json.catalog as CatalogPublic);
}

export async function deleteCatalog(id: string): Promise<ApiResult<true>> {
  return result(await authFetch(`/api/commerce/catalogs/${encodeURIComponent(id)}`, { method: "DELETE" }), () => true as const);
}

export async function syncCatalog(id: string): Promise<ApiResult<true>> {
  return result(await authFetch(`/api/commerce/catalogs/${encodeURIComponent(id)}/sync`, { method: "POST" }), () => true as const);
}

export interface ProductFilter {
  q?: string;
  availability?: "in_stock" | "out_of_stock" | "other";
  catalogId?: string;
  whatsappConfigId?: string;
  conversationId?: string;
  hidden?: boolean;
  limit?: number;
  offset?: number;
}

/** Query string for /api/commerce/products; empty values are left out. */
export function productQueryString(filter: ProductFilter): string {
  const params = new URLSearchParams();
  if (filter.q?.trim()) params.set("q", filter.q.trim());
  if (filter.availability) params.set("availability", filter.availability);
  if (filter.catalogId) params.set("catalog_id", filter.catalogId);
  if (filter.whatsappConfigId) params.set("whatsapp_config_id", filter.whatsappConfigId);
  if (filter.conversationId) params.set("conversation_id", filter.conversationId);
  if (filter.hidden) params.set("hidden", "1");
  if (filter.limit) params.set("limit", String(filter.limit));
  if (filter.offset) params.set("offset", String(filter.offset));
  const text = params.toString();
  return text ? `?${text}` : "";
}

export async function fetchProducts(filter: ProductFilter = {}): Promise<{ products: ProductPublic[]; total: number }> {
  const res = await authFetch(`/api/commerce/products${productQueryString(filter)}`, { cache: "no-store" });
  if (!res.ok) throw new Error(`products ${res.status}`);
  const json = (await res.json()) as { products?: ProductPublic[]; total?: number };
  return { products: json.products ?? [], total: json.total ?? 0 };
}

export type SendProductBody =
  | { kind: "product"; product_id: string; body?: string; footer?: string }
  | { kind: "product_list"; header: string; body: string; footer?: string; sections: { title: string; product_ids: string[] }[] }
  | { kind: "catalog"; body: string; footer?: string; thumbnail_product_id?: string };

export async function sendProduct(conversationId: string, clientRequestId: string, body: SendProductBody): Promise<ApiResult<true>> {
  return result(
    await authFetch("/api/whatsapp/send-product", jsonInit("POST", { ...body, conversation_id: conversationId, client_request_id: clientRequestId })),
    () => true as const,
  );
}

/**
 * Whether a failed send should get a new client_request_id before the next
 * try: a refusal (4xx with a code) or Meta's rejection (502) sent nothing.
 * The uncertain 409 without a code, other 5xx and network failures keep the
 * id, so an unknown outcome is never re-sent.
 */
export function sendRejectedDefinitely(status: number, code: unknown): boolean {
  if (status === 502) return true;
  if (status < 400 || status >= 500) return false;
  return status !== 409 || typeof code === "string";
}
