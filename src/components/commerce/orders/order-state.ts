// UI helpers for the Sales → Orders screens: the default customer update text, the visible order reference,
// the CSV export and the customer picker. The order's state rules (payment and fulfilment state, tones, next
// step, allowed actions) live in @/lib/commerce/order-state, shared with the server; re-exported here for the
// screens that read them with these helpers. Client-safe.
import type { OrderStatus } from "@/lib/commerce/order-format";

export {
  canCancelUnpaid, canTakeLinkPayment, COD_CONFIRM_TONE, FULFILMENT_TONE, fulfilmentState, nextStep, PAYMENT_TONE, paymentState,
  type FulfilmentState, type NextStep, type PaymentState, type Tone,
} from "@/lib/commerce/order-state";

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
