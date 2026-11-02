"use client";

// Browser-side calls to /api/commerce/orders. authFetch adds the session and
// the mutation-origin headers.

import { authFetch } from "@/lib/auth/client";
import type { OrderSource, OrderStatus } from "@/lib/commerce/order-format";

export interface OrderListItem {
  id: string;
  source: OrderSource;
  external_id: string | null;
  status: OrderStatus;
  currency: string;
  subtotal_minor: number;
  total_minor: number | null;
  item_count: number;
  contact: { id: string; name: string | null; phone: string | null } | null;
  conversation_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface OrderDetail extends OrderListItem {
  catalog_id: string | null;
  whatsapp_config_id: string | null;
  note: string | null;
  customer_note: string | null;
  items: Array<{ id: string; retailer_id: string | null; name: string | null; quantity: number; unit_price_minor: number; currency: string }>;
}

export interface OrderSettings {
  confirmation_mode: "off" | "text" | "template";
  confirmation_text: string | null;
  template_name: string | null;
  template_language: string | null;
  variable_map: Record<string, string>;
}

export interface OrderQuery {
  status?: OrderStatus | "";
  source?: OrderSource | "";
  q?: string;
  cursor?: string | null;
}

export type ApiResult<T> = { ok: true; value: T } | { ok: false; status: number; code?: string; error?: string };

async function result<T>(res: Response, key: string): Promise<ApiResult<T>> {
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (res.ok && json[key] !== undefined) return { ok: true, value: json[key] as T };
  return {
    ok: false, status: res.status,
    code: typeof json.code === "string" ? json.code : undefined,
    error: typeof json.error === "string" ? json.error : undefined,
  };
}

export async function listOrders(query: OrderQuery): Promise<{ orders: OrderListItem[]; next_cursor: string | null }> {
  const params = new URLSearchParams();
  if (query.status) params.set("status", query.status);
  if (query.source) params.set("source", query.source);
  if (query.q?.trim()) params.set("q", query.q.trim());
  if (query.cursor) params.set("cursor", query.cursor);
  const res = await authFetch(`/api/commerce/orders?${params}`, { cache: "no-store" });
  if (!res.ok) throw new Error(`orders ${res.status}`);
  return (await res.json()) as { orders: OrderListItem[]; next_cursor: string | null };
}

export async function getOrder(id: string): Promise<ApiResult<OrderDetail>> {
  return result(await authFetch(`/api/commerce/orders/${encodeURIComponent(id)}`, { cache: "no-store" }), "order");
}

export async function updateOrder(id: string, patch: { status?: OrderStatus; note?: string | null }): Promise<ApiResult<OrderDetail>> {
  return result(await authFetch(`/api/commerce/orders/${encodeURIComponent(id)}`, {
    method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(patch),
  }), "order");
}

export async function getOrderSettings(): Promise<ApiResult<OrderSettings>> {
  return result(await authFetch("/api/commerce/orders/settings", { cache: "no-store" }), "settings");
}

export async function saveOrderSettings(settings: OrderSettings): Promise<ApiResult<OrderSettings>> {
  return result(await authFetch("/api/commerce/orders/settings", {
    method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(settings),
  }), "settings");
}
