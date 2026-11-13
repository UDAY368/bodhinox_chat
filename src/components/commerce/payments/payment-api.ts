import { authFetch } from "@/lib/auth/client";

/** A payment link as the API returns it (lib/payments/links PaymentLinkView). */
export interface PaymentLinkItem {
  id: string;
  provider: "razorpay";
  provider_link_id: string | null;
  short_url: string | null;
  amount_minor: number;
  currency: string;
  description: string | null;
  contact_id: string | null;
  conversation_id: string | null;
  order_id: string | null;
  flow_run_id: string | null;
  node_key: string | null;
  status: PaymentLinkStatus;
  paid_at: string | null;
  expires_at: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export const PAYMENT_LINK_STATUSES = ["creating", "created", "paid", "partially_paid", "expired", "cancelled", "failed", "unknown"] as const;
export type PaymentLinkStatus = (typeof PAYMENT_LINK_STATUSES)[number];

/** Links that can still be settled with Razorpay (an unknown create, or a live link that may have been paid). */
export const RECONCILABLE: ReadonlySet<PaymentLinkStatus> = new Set(["creating", "unknown", "created", "partially_paid"]);

async function json<T>(res: Response, fallback: string): Promise<T> {
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(typeof (body as { error?: unknown }).error === "string" ? (body as { error: string }).error : fallback);
  return body as T;
}

export async function listPaymentLinks(params: { status?: string; before?: string; orderId?: string; q?: string }, fallback: string): Promise<PaymentLinkItem[]> {
  const q = new URLSearchParams({ limit: "50" });
  if (params.status) q.set("status", params.status);
  if (params.q?.trim()) q.set("q", params.q.trim());
  if (params.before) q.set("before", params.before);
  if (params.orderId) q.set("order_id", params.orderId);
  const res = await authFetch(`/api/payments/links?${q.toString()}`, { cache: "no-store" });
  return (await json<{ links: PaymentLinkItem[] }>(res, fallback)).links;
}

export async function paymentLinkAction(id: string, action: "reconcile" | "cancel", fallback: string): Promise<PaymentLinkItem> {
  const res = await authFetch(`/api/payments/links/${id}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action }),
  });
  return (await json<{ link: PaymentLinkItem }>(res, fallback)).link;
}

export interface CreateLinkBody {
  amount: string;
  currency: string;
  description?: string;
  expire_minutes?: number;
  order_id?: string;
  contact_id?: string;
  /** With send: the chat the link is sent into (its own number, the 24-hour window rule applies). */
  conversation_id?: string;
  send?: boolean;
  client_request_id: string;
}

/** What happened to "send this link into the conversation" (lib/payments/http SendResult). */
export type LinkSendResult =
  | { status: "sent"; message_id: string | null }
  | { status: "refused"; code: string; error: string }
  | { status: "rejected"; error: string }
  | { status: "uncertain"; error: string };

/** Creates a link without sending it. Throws with `status` set so the caller can decide whether to keep its request id. */
export async function createPaymentLink(body: CreateLinkBody, fallback: string): Promise<PaymentLinkItem> {
  return (await createPaymentLinkWithSend(body, fallback)).link;
}

/** Creates a link and, with body.send, sends it into body.conversation_id; the send outcome comes back separately. */
export async function createPaymentLinkWithSend(body: CreateLinkBody, fallback: string): Promise<{ link: PaymentLinkItem; send: LinkSendResult | null }> {
  const res = await authFetch("/api/payments/links", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const parsed = await res.json().catch(() => ({})) as { error?: string; code?: string; link?: PaymentLinkItem; send?: LinkSendResult | null };
  if (!res.ok || !parsed.link) {
    const error = new Error(parsed.error || fallback) as Error & { status?: number; code?: string };
    error.status = res.status;
    error.code = parsed.code;
    throw error;
  }
  return { link: parsed.link, send: parsed.send ?? null };
}

/** Send an existing live link (again) into its chat; one send per request id. */
export async function sendPaymentLink(id: string, clientRequestId: string, fallback: string): Promise<LinkSendResult> {
  const res = await authFetch(`/api/payments/links/${encodeURIComponent(id)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "send", client_request_id: clientRequestId }),
  });
  const parsed = await res.json().catch(() => ({})) as { error?: string; send?: LinkSendResult };
  if (parsed.send) return parsed.send;
  return { status: "refused", code: "error", error: parsed.error || fallback };
}

export interface LinkStatsRow {
  currency: string;
  paid: { count: number; amount_minor: number };
  pending: { count: number; amount_minor: number };
  expired: { count: number; amount_minor: number };
}

export async function fetchLinkStats(): Promise<{ stats: LinkStatsRow[]; by_status: Partial<Record<PaymentLinkStatus, number>> } | null> {
  const res = await authFetch("/api/payments/links/stats", { cache: "no-store" });
  if (!res.ok) return null;
  return (await res.json()) as { stats: LinkStatsRow[]; by_status: Partial<Record<PaymentLinkStatus, number>> };
}

/** Links still open for payment. */
export const LIVE_LINK: ReadonlySet<PaymentLinkStatus> = new Set(["created", "partially_paid"]);
