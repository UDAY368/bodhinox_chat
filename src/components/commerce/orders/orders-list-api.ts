"use client";

// Browser calls for the Orders screen's list tabs: the filtered order list and its CSV export (one query string
// for both, so the file always matches the list), the returns queue, quotes and bulk dispatch. authFetch adds the
// session and the mutation-origin headers.

import { authFetch } from "@/lib/auth/client";
import type { OrderSource, OrderStatus } from "@/lib/commerce/order-format";
import type { OrderListItem } from "./order-api";

export type PaymentFilter = "paid" | "waiting" | "refunded" | "partly_refunded" | "cod";
export const PAYMENT_FILTERS: readonly PaymentFilter[] = ["paid", "waiting", "refunded", "partly_refunded", "cod"];

export interface OrderQuery {
  status?: OrderStatus | "";
  source?: OrderSource | "";
  q?: string;
  tag?: string;
  /** Only COD orders waiting for the customer's answer, or that declined. */
  codConfirmation?: "pending" | "declined" | "";
  payment?: PaymentFilter | "";
  /** Cash still to collect (lib/commerce/orders CASH_DUE). */
  cashDue?: boolean;
  /** ISO instants, inclusive. */
  from?: string | null;
  to?: string | null;
}

/** The query string the list and the export share. */
export function orderQueryParams(query: OrderQuery): URLSearchParams {
  const params = new URLSearchParams();
  if (query.status) params.set("status", query.status);
  if (query.source) params.set("source", query.source);
  if (query.codConfirmation) params.set("cod_confirmation", query.codConfirmation);
  if (query.payment) params.set("payment", query.payment);
  if (query.cashDue) params.set("cash_due", "1");
  if (query.q?.trim()) params.set("q", query.q.trim());
  if (query.tag?.trim()) params.set("tag", query.tag.trim());
  if (query.from) params.set("from", query.from);
  if (query.to) params.set("to", query.to);
  return params;
}

export async function listOrders(query: OrderQuery & { cursor?: string | null }): Promise<{ orders: OrderListItem[]; next_cursor: string | null; total: number | null }> {
  const params = orderQueryParams(query);
  if (query.cursor) params.set("cursor", query.cursor);
  const res = await authFetch(`/api/commerce/orders?${params}`, { cache: "no-store" });
  if (!res.ok) throw new Error(`orders ${res.status}`);
  const json = (await res.json()) as { orders: OrderListItem[]; next_cursor: string | null; total?: number | null };
  return { orders: json.orders, next_cursor: json.next_cursor, total: json.total ?? null };
}

/** Download the CSV for these filters; `truncated` when the server's row cap cut it. */
export async function exportOrders(query: OrderQuery): Promise<{ ok: true; rows: number; truncated: boolean } | { ok: false; status: number }> {
  const res = await authFetch(`/api/commerce/orders/export?${orderQueryParams(query)}`, { cache: "no-store" });
  if (!res.ok) return { ok: false, status: res.status };
  const blob = await res.blob();
  const name = /filename="([^"]+)"/.exec(res.headers.get("content-disposition") ?? "")?.[1] ?? "orders.csv";
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
  return { ok: true, rows: Number(res.headers.get("x-rows") ?? 0), truncated: res.headers.get("x-truncated") === "1" };
}

// ---------------------------------------------------------------- returns queue

export type ReturnQueueFilter = "open" | "requested" | "received" | "inspected" | "closed" | "rejected";
export interface ReturnQueueItem {
  id: string;
  order_id: string;
  order_ref: string;
  status: "requested" | "received" | "inspected" | "closed" | "rejected";
  source: "staff" | "buyer";
  pending_approval: boolean;
  units: number;
  is_exchange: boolean;
  contact_name: string | null;
  created_at: string;
  updated_at: string;
}
export const RETURN_QUEUE_PAGE = 25;

export async function listReturnQueue(status: ReturnQueueFilter | "", page: number): Promise<{ returns: ReturnQueueItem[]; total: number }> {
  const params = new URLSearchParams({ page: String(page) });
  if (status) params.set("status", status);
  const res = await authFetch(`/api/commerce/returns?${params}`, { cache: "no-store" });
  if (!res.ok) throw new Error(`returns ${res.status}`);
  return (await res.json()) as { returns: ReturnQueueItem[]; total: number };
}

// ---------------------------------------------------------------- quotes

export interface QuoteListItem {
  id: string;
  state: "open" | "expired" | "revoked" | "ordered";
  contact: { id: string; name: string | null } | null;
  item_count: number;
  note: string | null;
  expires_at: string;
  created_at: string;
}

export async function listQuotes(): Promise<QuoteListItem[]> {
  const res = await authFetch("/api/commerce/quotes", { cache: "no-store" });
  if (!res.ok) throw new Error(`quotes ${res.status}`);
  return ((await res.json()) as { quotes: QuoteListItem[] }).quotes;
}

/** Stop a sent quote's link at once (the storefront link revoke; a placed order is unaffected). */
export async function revokeQuote(id: string): Promise<{ ok: boolean; status: number }> {
  const res = await authFetch(`/api/commerce/storefront-links/${encodeURIComponent(id)}`, { method: "DELETE" });
  return { ok: res.ok, status: res.status };
}

// ---------------------------------------------------------------- bulk dispatch

export const BULK_DISPATCH_MAX = 25;
export type BulkResult = { order_id: string; ok: true; shipment_id?: string; url?: string } | { order_id: string; ok: false; code: string };

export async function bulkDispatch(action: "create" | "labels", orderIds: string[]): Promise<
  { ok: true; results: BulkResult[] } | { ok: false; status: number; code?: string }
> {
  const res = await authFetch("/api/commerce/shipments/bulk", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action, order_ids: orderIds }),
  });
  const json = (await res.json().catch(() => ({}))) as { results?: BulkResult[]; code?: string };
  if (res.ok && Array.isArray(json.results)) return { ok: true, results: json.results };
  return { ok: false, status: res.status, code: typeof json.code === "string" ? json.code : undefined };
}

// ---------------------------------------------------------------- date range

export type DatePreset = "any" | "today" | "d7" | "d30" | "month" | "custom";
export const DATE_PRESETS: readonly DatePreset[] = ["any", "today", "d7", "d30", "month", "custom"];

/**
 * The from/to instants (ISO, inclusive) for a preset in the browser's own time zone. Custom days are
 * YYYY-MM-DD from a date input: the whole of each day counts.
 */
export function dateRangeFor(preset: DatePreset, custom: { from: string; to: string }, now = new Date()): { from: string | null; to: string | null } {
  const startOf = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const daysAgo = (n: number) => startOf(new Date(now.getFullYear(), now.getMonth(), now.getDate() - n));
  const day = (value: string, end: boolean): Date | null => {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
    if (!m) return null;
    return end ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 23, 59, 59, 999) : new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  };
  switch (preset) {
    case "today": return { from: daysAgo(0).toISOString(), to: null };
    case "d7": return { from: daysAgo(6).toISOString(), to: null };
    case "d30": return { from: daysAgo(29).toISOString(), to: null };
    case "month": return { from: new Date(now.getFullYear(), now.getMonth(), 1).toISOString(), to: null };
    case "custom": return { from: day(custom.from, false)?.toISOString() ?? null, to: day(custom.to, true)?.toISOString() ?? null };
    default: return { from: null, to: null };
  }
}
