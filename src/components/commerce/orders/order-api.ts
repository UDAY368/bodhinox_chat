"use client";

// Browser-side calls to /api/commerce/orders. authFetch adds the session and
// the mutation-origin headers.

import { authFetch } from "@/lib/auth/client";
import type { FulfilmentEvidence, OrderSource, OrderStatus, RefundState } from "@/lib/commerce/order-format";
import type { ShipmentExceptionView } from "@/lib/fulfilment/exceptions";
import type { OrderShipmentView, ShipmentExceptionResolution } from "@/lib/fulfilment/types";

export interface OrderListItem {
  id: string;
  source: OrderSource;
  external_id: string | null;
  status: OrderStatus;
  currency: string;
  subtotal_minor: number;
  total_minor: number | null;
  /** 'cod': cash on delivery; absent from older responses (= online). */
  payment_method?: 'online' | 'cod';
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
  priced_at: string | null;
  discount_minor: number;
  shipping_minor: number;
  /** The cash-on-delivery fee inside the total; absent from older responses. */
  cod_fee_minor?: number;
  tax_minor: number;
  tax_inclusive: boolean | null;
  coupon_code: string | null;
  shipping_address: Record<string, unknown> | null;
  reservation_expires_at: string | null;
  paid_at: string | null;
  amount_paid_minor: number;
  amount_refunded_minor: number;
  refund_state: RefundState;
  dispatched_at: string | null;
  delivered_at: string | null;
  tracking_note: string | null;
  feedback_score: number | null;
  /** The courier shipment (Shiprocket), or null; absent from older responses. */
  shipment?: OrderShipmentView | null;
  /** How the current dispatch or delivery is known; null before dispatch. */
  evidence?: FulfilmentEvidence | null;
  items: Array<{
    id: string; retailer_id: string | null; name: string | null; quantity: number; unit_price_minor: number; currency: string;
    variant_id?: string | null; sku?: string | null; tax_minor?: number | null; discount_minor?: number | null;
    line_total_minor?: number | null;
  }>;
}

export interface OrderTimeline {
  events: Array<{ id: string; kind: string; from_status: string | null; to_status: string | null; actor: string;
    actor_name: string | null; detail: string | null; created_at: string }>;
  documents: Array<{ id: string; kind: "receipt" | "credit_note"; number: string; total_minor: number; currency: string; issued_at: string }>;
  messages: Array<{ kind: string; status: string; reason: string | null; resolved_at: string | null; updated_at: string }>;
}

export interface OrderReturn {
  id: string;
  order_id: string;
  status: "requested" | "received" | "inspected" | "closed" | "rejected";
  items: Array<{ order_item_id: string; qty: number }>;
  disposition: Record<string, "restock" | "discard"> | null;
  refund_id: string | null;
  note: string | null;
  restocked_at: string | null;
  created_at: string;
  updated_at: string;
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

const post = (url: string, body: unknown) => authFetch(url, {
  method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
});
const orderUrl = (id: string, path: string) => `/api/commerce/orders/${encodeURIComponent(id)}/${path}`;

export async function dispatchOrder(id: string, input: { from: OrderStatus; tracking_note?: string | null }): Promise<ApiResult<true>> {
  return result(await post(orderUrl(id, "dispatch"), input), "ok");
}

export async function deliverOrder(id: string, input: { from: OrderStatus }): Promise<ApiResult<true>> {
  return result(await post(orderUrl(id, "deliver"), input), "ok");
}

export async function recordOrderFeedback(id: string, score: number): Promise<ApiResult<true>> {
  return result(await post(orderUrl(id, "feedback"), { score }), "ok");
}

/**
 * "Cancel and refund". refundedOutside is the staff's confirmation that money
 * Razorpay does not hold (an offline payment, or a legacy order with no payment
 * record) was returned outside the app; without it the server answers 409
 * offline_payment and requests nothing.
 */
export async function cancelAndRefundOrder(id: string, note: string | null, refundedOutside = false): Promise<ApiResult<{ refundIds: string[]; refundedOutside: boolean }>> {
  const res = await post(orderUrl(id, "cancel-refund"), refundedOutside ? { note, refunded_outside: true } : { note });
  const r = await result<string[]>(res.clone(), "refund_ids");
  if (!r.ok) return r;
  const json = (await res.json().catch(() => ({}))) as { refunded_outside?: unknown };
  return { ok: true, value: { refundIds: r.value, refundedOutside: json.refunded_outside === true } };
}

export async function getOrderTimeline(id: string): Promise<OrderTimeline | null> {
  const res = await authFetch(orderUrl(id, "events"), { cache: "no-store" });
  return res.ok ? ((await res.json()) as OrderTimeline) : null;
}

export async function listOrderReturns(id: string): Promise<OrderReturn[]> {
  const res = await authFetch(orderUrl(id, "returns"), { cache: "no-store" });
  return res.ok ? ((await res.json()) as { returns: OrderReturn[] }).returns : [];
}

export async function createOrderReturn(id: string, input: { items: Array<{ order_item_id: string; qty: number }>; note?: string | null }): Promise<ApiResult<OrderReturn>> {
  return result(await post(orderUrl(id, "returns"), input), "return");
}

export type ReturnAction =
  | { action: "receive" } | { action: "reject" }
  | { action: "inspect"; disposition: Record<string, "restock" | "discard"> }
  | { action: "close"; restock: boolean };

export async function moveReturn(returnId: string, input: ReturnAction): Promise<ApiResult<OrderReturn>> {
  return result(await post(`/api/commerce/returns/${encodeURIComponent(returnId)}`, input), "return");
}

/**
 * Refund an inspected return. refundedOutside confirms that money Razorpay does
 * not hold (cash on delivery, a staff-recorded payment) was handed back outside
 * the app; without it the server answers 409 offline_payment and records nothing.
 */
export async function refundReturn(returnId: string, amountMinor: number, note: string | null, refundedOutside = false): Promise<ApiResult<string>> {
  return result(await post(`/api/commerce/returns/${encodeURIComponent(returnId)}`, {
    action: "refund", amount_minor: amountMinor, note, ...(refundedOutside ? { refunded_outside: true } : {}),
  }), "refund_id");
}

export const documentUrl = (documentId: string) => `/api/commerce/documents/${encodeURIComponent(documentId)}`;

export type { ShipmentExceptionView };

/** Open (default) or resolved courier shipment exceptions; admins with commerce.shipments, else null. */
export async function listShipmentExceptions(status: "open" | "resolved" = "open"): Promise<ShipmentExceptionView[] | null> {
  const res = await authFetch(`/api/commerce/shipment-exceptions?status=${status}`, { cache: "no-store" });
  if (!res.ok) return null;
  const json = (await res.json().catch(() => ({}))) as { exceptions?: ShipmentExceptionView[] };
  return Array.isArray(json.exceptions) ? json.exceptions : null;
}

export async function resolveShipmentException(id: string, resolution: ShipmentExceptionResolution): Promise<ApiResult<ShipmentExceptionView>> {
  return result(await post(`/api/commerce/shipment-exceptions/${encodeURIComponent(id)}`, { resolution }), "exception");
}
