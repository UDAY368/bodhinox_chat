import { authFetch } from "@/lib/auth/client";

/** lib/payments/queries CustomerPaymentView. */
export interface CustomerPaymentItem {
  id: string;
  source: "razorpay" | "offline";
  provider_payment_id: string | null;
  payment_link_id: string | null;
  order_id: string | null;
  appointment_id: string | null;
  amount_minor: number;
  refunded_minor: number;
  refundable_minor: number;
  currency: string;
  status: "authorized" | "captured" | "failed";
  settlement: "pending" | "settled" | "exception" | "unattached";
  method: string | null;
  offline_reference: string | null;
  recorded_by: string | null;
  captured_at: string | null;
  created_at: string;
}

/** lib/payments/queries CustomerRefundView. */
export interface CustomerRefundItem {
  id: string;
  payment_id: string;
  order_id: string | null;
  appointment_id: string | null;
  source: "bodhinox" | "external";
  amount_minor: number;
  currency: string;
  reason_code: RefundReason;
  note: string | null;
  status: "requested" | "sending" | "pending" | "processed" | "failed" | "unknown";
  failure_code: string | null;
  attempt: number;
  restock: boolean;
  return_id: string | null;
  requested_by: string | null;
  processed_at: string | null;
  created_at: string;
}

export const EXCEPTION_KINDS = [
  "late_payment_no_stock", "late_payment_slot_lost", "payment_on_closed_order", "duplicate_payment",
  "amount_mismatch", "currency_mismatch", "merchant_changed", "payment_unmatched", "refund_unknown", "refund_failed",
] as const;
export type ExceptionKind = (typeof EXCEPTION_KINDS)[number];
export type Resolution = "refunded" | "restocked" | "accepted" | "dismissed";

/** lib/payments/exceptions PaymentExceptionView. */
export interface PaymentExceptionItem {
  id: string;
  kind: ExceptionKind;
  status: "open" | "resolved";
  resolution: Resolution | null;
  detail: string | null;
  order_id: string | null;
  payment_id: string | null;
  refund_id: string | null;
  appointment_id: string | null;
  payment_link_id: string | null;
  amount_minor: number | null;
  currency: string | null;
  allowed_resolutions: Resolution[];
  resolved_by: string | null;
  resolved_at: string | null;
  created_at: string;
}

export interface ReconciliationDay {
  day: string;
  currency: string;
  captured_minor: number;
  captured_count: number;
  refunds_minor: number;
  refunds_count: number;
  external_refunds_minor: number;
  net_minor: number;
}

export interface ReconciliationReport {
  from: string;
  to: string;
  timezone: string;
  days: ReconciliationDay[];
  totals: Omit<ReconciliationDay, "day">[];
  open_exceptions: number;
  unresolved_refunds: number;
}

export const REFUND_REASONS = ["customer_request", "out_of_stock", "return", "duplicate", "cancelled", "other"] as const;
export type RefundReason = (typeof REFUND_REASONS)[number];
export const OFFLINE_METHODS = ["cash", "upi", "bank_transfer", "card", "cheque", "other"] as const;
export type OfflineMethod = (typeof OFFLINE_METHODS)[number];

/** Throws an Error carrying the server's message and `status`. */
async function json<T>(res: Response, fallback: string): Promise<T> {
  const body = (await res.json().catch(() => ({}))) as { error?: unknown };
  if (!res.ok) {
    const error = new Error(typeof body.error === "string" ? body.error : fallback) as Error & { status?: number };
    error.status = res.status;
    throw error;
  }
  return body as T;
}

const query = (params: Record<string, string | undefined>) => {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v) q.set(k, v);
  return q.toString();
};

export async function listCustomerPayments(params: { orderId?: string; before?: string }, fallback: string): Promise<CustomerPaymentItem[]> {
  const res = await authFetch(`/api/payments/customer-payments?${query({ order_id: params.orderId, before: params.before, limit: "50" })}`, { cache: "no-store" });
  return (await json<{ payments: CustomerPaymentItem[] }>(res, fallback)).payments;
}

export async function listRefunds(params: { orderId?: string; status?: string; before?: string }, fallback: string): Promise<CustomerRefundItem[]> {
  const res = await authFetch(`/api/payments/refunds?${query({ order_id: params.orderId, status: params.status, before: params.before, limit: "50" })}`, { cache: "no-store" });
  return (await json<{ refunds: CustomerRefundItem[] }>(res, fallback)).refunds;
}

export async function requestRefund(paymentId: string, body: { amount: string; reason: RefundReason; note?: string; restock: boolean; client_request_id: string }, fallback: string): Promise<string> {
  const res = await authFetch(`/api/payments/customer-payments/${paymentId}/refund`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  return (await json<{ refund_id: string }>(res, fallback)).refund_id;
}

export async function refundAction(refundId: string, action: "reconcile" | "retry", fallback: string): Promise<void> {
  const res = await authFetch(`/api/payments/refunds/${refundId}`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action }),
  });
  await json<unknown>(res, fallback);
}

export async function listExceptions(status: "open" | "resolved", fallback: string, orderId?: string): Promise<PaymentExceptionItem[]> {
  const res = await authFetch(`/api/commerce/payment-exceptions?${query({ status, order_id: orderId, limit: "50" })}`, { cache: "no-store" });
  return (await json<{ exceptions: PaymentExceptionItem[] }>(res, fallback)).exceptions;
}

export async function resolveException(id: string, resolution: Resolution, fallback: string): Promise<void> {
  const res = await authFetch(`/api/commerce/payment-exceptions/${id}/resolve`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ resolution }),
  });
  await json<unknown>(res, fallback);
}

export async function fetchReconciliation(range: { from?: string; to?: string }, fallback: string): Promise<ReconciliationReport> {
  const res = await authFetch(`/api/payments/reconciliation?${query(range)}`, { cache: "no-store" });
  return (await json<{ report: ReconciliationReport }>(res, fallback)).report;
}

export async function recordOfflinePayment(orderId: string, body: { amount: string; method: OfflineMethod; reference?: string; client_request_id: string }, fallback: string): Promise<string> {
  const res = await authFetch(`/api/commerce/orders/${orderId}/offline-payment`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  return (await json<{ payment_id: string }>(res, fallback)).payment_id;
}
