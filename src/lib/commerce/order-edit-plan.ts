/**
 * Order edits and split shipments without the database (Store Phase 5): the
 * line diff of an edit, what happens to the payment difference, how a refund
 * is spread over the order's payments, and the quantities a shipment may carry.
 * Pure and client-safe: the edit dialog previews with the same rules the
 * server enforces. Amounts are integer minor units.
 */
import { CART_LIMITS } from './pricing';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Statuses in which a priced order may be edited: before anything is fully dispatched. */
export const EDITABLE_STATUSES: readonly string[] = ['confirmed', 'paid', 'partially_shipped'];

/** One line of the order as it is now. `shipped` = units in shipments that are not cancelled or failed. */
export interface ExistingLine {
  id: string;
  variantId: string | null;
  quantity: number;
  shipped: number;
}

/** One line of the order as the editor wants it (the full new set of lines, not a patch). */
export interface DesiredLine {
  variantId: string;
  qty: number;
}

export interface LineChange {
  variantId: string;
  /** The existing order line, null for an added one. */
  itemId: string | null;
  before: number;
  after: number;
  /** after − before: positive needs stock, negative gives it back. */
  delta: number;
}

export type LineDiffRefusal = 'invalid' | 'cart_empty' | 'no_change' | 'below_shipped' | 'not_editable';

export type LineDiff =
  | { ok: true; changes: LineChange[]; lines: DesiredLine[] }
  | { ok: false; code: LineDiffRefusal; variantId?: string };

/**
 * Compare the order's lines with the wanted ones. Refuses a malformed or empty
 * set, an order with a line that has no catalogue variant (it cannot be
 * repriced), a line taken below what already shipped, and a set that changes
 * nothing. `changes` holds only the lines whose quantity moves.
 */
export function diffOrderLines(existing: readonly ExistingLine[], desired: readonly DesiredLine[]): LineDiff {
  if (!Array.isArray(desired) || desired.length > CART_LIMITS.maxLines) return { ok: false, code: 'invalid' };
  const wanted = new Map<string, number>();
  for (const line of desired) {
    if (!line || typeof line.variantId !== 'string' || !UUID.test(line.variantId) || !Number.isInteger(line.qty)
      || line.qty < 1 || line.qty > CART_LIMITS.maxQty) return { ok: false, code: 'invalid' };
    const id = line.variantId.toLowerCase();
    if (wanted.has(id)) return { ok: false, code: 'invalid', variantId: id };
    wanted.set(id, line.qty);
  }
  if (!wanted.size) return { ok: false, code: 'cart_empty' };
  const seen = new Set<string>();
  const changes: LineChange[] = [];
  for (const line of existing) {
    const id = line.variantId?.toLowerCase();
    if (!id || seen.has(id)) return { ok: false, code: 'not_editable' };
    seen.add(id);
    const after = wanted.get(id) ?? 0;
    if (after < line.shipped) return { ok: false, code: 'below_shipped', variantId: id };
    if (after !== line.quantity) changes.push({ variantId: id, itemId: line.id, before: line.quantity, after, delta: after - line.quantity });
  }
  for (const [id, qty] of wanted) if (!seen.has(id)) changes.push({ variantId: id, itemId: null, before: 0, after: qty, delta: qty });
  if (!changes.length) return { ok: false, code: 'no_change' };
  return { ok: true, changes, lines: [...wanted].map(([variantId, qty]) => ({ variantId, qty })) };
}

export type PaymentAction = 'none' | 'collect' | 'refund';

export interface PaymentDifference {
  action: PaymentAction;
  /** What to collect or refund; 0 for 'none'. */
  differenceMinor: number;
}

/**
 * What an edit does to the money. `paidNetMinor` = what the customer has paid
 * and still has with the store (credited − refunded − refunds in flight).
 * Nothing paid yet (an unpaid online or cash-on-delivery order): the total
 * simply changes. Otherwise the customer pays the rest (collect) or gets the
 * surplus back (refund); nothing is ever absorbed silently.
 */
export function paymentDifference(input: { paidNetMinor: number; totalAfterMinor: number }): PaymentDifference {
  const { paidNetMinor, totalAfterMinor } = input;
  if (!Number.isSafeInteger(paidNetMinor) || !Number.isSafeInteger(totalAfterMinor) || paidNetMinor <= 0 || totalAfterMinor === paidNetMinor)
    return { action: 'none', differenceMinor: 0 };
  return totalAfterMinor > paidNetMinor
    ? { action: 'collect', differenceMinor: totalAfterMinor - paidNetMinor }
    : { action: 'refund', differenceMinor: paidNetMinor - totalAfterMinor };
}

