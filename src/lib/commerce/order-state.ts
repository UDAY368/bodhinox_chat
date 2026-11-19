/**
 * The order's state rules, in one place for the server and the screens: which
 * status may follow which, the order's payment and fulfilment state, its one
 * next step, the actions its state allows, and the tones and label
 * namespaces the screens show. Pure and client-safe (no database, no server
 * imports). The server runs the same functions under the order lock, with the
 * row it locked; the screens only use them to decide what to offer.
 */
import type { OrderStatus, RefundState } from './order-format';

// ---------------------------------------------------------------------------
// Status transitions

/**
 * Statuses only the worker sets, after a verified payment, a reservation
 * expiry or a payment exception (the orders_status_guard trigger refuses them
 * for a browser session). Staff never mark an order paid by hand: a payment
 * taken outside a link is recorded through "Record offline payment".
 */
export const WORKER_ONLY_STATUSES: readonly OrderStatus[] = ['paid', 'payment_review', 'expired', 'partially_shipped'];

/**
 * Status changes staff may make. `fulfilled` is shown as "Delivered" (the
 * evidence badge says who confirmed it). paid -> cancelled goes through "Cancel and refund" only.
 * Final for staff: fulfilled, cancelled, expired, payment_review (resolved
 * through the payment exceptions queue).
 */
export const ORDER_TRANSITIONS: Record<OrderStatus, readonly OrderStatus[]> = {
  new: ['confirmed', 'awaiting_payment', 'cancelled'],
  confirmed: ['awaiting_payment', 'dispatched', 'fulfilled', 'cancelled'],
  awaiting_payment: ['cancelled'],
  payment_review: [],
  paid: ['dispatched', 'cancelled'],
  // Some parcels left (set from the courier shipments, never by hand): staff may record that the rest left too.
  partially_shipped: ['dispatched'],
  dispatched: ['fulfilled', 'cancelled'],
  fulfilled: [],
  expired: [],
  cancelled: [],
};

/** Moves allowed only for legacy unpriced orders (a priced order is paid before it is fulfilled). */
const UNPRICED_ONLY: ReadonlySet<string> = new Set(['new>awaiting_payment', 'confirmed>awaiting_payment']);
/**
 * Moves allowed only for an unpaid cash-on-delivery order: it ships before the cash arrives, and a
 * parcel the customer refuses (return to origin) is cancelled from dispatched, releasing its stock.
 */
const UNPAID_COD_ONLY: ReadonlySet<string> = new Set(['confirmed>dispatched', 'dispatched>cancelled']);

/** `priced` = the order has server-priced snapshots (priced_at set); `unpaidCod` = see isUnpaidCodOrder. */
export interface TransitionOpts { priced?: boolean; unpaidCod?: boolean }

/** May staff move an order from `from` to `to`? */
export function canTransition(from: OrderStatus, to: OrderStatus, opts: TransitionOpts = {}): boolean {
  if (!ORDER_TRANSITIONS[from].includes(to)) return false;
  const move = `${from}>${to}`;
  if (opts.priced && UNPRICED_ONLY.has(move)) return false;
  if (UNPAID_COD_ONLY.has(move)) return !!opts.unpaidCod;
  // A priced order is paid before it is delivered, except an unpaid COD order (cash on delivery).
  if (move === 'confirmed>fulfilled') return !opts.priced || !!opts.unpaidCod;
  return true;
}

/** Statuses staff could move an order to next. */
export function nextStatuses(from: OrderStatus, opts: TransitionOpts = {}): OrderStatus[] {
  return ORDER_TRANSITIONS[from].filter((to) => canTransition(from, to, opts));
}

/**
 * May staff set this status by hand (the plain status change)? A paid order is cancelled only
 * with "Cancel and refund" (canCancelAndRefund), never by a status change.
 */
export function canChangeStatusByHand(from: OrderStatus, to: OrderStatus, opts: TransitionOpts = {}): boolean {
  return canTransition(from, to, opts) && !(from === 'paid' && to === 'cancelled');
}

