/**
 * Pure rules for stock transfers and purchase orders (store plan Phase 8).
 * No database and no imports: stock-locations.ts and purchase-orders.ts apply
 * them inside their transactions, and the screens use the same functions.
 */

/** A client-made key that makes a retried transfer or receive request a no-op. */
export const REQUEST_KEY = /^[A-Za-z0-9_-]{8,64}$/;
export const MAX_STOCK_UNITS = 1_000_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface TransferRequest {
  clientKey: unknown;
  fromLocationId: unknown;
  toLocationId: unknown;
  variantId: unknown;
  quantity: unknown;
}

/** The field that makes a transfer request malformed, or null when it is well formed. */
export function transferProblem(t: TransferRequest): 'client_key' | 'from_location_id' | 'to_location_id' | 'variant_id' | 'quantity' | null {
  if (typeof t.clientKey !== 'string' || !REQUEST_KEY.test(t.clientKey)) return 'client_key';
  if (typeof t.fromLocationId !== 'string' || !UUID.test(t.fromLocationId)) return 'from_location_id';
  if (typeof t.toLocationId !== 'string' || !UUID.test(t.toLocationId)
    || t.toLocationId.toLowerCase() === t.fromLocationId.toLowerCase()) return 'to_location_id';
  if (typeof t.variantId !== 'string' || !UUID.test(t.variantId)) return 'variant_id';
  if (typeof t.quantity !== 'number' || !Number.isInteger(t.quantity) || t.quantity < 1 || t.quantity > MAX_STOCK_UNITS) return 'quantity';
  return null;
}

/**
 * What each location holds of one variant. The default location has no row of its own: it holds
 * whatever of the sellable total (on hand) is not counted at another location.
 */
export function defaultLocationQuantity(onHand: number, elsewhere: readonly number[]): number {
  return onHand - elsewhere.reduce((sum, q) => sum + q, 0);
}

// ---------------------------------------------------------------------------
// Purchase orders

export const PO_STATUSES = ['draft', 'ordered', 'partially_received', 'received', 'closed', 'cancelled'] as const;
export type PoStatus = (typeof PO_STATUSES)[number];
export const PO_ACTIONS = ['order', 'cancel', 'close'] as const;
export type PoAction = (typeof PO_ACTIONS)[number];
export const isPoAction = (value: unknown): value is PoAction => (PO_ACTIONS as readonly unknown[]).includes(value);

/**
 * The status a staff action leads to, or null when it is not allowed:
 * order: draft -> ordered; cancel: draft or ordered -> cancelled (nothing was received yet);
 * close: partially received or received -> closed (what is still missing will not arrive).
 * Receiving moves ordered -> partially_received -> received (poStatusAfterReceipt).
 */
export function poTransition(status: PoStatus, action: PoAction): PoStatus | null {
  if (action === 'order') return status === 'draft' ? 'ordered' : null;
  if (action === 'cancel') return status === 'draft' || status === 'ordered' ? 'cancelled' : null;
  return status === 'partially_received' || status === 'received' ? 'closed' : null;
}

/** Lines can change only while the order is a draft. */
export const poEditable = (status: PoStatus): boolean => status === 'draft';
/** Stock can be received only on an order that was placed and is not complete, closed or cancelled. */
export const poReceivable = (status: PoStatus): boolean => status === 'ordered' || status === 'partially_received';

export interface PoLineCount { id: string; qtyOrdered: number; qtyReceived: number }
export interface PoReceiveLine { lineId: string; quantity: number }

export function poStatusAfterReceipt(lines: readonly Pick<PoLineCount, 'qtyOrdered' | 'qtyReceived'>[]): 'partially_received' | 'received' {
  return lines.length > 0 && lines.every((l) => l.qtyReceived >= l.qtyOrdered) ? 'received' : 'partially_received';
}

/**
 * Why a receive request is refused, or null: the order must be receivable (po_state), every line must
 * belong to it once with a whole quantity of at least 1 (invalid), and no line may pass what was ordered
 * (over_receive).
 */
export function receiptProblem(status: PoStatus, lines: readonly PoLineCount[], receive: readonly PoReceiveLine[]): 'po_state' | 'invalid' | 'over_receive' | null {
  if (!poReceivable(status)) return 'po_state';
  if (!receive.length || receive.length > lines.length) return 'invalid';
  const byId = new Map(lines.map((l) => [l.id, l]));
  const seen = new Set<string>();
  for (const r of receive) {
    const line = byId.get(r.lineId);
    if (!line || seen.has(r.lineId) || !Number.isInteger(r.quantity) || r.quantity < 1 || r.quantity > MAX_STOCK_UNITS) return 'invalid';
    seen.add(r.lineId);
    if (line.qtyReceived + r.quantity > line.qtyOrdered) return 'over_receive';
  }
  return null;
}
