/**
 * The pure rules of a buyer's return or exchange request (store plan Phase 8, batch 5). The buyer asks from the order page; staff
 * approve or reject it in the returns flow (returns.ts), where nothing is refunded or restocked until staff act. Eligibility,
 * the one-open-request-per-line rule and the request shape live here with no database; buyer-returns.ts runs them under the order lock.
 */
import { StoreError } from './store-settings';

const DAY_MS = 86_400_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Orders a return can be opened for: the goods have left the store. */
export const RETURNABLE_STATUSES: ReadonlySet<string> = new Set(['dispatched', 'fulfilled']);
/** Return statuses that still hold a line: nothing is decided or finished yet. */
export const OPEN_RETURN_STATUSES: ReadonlySet<string> = new Set(['requested', 'received', 'inspected']);

export const RETURN_REASONS = ['wrong_item', 'damaged', 'not_as_described', 'size_fit', 'changed_mind', 'other'] as const;
export type ReturnReason = (typeof RETURN_REASONS)[number];
export const isReturnReason = (value: unknown): value is ReturnReason => (RETURN_REASONS as readonly unknown[]).includes(value);

export const BUYER_RETURN_NOTE_MAX = 300;

/**
 * Whether a return may still be opened: the window runs from delivery, so an order not delivered yet (in transit, or coming
 * back to the store) is always open; 0 days means no returns once delivered.
 */
export function returnWindowOpen(deliveredAt: Date | null, windowDays: number, now: Date = new Date()): boolean {
  if (!deliveredAt) return true;
  if (!Number.isInteger(windowDays) || windowDays <= 0) return false;
  return now.getTime() <= deliveredAt.getTime() + windowDays * DAY_MS;
}

export interface EligibilityFacts {
  /** shop_buyer_settings.buyer_returns_enabled */
  enabled: boolean;
  status: string;
  /** A cash-on-delivery order whose cash is not recorded: its parcel coming back is a cancel, not a return. */
  unpaidCod: boolean;
  /** When the order was delivered (null while it is in transit). */
  deliveredAt: Date | null;
  windowDays: number;
  now?: Date;
}

/** Why the buyer cannot open a request now (a StoreError code), or null. */
export function buyerReturnEligibility(f: EligibilityFacts): 'returns_unavailable' | 'return_window_closed' | null {
  if (!f.enabled || !RETURNABLE_STATUSES.has(f.status) || f.unpaidCod) return 'returns_unavailable';
  return returnWindowOpen(f.deliveredAt, f.windowDays, f.now) ? null : 'return_window_closed';
}

export interface LineStanding { ordered: number; /** units not covered by another non-rejected return */ remaining: number; /** an open request holds the line */ open: boolean }

/** Per order line: what can still be returned and whether a request is open on it. `returns` are the order's returns (any source). */
export function lineStandings(
  ordered: ReadonlyArray<{ id: string; quantity: number }>,
  returns: ReadonlyArray<{ status: string; items: ReadonlyArray<{ order_item_id: string; qty: number }> }>,
): Map<string, LineStanding> {
  const out = new Map<string, LineStanding>(ordered.map((i) => [i.id, { ordered: i.quantity, remaining: i.quantity, open: false }]));
  for (const r of returns) {
    if (r.status === 'rejected') continue;
    for (const item of r.items) {
      const line = out.get(item.order_item_id);
      if (!line) continue;
      line.remaining = Math.max(0, line.remaining - item.qty);
      if (OPEN_RETURN_STATUSES.has(r.status)) line.open = true;
    }
  }
  return out;
}

export interface BuyerReturnLine { order_item_id: string; qty: number; exchange_variant_id: string | null }
export interface BuyerReturnInput { clientRequestId: string; reason: ReturnReason; note: string | null; lines: BuyerReturnLine[] }

const bad = (field: string): never => { throw new StoreError('invalid', { field }); };

/** Validate the page's body: { clientRequestId, reason, note?, lines: [{ order_item_id, qty, exchange_variant_id? }] }. */
export function parseBuyerReturn(body: Record<string, unknown>): BuyerReturnInput {
  if (typeof body.clientRequestId !== 'string' || !UUID.test(body.clientRequestId)) return bad('clientRequestId');
  if (!isReturnReason(body.reason)) return bad('reason');
  let note: string | null = null;
  if (body.note !== undefined && body.note !== null) {
    if (typeof body.note !== 'string') return bad('note');
    note = body.note.replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
    if (note.length > BUYER_RETURN_NOTE_MAX) return bad('note');
    note = note || null;
  }
  if (!Array.isArray(body.lines) || body.lines.length === 0 || body.lines.length > 50) return bad('lines');
  const seen = new Set<string>();
  const lines = body.lines.map((raw): BuyerReturnLine => {
    const l = raw as Record<string, unknown> | null;
    if (!l || typeof l !== 'object' || Array.isArray(l)) return bad('lines');
    if (typeof l.order_item_id !== 'string' || !UUID.test(l.order_item_id) || seen.has(l.order_item_id.toLowerCase())) return bad('lines');
    if (typeof l.qty !== 'number' || !Number.isInteger(l.qty) || l.qty < 1 || l.qty > 100_000) return bad('lines');
    const exchange = l.exchange_variant_id;
    if (exchange !== undefined && exchange !== null && (typeof exchange !== 'string' || !UUID.test(exchange))) return bad('lines');
    seen.add(l.order_item_id.toLowerCase());
    return { order_item_id: l.order_item_id.toLowerCase(), qty: l.qty, exchange_variant_id: typeof exchange === 'string' ? exchange.toLowerCase() : null };
  });
  return { clientRequestId: body.clientRequestId.toLowerCase(), reason: body.reason, note, lines };
}

/** The exchange map stored on the return: { order_item_id: wanted variant id } for the lines that ask for a replacement; null for none. */
export function exchangeMap(lines: ReadonlyArray<BuyerReturnLine>): Record<string, string> | null {
  const entries = lines.flatMap((l) => (l.exchange_variant_id ? [[l.order_item_id, l.exchange_variant_id] as const] : []));
  return entries.length ? Object.fromEntries(entries) : null;
}