export interface RefundablePayment {
  id: string;
  /** What this payment can still refund. */
  refundableMinor: number;
  /** Razorpay holds the money (a gateway refund); false = cash or a payment recorded by staff. */
  gateway: boolean;
}

export type RefundAllocation =
  | { ok: true; parts: Array<{ paymentId: string; amountMinor: number; gateway: boolean }> }
  | { ok: false; code: 'amount_exceeds' };

/** Spread a refund over the order's payments in the order given, each up to what it can still refund. */
export function allocateRefund(payments: readonly RefundablePayment[], amountMinor: number): RefundAllocation {
  let left = amountMinor;
  const parts: Array<{ paymentId: string; amountMinor: number; gateway: boolean }> = [];
  for (const p of payments) {
    if (left <= 0) break;
    const take = Math.min(left, Math.max(0, p.refundableMinor));
    if (take > 0) parts.push({ paymentId: p.id, amountMinor: take, gateway: p.gateway });
    left -= take;
  }
  return left > 0 ? { ok: false, code: 'amount_exceeds' } : { ok: true, parts };
}

// ---------------------------------------------------------------------------
// Split shipments

/** An order line and how many of its units other live shipments already carry. */
export interface ShippableLine {
  id: string;
  quantity: number;
  shipped: number;
}

export interface ShipmentItemInput {
  orderItemId: string;
  quantity: number;
}

export type ShipmentItemsRefusal = 'invalid' | 'nothing_to_ship' | 'over_shipped';

export type ShipmentItemsPlan =
  | { ok: true; items: ShipmentItemInput[]; /** Every unit of the order is in a live shipment once this one exists. */ complete: boolean }
  | { ok: false; code: ShipmentItemsRefusal; orderItemId?: string };

/**
 * The lines and quantities a new shipment carries. With no `requested` items
 * it takes everything not yet in a live shipment (the single-shipment path).
 * A requested quantity above what remains of its line is refused: the shipped
 * quantity of a line never exceeds the ordered quantity.
 */
export function planShipmentItems(lines: readonly ShippableLine[], requested?: readonly ShipmentItemInput[] | null): ShipmentItemsPlan {
  const remaining = new Map(lines.map((l) => [l.id, Math.max(0, l.quantity - l.shipped)]));
  let items: ShipmentItemInput[];
  if (requested === undefined || requested === null) {
    items = [...remaining].filter(([, left]) => left > 0).map(([orderItemId, quantity]) => ({ orderItemId, quantity }));
  } else {
    if (!Array.isArray(requested) || requested.length > 100) return { ok: false, code: 'invalid' };
    const seen = new Set<string>();
    items = [];
    for (const item of requested) {
      if (!item || typeof item.orderItemId !== 'string' || !Number.isInteger(item.quantity) || item.quantity < 1)
        return { ok: false, code: 'invalid' };
      const id = item.orderItemId.toLowerCase();
      const left = remaining.get(id);
      if (left === undefined || seen.has(id)) return { ok: false, code: 'invalid', orderItemId: id };
      if (item.quantity > left) return { ok: false, code: 'over_shipped', orderItemId: id };
      seen.add(id);
      items.push({ orderItemId: id, quantity: item.quantity });
    }
  }
  if (!items.length) return { ok: false, code: 'nothing_to_ship' };
  const taken = new Map(items.map((i) => [i.orderItemId, i.quantity]));
  const complete = [...remaining].every(([id, left]) => left - (taken.get(id) ?? 0) === 0);
  return { ok: true, items, complete };
}

/** One live shipment of an order, as the order status reads it. `items` null = a shipment made before split shipments: the whole order. */
export interface ShipmentProgress {
  dispatched: boolean;
  delivered: boolean;
  items: ReadonlyArray<{ orderItemId: string; quantity: number }> | null;
}

/**
 * Where the order stands from its live shipments: 'delivered' when every unit
 * is in a delivered shipment, 'dispatched' when every unit has left,
 * 'partial' when some have, 'none' when none has.
 */
export function shipmentCoverage(lines: ReadonlyArray<{ id: string; quantity: number }>,
  shipments: readonly ShipmentProgress[]): 'none' | 'partial' | 'dispatched' | 'delivered' {
  const left = shipments.filter((s) => s.dispatched || s.delivered);
  if (!left.length) return 'none';
  const covered = (set: readonly ShipmentProgress[]): boolean => {
    if (set.some((s) => s.items === null)) return true;
    const sum = new Map<string, number>();
    for (const s of set) for (const i of s.items ?? []) sum.set(i.orderItemId, (sum.get(i.orderItemId) ?? 0) + i.quantity);
    return lines.every((l) => (sum.get(l.id) ?? 0) >= l.quantity);
  };
  if (covered(shipments.filter((s) => s.delivered))) return 'delivered';
  return covered(left) ? 'dispatched' : 'partial';
}