// ---------------------------------------------------------------------------
// The order's facts

type When = string | Date | null | undefined;

/** The fields the rules read. The list row has fewer: missing ones count as unknown / not set. */
export interface OrderFacts {
  status: OrderStatus;
  priced_at?: When;
  payment_method?: string | null;
  paid_at?: When;
  refund_state?: RefundState | null;
  amount_paid_minor?: number;
  total_minor?: number | null;
  subtotal_minor?: number;
  conversation_id?: string | null;
  /** The courier shipment, when the order has one. */
  shipment?: { create_state: string } | null;
}

/** True for a cash-on-delivery order whose cash has not been recorded. */
export const isUnpaidCod = (order: { payment_method?: string | null; paid_at?: When }): boolean =>
  order.payment_method === 'cod' && !order.paid_at;

/** A priced cash-on-delivery order whose cash is not recorded yet: it may ship before it is paid. */
export const isUnpaidCodOrder = (o: Pick<OrderFacts, 'priced_at' | 'payment_method' | 'paid_at'>): boolean =>
  isUnpaidCod(o) && !!o.priced_at;

export const transitionOpts = (o: Pick<OrderFacts, 'priced_at' | 'payment_method' | 'paid_at'>): TransitionOpts =>
  ({ priced: !!o.priced_at, unpaidCod: isUnpaidCodOrder(o) });

/** What the order still owes: total (or subtotal for a legacy cart) less what was paid. */
export const amountDue = (o: Pick<OrderFacts, 'total_minor' | 'subtotal_minor' | 'amount_paid_minor'>): number =>
  (o.total_minor ?? o.subtotal_minor ?? 0) - (o.amount_paid_minor ?? 0);

/** What a refund could still give back. */
export const amountRefundable = (o: { amount_paid_minor?: number; amount_refunded_minor?: number }): number =>
  Math.max(0, (o.amount_paid_minor ?? 0) - (o.amount_refunded_minor ?? 0));

/** Refunded in full before it left: the goods must not ship (the refund may also have restocked them). */
export const refundedBeforeShipping = (o: Pick<OrderFacts, 'status' | 'refund_state'>): boolean =>
  o.refund_state === 'full' && o.status !== 'dispatched' && o.status !== 'fulfilled';

/**
 * Ready to leave with a courier: a paid order, or an unpaid cash-on-delivery order still confirmed;
 * so is either of them once some of its parcels left (partially shipped).
 */
export const isReadyToShip = (o: { status: OrderStatus; unpaidCod: boolean }): boolean =>
  o.status === 'paid' || o.status === 'partially_shipped' || (o.status === 'confirmed' && o.unpaidCod);

/** A courier shipment that is not failed or cancelled (it may still collect the parcel, or cash at the door). */
const shipmentLive = (o: Pick<OrderFacts, 'shipment'>): boolean =>
  !!o.shipment && o.shipment.create_state !== 'failed' && o.shipment.create_state !== 'cancelled';

/** Orders a return can be opened for: the goods have left the store. */
export const RETURNABLE_STATUSES: ReadonlySet<string> = new Set(['dispatched', 'fulfilled']);
export const canStartReturn = (status: OrderStatus): boolean => RETURNABLE_STATUSES.has(status);

/** Only a paid order that has not left is cancelled with "Cancel and refund". */
export const canCancelAndRefund = (status: OrderStatus): boolean => status === 'paid';

// ---------------------------------------------------------------------------
// Payment actions

const TAKES_PAYMENT: readonly OrderStatus[] = ['new', 'confirmed', 'awaiting_payment'];

/** May the customer still pay online (a payment link)? */
export function canTakeLinkPayment(o: Pick<OrderFacts, 'status' | 'paid_at' | 'payment_method'>): boolean {
  return TAKES_PAYMENT.includes(o.status) && !o.paid_at && o.payment_method !== 'cod';
}

