// Pure helpers for the Sales → Orders screens: the separate Payment and
// Fulfilment states an order shows, the next fulfilment step staff can take,
// the default customer update text, and the CSV export. Client-safe.
import { canTransition, type OrderStatus, type RefundState } from "@/lib/commerce/order-format";

export type Tone = "ok" | "warn" | "bad" | "accent" | "neutral";
export type PaymentState = "paid" | "pending" | "refunded" | "partlyRefunded" | "cod";
export type FulfilmentState = "new" | "confirmed" | "shipped" | "delivered" | "cancelled" | "expired" | "review";

type Paymentish = { status: OrderStatus; paid_at?: string | null; refund_state?: RefundState; payment_method?: "online" | "cod" };

export function paymentState(o: Paymentish): PaymentState {
  if (o.refund_state === "full") return "refunded";
  if (o.refund_state === "partial") return "partlyRefunded";
  if (o.paid_at || o.status === "paid") return "paid";
  if (o.payment_method === "cod" && o.status !== "cancelled" && o.status !== "expired") return "cod";
  return "pending";
}

export function fulfilmentState(status: OrderStatus): FulfilmentState {
  switch (status) {
    case "dispatched": return "shipped";
    case "fulfilled": return "delivered";
    case "cancelled": return "cancelled";
    case "expired": return "expired";
    case "payment_review": return "review";
    case "confirmed": return "confirmed";
    default: return "new";
  }
}

export const PAYMENT_TONE: Record<PaymentState, Tone> = { paid: "ok", pending: "warn", refunded: "bad", partlyRefunded: "warn", cod: "accent" };
export const FULFILMENT_TONE: Record<FulfilmentState, Tone> = {
  new: "neutral", confirmed: "neutral", shipped: "accent", delivered: "ok", cancelled: "bad", expired: "neutral", review: "warn",
};

/** The next fulfilment step staff can take from this state, or null (the server re-checks every rule). */
export type NextStep = "confirm" | "ship" | "deliver";
export function nextStep(o: {
  status: OrderStatus; priced_at: string | null; payment_method?: "online" | "cod"; paid_at?: string | null; refund_state?: RefundState;
}): NextStep | null {
  // Refunded in full before it left: the goods must not ship.
  if (o.refund_state === "full" && o.status !== "dispatched" && o.status !== "fulfilled") return null;
  const unpaidCod = o.payment_method === "cod" && !o.paid_at && o.priced_at !== null;
  const opts = { priced: o.priced_at !== null, unpaidCod };
  if (canTransition(o.status, "dispatched", opts)) return "ship";
  if ((o.status === "dispatched" || o.status === "confirmed") && canTransition(o.status, "fulfilled", opts)) return "deliver";
  if (o.status === "new" && canTransition(o.status, "confirmed", opts)) return "confirm";
  return null;
}

/** May the order still be cancelled without a refund (nothing paid)? */
export function canCancelUnpaid(o: { status: OrderStatus; paid_at?: string | null; amount_paid_minor?: number }): boolean {
  return ["new", "confirmed", "awaiting_payment"].includes(o.status) && !o.paid_at && !(o.amount_paid_minor ?? 0);
}

/** May the customer still pay online (a payment link)? */
export function canTakeLinkPayment(o: { status: OrderStatus; paid_at?: string | null; payment_method?: "online" | "cod" }): boolean {
  return ["new", "confirmed", "awaiting_payment"].includes(o.status) && !o.paid_at && o.payment_method !== "cod";
}

/** The key under Sales.orders.updateText for the customer update. */
export function updateTextKey(status: OrderStatus): "confirmed" | "paid" | "dispatched" | "fulfilled" | "cancelled" | "other" {
  if (status === "confirmed" || status === "paid" || status === "dispatched" || status === "fulfilled" || status === "cancelled") return status;
  return "other";
}

export const orderRef = (o: { id: string; external_id: string | null }): string =>
  o.external_id ? `#${o.external_id}` : o.id.slice(0, 8).toUpperCase();

/** One CSV cell: quoted, quotes doubled, and a leading = + - @ (or tab/CR) neutralised so a spreadsheet never runs it. */
export function csvCell(value: string | number | null | undefined): string {
  let text = value === null || value === undefined ? "" : String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}

export function toCsv(rows: ReadonlyArray<ReadonlyArray<string | number | null | undefined>>): string {
  return rows.map((r) => r.map(csvCell).join(",")).join("\r\n");
}

/**
 * The customer picker's options: the latest search results, with the chosen customer kept at the top when a
 * new search no longer returns them (otherwise the select would look empty while a customer is still chosen).
 */
export function withChosenOption<T extends { id: string }>(options: readonly T[], chosen: T | null): T[] {
  if (!chosen || options.some((o) => o.id === chosen.id)) return [...options];
  return [chosen, ...options];
}