/**
 * May staff record a payment taken outside the gateway (cash, UPI, ...)? Only for a priced order that
 * still owes money: one still taking payment, or an unpaid cash-on-delivery order already shipped or
 * delivered. While a COD courier shipment of an order that has not left is live, the courier collects
 * the cash at the door (the server refuses too).
 */
export function canRecordPayment(o: OrderFacts): boolean {
  if (!o.priced_at || amountDue(o) <= 0) return false;
  const unpaidCod = isUnpaidCodOrder(o);
  if (unpaidCod && (o.status === 'confirmed' || o.status === 'partially_shipped') && shipmentLive(o)) return false;
  if (TAKES_PAYMENT.includes(o.status)) return true;
  return unpaidCod && (o.status === 'dispatched' || o.status === 'fulfilled');
}

/** Waiting for the customer's money (an online order not paid yet): the next step is collecting it. */
export function isWaitingForPayment(o: OrderFacts): boolean {
  return !!o.priced_at && TAKES_PAYMENT.includes(o.status) && !o.paid_at && o.payment_method !== 'cod' && amountDue(o) > 0;
}

/**
 * May the order still be cancelled with a plain cancel (nothing paid)? An order still taking payment,
 * or an unpaid cash-on-delivery parcel that came back (dispatched, return to origin).
 */
export function canCancelUnpaid(o: OrderFacts): boolean {
  return canChangeStatusByHand(o.status, 'cancelled', transitionOpts(o)) && !o.paid_at && !(o.amount_paid_minor ?? 0);
}

// ---------------------------------------------------------------------------
// Next step and allowed actions

/** The one step the order waits for. */
export type NextStep = 'confirm' | 'collect_payment' | 'ship' | 'deliver';

export function nextStep(o: OrderFacts): NextStep | null {
  if (refundedBeforeShipping(o)) return null;
  const opts = transitionOpts(o);
  if (canTransition(o.status, 'dispatched', opts)) return 'ship';
  if ((o.status === 'dispatched' || o.status === 'confirmed') && canTransition(o.status, 'fulfilled', opts)) return 'deliver';
  if (o.status === 'new' && canTransition(o.status, 'confirmed', opts)) return 'confirm';
  if (isWaitingForPayment(o)) return 'collect_payment';
  return null;
}

/** May staff record the dispatch / the delivery by hand? */
export const canShip = (o: OrderFacts): boolean => !refundedBeforeShipping(o) && canTransition(o.status, 'dispatched', transitionOpts(o));
export const canDeliver = (o: OrderFacts): boolean => !refundedBeforeShipping(o) && canTransition(o.status, 'fulfilled', transitionOpts(o));

/**
 * Statuses staff may pick in a plain status change: dispatch and delivery have their own actions,
 * cancelling has its own (cancel, or cancel and refund), and a paid order is never cancelled here.
 */
export function selectableStatuses(o: OrderFacts): OrderStatus[] {
  const opts = transitionOpts(o);
  return nextStatuses(o.status, opts)
    .filter((s) => s !== 'dispatched' && s !== 'fulfilled' && s !== 'cancelled' && canChangeStatusByHand(o.status, s, opts));
}

export type OrderAction =
  | 'confirm' | 'send_payment_link' | 'record_payment' | 'ship' | 'deliver' | 'send_update'
  | 'cancel' | 'cancel_and_refund' | 'change_status';

/** Actions that need an admin (commerce.record_payments / commerce.refunds); the rest need an agent. */
export const ADMIN_ACTIONS: ReadonlySet<OrderAction> = new Set(['record_payment', 'cancel_and_refund']);

/**
 * What the order's state allows, for a member who may act (agent) and may administer (admin).
 * The server checks the role, the permission and the state again.
 */
export function allowedActions(o: OrderFacts, who: { canAct: boolean; canAdmin: boolean }): OrderAction[] {
  if (!who.canAct) return [];
  const all: Array<[OrderAction, boolean]> = [
    ['confirm', o.status === 'new' && canChangeStatusByHand('new', 'confirmed', transitionOpts(o))],
    ['send_payment_link', canTakeLinkPayment(o) && !!o.priced_at],
    ['record_payment', canRecordPayment(o)],
    ['ship', canShip(o)],
    ['deliver', canDeliver(o)],
    ['send_update', !!o.conversation_id],
    ['change_status', selectableStatuses(o).some((s) => s !== 'confirmed')],
    ['cancel', canCancelUnpaid(o)],
    ['cancel_and_refund', canCancelAndRefund(o.status)],
  ];
  return all.filter(([action, ok]) => ok && (who.canAdmin || !ADMIN_ACTIONS.has(action))).map(([action]) => action);
}

/** The action that carries out a next step, given what the member may do (null: nothing they can press). */
export function nextStepAction(step: NextStep | null, allowed: readonly OrderAction[]): OrderAction | null {
  if (!step) return null;
  if (step === 'collect_payment') {
    if (allowed.includes('send_payment_link')) return 'send_payment_link';
    return allowed.includes('record_payment') ? 'record_payment' : null;
  }
  return allowed.includes(step) ? step : null;
}

// ---------------------------------------------------------------------------
// Display states, tones and labels

export type Tone = 'ok' | 'warn' | 'bad' | 'accent' | 'neutral';
export type PaymentState = 'paid' | 'pending' | 'refunded' | 'partlyRefunded' | 'cod';
export type FulfilmentState = 'new' | 'confirmed' | 'partlyShipped' | 'shipped' | 'delivered' | 'cancelled' | 'expired' | 'review';

export function paymentState(o: Pick<OrderFacts, 'status' | 'paid_at' | 'refund_state' | 'payment_method'>): PaymentState {
  if (o.refund_state === 'full') return 'refunded';
  if (o.refund_state === 'partial') return 'partlyRefunded';
  if (o.paid_at || o.status === 'paid') return 'paid';
  if (o.payment_method === 'cod' && o.status !== 'cancelled' && o.status !== 'expired') return 'cod';
  return 'pending';
}

export function fulfilmentState(status: OrderStatus): FulfilmentState {
  switch (status) {
    case 'partially_shipped': return 'partlyShipped';
    case 'dispatched': return 'shipped';
    case 'fulfilled': return 'delivered';
    case 'cancelled': return 'cancelled';
    case 'expired': return 'expired';
    case 'payment_review': return 'review';
    case 'confirmed': return 'confirmed';
    default: return 'new';
  }
}

export const STATUS_TONE: Record<OrderStatus, Tone> = {
  new: 'accent', confirmed: 'accent', awaiting_payment: 'warn', payment_review: 'bad', paid: 'ok', partially_shipped: 'accent',
  dispatched: 'accent', fulfilled: 'ok', expired: 'neutral', cancelled: 'neutral',
};
export const PAYMENT_TONE: Record<PaymentState, Tone> = { paid: 'ok', pending: 'warn', refunded: 'bad', partlyRefunded: 'warn', cod: 'accent' };
export const FULFILMENT_TONE: Record<FulfilmentState, Tone> = {
  new: 'neutral', confirmed: 'neutral', partlyShipped: 'accent', shipped: 'accent', delivered: 'ok', cancelled: 'bad', expired: 'neutral', review: 'warn',
};
/** The badge tone of a COD order's confirmation answer. */
export const COD_CONFIRM_TONE: Record<'pending' | 'confirmed' | 'declined', Tone> = { pending: 'warn', confirmed: 'ok', declined: 'bad' };

/** The message namespaces whose keys are the state names above (status, payment state, fulfilment state). */
export const STATE_LABELS = {
  status: 'Commerce.orders.statuses',
  payment: 'Sales.orders.pay',
  fulfilment: 'Sales.orders.ful',
} as const;
