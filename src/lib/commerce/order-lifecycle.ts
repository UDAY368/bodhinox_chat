/**
 * Staff order lifecycle (design §2, §3, T5). updateOrder (orders.ts) delegates
 * every status change here.
 *
 * Every change runs in one worker transaction as the signed-in member
 * (withTenant on the worker connection with the member's user id, so the
 * status history trigger records `staff` and the fulfilment stamp records who
 * did it). The service itself checks the role, the permission and
 * ORDER_TRANSITIONS, locks the order row and makes the change conditional on
 * the status the caller saw (409 conflict otherwise).
 *
 * - Cancelling an order awaiting payment releases its stock and coupon and
 *   queues the cancel of its open payment link, in the same transaction.
 * - A paid order is cancelled only through cancelAndRefund (commerce.refunds):
 *   every payment is checked first, gateway refunds are requested (row-first,
 *   lib/payments/refunds), then offline money confirmed as returned outside
 *   is recorded and the order cancelled; a gateway refund restocks when it is
 *   processed, and dispatch waits while it is in flight.
 * - paid, payment_review and expired are never set here (worker only).
 * - Dispatch and delivery are staff-recorded, or (Phase 9) system-recorded
 *   from Shiprocket tracking read back with the workspace's own credentials
 *   (systemDispatch / systemDeliver, called by lib/fulfilment/tracking-job).
 *   Either way they queue the customer notices, the feedback request, the
 *   product follow-up and the reorder reminder, each at most once per order
 *   (dedupe ofu:<orderId>:<kind>).
 * - A paid order with a live courier shipment is not cancelled (409
 *   shipment_live): the shipment is cancelled first, or Returns used after pickup.
 *
 * Logs and audit metadata carry ids and codes only.
 */
import { requirePermission } from '@/lib/auth/permissions';
import { ForbiddenError } from '@/lib/auth/errors';
import { hasMinRole } from '@/lib/auth/roles';
import { getWorkerPrisma } from '@/lib/db/prisma';
import { withTenant, type TenantContext, type TenantTransaction } from '@/lib/db/tenant';
import { orderEventTx } from '@/lib/payments/ledger';
import { applyRefundStateTx, RefundError, requestRefund } from '@/lib/payments/refunds';
import { getOrderShipment } from '@/lib/fulfilment/shipments';
import { ShipmentError, type OrderShipmentView } from '@/lib/fulfilment/types';
import { minorFromDb } from './money';
import { canTransition, fulfilmentEvidence, type FulfilmentEvidence, type OrderStatus } from './order-format';
import { repeatPurchaseDueAt, type OrderFollowupKind } from './order-followup';
import { OrderError } from './orders';
import { releaseTx } from './stock';

export type StaffContext = TenantContext & { userId: string };

export interface TransitionInput {
  /** The status the caller read; the change is conditional on it (409 conflict otherwise). */
  from: OrderStatus;
  to: OrderStatus;
}

/** The feedback request goes out a day after delivery. */
export const FEEDBACK_DELAY_MS = 24 * 3_600_000;
export const TRACKING_NOTE_MAX = 200;

interface LockedOrder {
  id: string;
  status: OrderStatus;
  priced: boolean;
  /** A cash-on-delivery order whose cash is not recorded yet: it may ship, and still holds its stock and coupon. */
  unpaidCod: boolean;
}

function assertStaff(ctx: StaffContext): void {
  if (!ctx.role || !hasMinRole(ctx.role, 'agent')) throw new ForbiddenError('Insufficient workspace role');
}

/** The member's own transaction on the worker connection (app.user_id = the member). */
export function asStaff<T>(ctx: StaffContext, fn: (tx: TenantTransaction) => Promise<T>): Promise<T> {
  return withTenant({ accountId: ctx.accountId, userId: ctx.userId, role: ctx.role }, fn, getWorkerPrisma());
}

export async function lockOrder(tx: TenantTransaction, accountId: string, orderId: string): Promise<LockedOrder> {
  const [row] = await tx.$queryRaw<LockedOrder[]>`
    SELECT id::text AS id, status, priced_at IS NOT NULL AS priced,
      (payment_method='cod' AND paid_at IS NULL AND priced_at IS NOT NULL) AS "unpaidCod" FROM orders
    WHERE account_id=${accountId}::uuid AND id=${orderId}::uuid FOR UPDATE`;
  if (!row) throw new OrderError(404, 'not_found', 'Order not found');
  return row;
}

export async function auditOrder(tx: TenantTransaction, ctx: StaffContext, action: string, resourceId: string, metadata: object = {}) {
  await tx.$executeRaw`INSERT INTO audit_logs(account_id,user_id,action,resource_id,metadata)
    VALUES(${ctx.accountId}::uuid,${ctx.userId}::uuid,${action},${resourceId},${JSON.stringify(metadata)}::jsonb)`;
}

export async function enqueueJob(
  tx: TenantTransaction, accountId: string, type: string, payload: object, dedupeKey: string, runAt: Date = new Date(),
): Promise<void> {
  await tx.$executeRaw`INSERT INTO jobs(type,tenant_id,payload,dedupe_key,run_at)
    VALUES(${type},${accountId}::uuid,${JSON.stringify(payload)}::jsonb,${dedupeKey},${runAt})
    ON CONFLICT(dedupe_key) DO NOTHING`;
}

type NoticeKind = OrderFollowupKind;

function queueNotice(tx: TenantTransaction, accountId: string, orderId: string, kind: NoticeKind, runAt?: Date) {
  return enqueueJob(tx, accountId, 'commerce.order_followup', { orderId, kind }, `ofu:${orderId}:${kind}`, runAt);
}

async function setStatus(tx: TenantTransaction, accountId: string, order: LockedOrder, to: OrderStatus, trackingNote?: string | null) {
  const count = trackingNote === undefined
    ? await tx.$executeRaw`UPDATE orders SET status=${to}, updated_at=now()
        WHERE account_id=${accountId}::uuid AND id=${order.id}::uuid AND status=${order.status}`
    : await tx.$executeRaw`UPDATE orders SET status=${to}, tracking_note=${trackingNote}, updated_at=now()
        WHERE account_id=${accountId}::uuid AND id=${order.id}::uuid AND status=${order.status}`;
  if (count !== 1) throw new OrderError(409, 'conflict', 'The order changed; reload and try again');
}

/**
 * Close what an order still holds before it is cancelled: its reserved stock
 * and coupon (a priced order awaiting payment, or an unpaid cash-on-delivery
 * order, also when its parcel comes back from dispatched) and any open payment
 * link (the cancel job re-reads the link first and never cancels one already
 * paid; a payment that still arrives is recorded as payment_on_closed_order).
 */
async function closeOrderTx(tx: TenantTransaction, accountId: string, order: LockedOrder): Promise<void> {
  // A priced order not yet paid holds its stock: awaiting payment (checkout), or a staff-made manual order
  // (confirmed, held with no expiry until paid). releaseTx is a no-op when nothing is held.
  if ((order.priced && ['awaiting_payment', 'new', 'confirmed'].includes(order.status)) || order.unpaidCod) {
    await releaseTx(tx, accountId, order.id, 'cancelled');
    await tx.$executeRaw`UPDATE coupon_redemptions SET status='released'
      WHERE account_id=${accountId}::uuid AND order_id=${order.id}::uuid AND status='reserved'`;
  }
  await tx.$executeRaw`INSERT INTO jobs(type, tenant_id, payload, dedupe_key)
    SELECT 'payments.cancel_link', l.account_id, jsonb_build_object('linkId', l.id::text), 'payment-link-cancel:' || l.id::text
    FROM payment_links l WHERE l.account_id=${accountId}::uuid AND l.order_id=${order.id}::uuid AND l.status='created'
    ON CONFLICT (dedupe_key) DO NOTHING`;
}

function expectStatus(order: LockedOrder, from: OrderStatus | undefined) {
  if (from !== undefined && order.status !== from) throw new OrderError(409, 'conflict', 'The order changed; reload and try again');
}

/**
 * Move an order along ORDER_TRANSITIONS as the signed-in member. Throws
 * OrderError (orders.ts): 404 not_found, 409 bad_transition or conflict.
 */
export async function transitionOrder(ctx: StaffContext, orderId: string, input: TransitionInput): Promise<void> {
  assertStaff(ctx);
  if (input.to === 'dispatched') return void (await recordDispatch(ctx, orderId, { from: input.from }));
  if (input.to === 'fulfilled') return void (await recordDelivery(ctx, orderId, { from: input.from }));
  await asStaff(ctx, async (tx) => {
    const order = await lockOrder(tx, ctx.accountId, orderId);
    expectStatus(order, input.from);
    if (!canTransition(order.status, input.to, { priced: order.priced, unpaidCod: order.unpaidCod }))
      throw new OrderError(409, 'bad_transition', `An order cannot move from ${order.status} to ${input.to}`);
    if (order.status === 'paid' && input.to === 'cancelled')
      throw new OrderError(409, 'bad_transition', 'A paid order is cancelled with Cancel and refund');
    // A courier may still collect the parcel (an unpaid COD order ships before payment): cancel the shipment first.
    if (input.to === 'cancelled' && (await liveShipmentExists(tx, ctx.accountId, orderId)))
      throw new OrderError(409, 'shipment_live', 'Cancel the courier shipment before cancelling this order');
    if (input.to === 'cancelled') await closeOrderTx(tx, ctx.accountId, order);
    await setStatus(tx, ctx.accountId, order, input.to);
    await auditOrder(tx, ctx, 'order.status_changed', orderId, { from: order.status, to: input.to });
  });
}

/** Staff-recorded dispatch of a paid order, with an optional tracking note; queues the customer notice. */
export async function recordDispatch(
  ctx: StaffContext, orderId: string, input: { from?: OrderStatus; trackingNote?: string | null } = {},
): Promise<void> {
  assertStaff(ctx);
  const note = typeof input.trackingNote === 'string' ? input.trackingNote.trim() : '';
  if (note.length > TRACKING_NOTE_MAX) throw new OrderError(400, 'invalid', 'Tracking note is too long');
  await asStaff(ctx, async (tx) => {
    const order = await lockOrder(tx, ctx.accountId, orderId);
    expectStatus(order, input.from);
    if (!canTransition(order.status, 'dispatched', { priced: order.priced, unpaidCod: order.unpaidCod }))
      throw new OrderError(409, 'bad_transition', `An order cannot move from ${order.status} to dispatched`);
    // Cancel and refund (or a restocking refund) is under way: shipping now would refund goods that leave.
    if (await restockRefundInFlight(tx, ctx.accountId, orderId))
      throw new OrderError(409, 'bad_transition', 'A refund that restocks this order is in progress');
    // All the money went back (a per-payment refund may also have restocked the units): the goods must not leave.
    if (await fullyRefunded(tx, ctx.accountId, orderId))
      throw new OrderError(409, 'order_refunded', 'This order was refunded in full and cannot be dispatched');
    await setStatus(tx, ctx.accountId, order, 'dispatched', input.trackingNote === undefined ? undefined : note || null);
    await queueNotice(tx, ctx.accountId, orderId, 'dispatched');
    await auditOrder(tx, ctx, 'order.dispatched', orderId, { tracking_note: Boolean(note) });
  });
}

/**
 * Staff-recorded delivery (shown as "Delivered"; the evidence badge says staff recorded). Queues the
 * follow-ups with scheduleDeliveryFollowups.
 */
export async function recordDelivery(ctx: StaffContext, orderId: string, input: { from?: OrderStatus } = {}): Promise<void> {
  assertStaff(ctx);
  await asStaff(ctx, async (tx) => {
    const order = await lockOrder(tx, ctx.accountId, orderId);
    expectStatus(order, input.from);
    if (!canTransition(order.status, 'fulfilled', { priced: order.priced, unpaidCod: order.unpaidCod }))
      throw new OrderError(409, 'bad_transition', `An order cannot move from ${order.status} to fulfilled`);
    // Straight from paid to delivered is a dispatch too: refused once everything was refunded (as recordDispatch).
    if (order.status !== 'dispatched' && (await fullyRefunded(tx, ctx.accountId, orderId)))
      throw new OrderError(409, 'order_refunded', 'This order was refunded in full and cannot be delivered');
    await setStatus(tx, ctx.accountId, order, 'fulfilled');
    await scheduleDeliveryFollowups(tx, ctx.accountId, orderId);
    await auditOrder(tx, ctx, 'order.delivered', orderId);
  });
}

/**
 * What a delivery queues, whoever recorded it (staff or courier tracking): the
 * delivered notice now, the feedback request a day later, the product
 * follow-up after the first product's follow_up_after_days when it has a
 * follow-up template, and the reorder reminder after the smallest
 * repurchase_after_days (its consent and template are checked when it runs).
 * Each kind at
 * most once per order (dedupe ofu:<orderId>:<kind>).
 */
export async function scheduleDeliveryFollowups(tx: TenantTransaction, accountId: string, orderId: string): Promise<void> {
  const now = Date.now();
  await queueNotice(tx, accountId, orderId, 'delivered');
  await queueNotice(tx, accountId, orderId, 'feedback', new Date(now + FEEDBACK_DELAY_MS));
  const [followUp] = await tx.$queryRaw<{ days: number }[]>`
    SELECT p.follow_up_after_days AS days FROM order_items i
    JOIN shop_variants v ON v.account_id=i.account_id AND v.id=i.variant_id
    JOIN shop_products p ON p.account_id=v.account_id AND p.id=v.product_id
    WHERE i.account_id=${accountId}::uuid AND i.order_id=${orderId}::uuid
      AND p.follow_up_template IS NOT NULL AND p.follow_up_after_days IS NOT NULL
    ORDER BY i.id LIMIT 1`;
  if (followUp) await queueNotice(tx, accountId, orderId, 'product_follow_up', new Date(now + followUp.days * 86_400_000));
  const repeatAt = await repeatPurchaseDueAt(tx, accountId, orderId, new Date(now));
  if (repeatAt) await queueNotice(tx, accountId, orderId, 'repeat_purchase', repeatAt);
}

// ---------------------------------------------------------------------------
// System fulfilment from courier tracking (Phase 9, design §2 "Order effects", D10)
//
// Called by lib/fulfilment/tracking-job inside its worker transaction with no
// app.user_id, after it locked the order (then the shipment, D16), so the
// status history records `system` and the fulfilment stamp leaves
// fulfilment_recorded_by NULL. Only data read back from Shiprocket with the
// workspace's own credentials reaches here. Nothing moves backwards.

/**
 * applied: the order moved; already: it was already there (or beyond);
 * conflict: the courier claim disagrees with the order (cancelled, never
 * paid, fully refunded, or a restocking refund in flight). The caller opens an
 * order_conflict exception and nothing changes.
 */
export type SystemFulfilmentOutcome = 'applied' | 'already' | 'conflict';

async function fullyRefunded(tx: TenantTransaction, accountId: string, orderId: string): Promise<boolean> {
  const [row] = await tx.$queryRaw<{ full: boolean }[]>`SELECT refund_state = 'full' AS full FROM orders
    WHERE account_id=${accountId}::uuid AND id=${orderId}::uuid`;
  return row?.full === true;
}

/** A paid order, or an unpaid cash-on-delivery order still confirmed, is ready to leave with the courier. */
const shippable = (order: LockedOrder): boolean => order.status === 'paid' || (order.status === 'confirmed' && order.unpaidCod);

/**
 * The courier picked the parcel up (or later) for a paid order, or an unpaid cash-on-delivery
 * order: → dispatched, with the dispatched notice.
 */
export async function systemDispatch(tx: TenantTransaction, accountId: string, orderId: string): Promise<SystemFulfilmentOutcome> {
  const order = await lockOrder(tx, accountId, orderId);
  if (order.status === 'dispatched' || order.status === 'fulfilled') return 'already';
  if (!shippable(order)) return 'conflict';
  if ((await fullyRefunded(tx, accountId, orderId)) || (await restockRefundInFlight(tx, accountId, orderId))) return 'conflict';
  await setStatus(tx, accountId, order, 'dispatched');
  await queueNotice(tx, accountId, orderId, 'dispatched');
  return 'applied';
}

/**
 * The courier confirmed delivery: dispatched → fulfilled, or paid → dispatched
 * → fulfilled when the first event seen is the delivery (no dispatched notice
 * then: it would be stale), then the delivery follow-ups. An order staff
 * already marked delivered is left alone ('already'; the caller records the
 * provider evidence).
 */
export async function systemDeliver(tx: TenantTransaction, accountId: string, orderId: string): Promise<SystemFulfilmentOutcome> {
  let order = await lockOrder(tx, accountId, orderId);
  if (order.status === 'fulfilled') return 'already';
  if (!shippable(order) && order.status !== 'dispatched') return 'conflict';
  if (await fullyRefunded(tx, accountId, orderId)) return 'conflict';
  if (order.status !== 'dispatched') {
    if (await restockRefundInFlight(tx, accountId, orderId)) return 'conflict';
    await setStatus(tx, accountId, order, 'dispatched');
    order = { ...order, status: 'dispatched' };
  }
  await setStatus(tx, accountId, order, 'fulfilled');
  await scheduleDeliveryFollowups(tx, accountId, orderId);
  return 'applied';
}

/**
 * A courier shipment that may still leave (or has left) with the goods: it
 * has an AWB, or its creation or AWB assignment is in flight or ambiguous,
 * and it is neither cancelled, failed nor final (delivered, returned, lost).
 */
export async function liveShipmentExists(tx: TenantTransaction, accountId: string, orderId: string): Promise<boolean> {
  const [row] = await tx.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM order_shipments
    WHERE account_id=${accountId}::uuid AND order_id=${orderId}::uuid
      AND create_state NOT IN ('failed','cancelled')
      AND (awb IS NOT NULL OR create_state IN ('creating','unknown') OR awb_state IN ('assigning','unknown'))
      AND (tracking_rank IS NULL OR tracking_rank < 90)`;
  return (row?.n ?? 0) > 0;
}

/** The order's shipment and how its dispatch or delivery is known (order detail). Caller's session (app role). */
export async function getOrderFulfilment(
  ctx: TenantContext, orderId: string,
): Promise<{ shipment: OrderShipmentView | null; evidence: FulfilmentEvidence | null }> {
  if (!UUID.test(orderId)) throw new OrderError(404, 'not_found', 'Order not found');
  return withTenant(ctx, async (tx) => {
    const [order] = await tx.$queryRaw<{ status: OrderStatus; recorded: boolean }[]>`
      SELECT status, fulfilment_recorded_by IS NOT NULL AS recorded FROM orders
      WHERE account_id=${ctx.accountId}::uuid AND id=${orderId}::uuid`;
    if (!order) throw new OrderError(404, 'not_found', 'Order not found');
    const shipment = await getOrderShipment(tx, ctx.accountId, orderId);
    return { shipment, evidence: fulfilmentEvidence({ status: order.status, fulfilment_recorded: order.recorded }, shipment) };
  });
}

/** The customer's 1-5 score, recorded by staff on a delivered order. */
export async function recordFeedback(ctx: StaffContext, orderId: string, score: number): Promise<void> {
  assertStaff(ctx);
  if (!Number.isInteger(score) || score < 1 || score > 5) throw new OrderError(400, 'invalid', 'Score must be 1 to 5');
  await asStaff(ctx, async (tx) => {
    const order = await lockOrder(tx, ctx.accountId, orderId);
    if (order.status !== 'fulfilled') throw new OrderError(409, 'bad_transition', 'Feedback is recorded on a delivered order');
    await tx.$executeRaw`UPDATE orders SET feedback_score=${score}, updated_at=now()
      WHERE account_id=${ctx.accountId}::uuid AND id=${orderId}::uuid`;
    await tx.$executeRaw`INSERT INTO order_events(account_id, order_id, kind, actor, actor_user_id, detail)
      VALUES(${ctx.accountId}::uuid, ${orderId}::uuid, 'feedback', 'staff', ${ctx.userId}::uuid, ${`score_${score}`})`;
    await auditOrder(tx, ctx, 'order.feedback_recorded', orderId, { score });
  });
}

/** Refunds that will restock the whole order when processed (not a return's), still in flight. */
async function restockRefundInFlight(tx: TenantTransaction, accountId: string, orderId: string): Promise<boolean> {
  const [row] = await tx.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM customer_refunds
    WHERE account_id=${accountId}::uuid AND order_id=${orderId}::uuid AND restock AND return_id IS NULL
      AND status IN ('requested','sending','pending','unknown')`;
  return (row?.n ?? 0) > 0;
}

type RefundPayment = Parameters<typeof applyRefundStateTx>[2];
export type SettledPayment = RefundPayment & { refundable: bigint | number };

/** The order's settled payments, locked (payments before the order, the refunds lock order), with what each can still refund. */
export function lockSettledPayments(tx: TenantTransaction, accountId: string, orderId: string): Promise<SettledPayment[]> {
  return tx.$queryRaw<SettledPayment[]>`
    SELECT p.id::text AS id, p.source, p.status, p.settlement, p.provider_payment_id, p.amount_minor, p.refunded_minor, p.currency,
      p.order_id::text AS order_id, p.appointment_id::text AS appointment_id,
      p.amount_minor - p.refunded_minor - COALESCE((
        SELECT sum(r.amount_minor) FROM customer_refunds r WHERE r.account_id=p.account_id AND r.payment_id=p.id
          AND r.status IN ('requested','sending','pending','unknown')), 0) AS refundable
    FROM customer_payments p
    WHERE p.account_id=${accountId}::uuid AND p.order_id=${orderId}::uuid AND p.status='captured' AND p.settlement='settled'
    ORDER BY p.id FOR UPDATE OF p`;
}

export const viaGateway = (p: Pick<SettledPayment, 'source' | 'provider_payment_id'>) => p.source === 'razorpay' && Boolean(p.provider_payment_id);

/**
 * "Cancel and refund" for a paid, not yet dispatched order (permission
 * commerce.refunds).
 *
 * Checks every payment first and requests nothing unless all pass: money
 * Razorpay does not hold (a staff-recorded offline payment, or a legacy order
 * paid before customer_payments existed) needs `refundedOutside`, the staff's
 * confirmation that it was returned outside the app (RefundError
 * 'offline_payment' otherwise). Then a gateway refund is requested for what
 * each Razorpay payment can still refund (restocking when processed), and
 * finally, under the payment and order locks, each offline payment is
 * recorded as refunded outside (processed at once: refunded amounts, restock,
 * credit note) and the order is cancelled.
 *
 * Dispatch is refused while such a refund is in flight, so the order cannot
 * ship between the two steps. If it changed anyway, the refunds not yet
 * claimed for sending are withdrawn (failed, 'order_changed') and the call
 * returns 409. Refunds are never re-sent here: what is in flight is excluded.
 */
export async function cancelAndRefund(
  ctx: StaffContext, orderId: string, input: { note?: string | null; refundedOutside?: boolean } = {},
): Promise<{ refundIds: string[]; refundedOutside: boolean }> {
  assertStaff(ctx);
  await requirePermission(ctx, 'commerce.refunds');
  const note = typeof input.note === 'string' ? input.note.trim().slice(0, 500) || null : null;
  const payments = await asStaff(ctx, async (tx) => {
    const settled = await lockSettledPayments(tx, ctx.accountId, orderId);
    const order = await lockOrder(tx, ctx.accountId, orderId);
    if (order.status !== 'paid') throw new OrderError(409, 'bad_transition', 'Only a paid order that is not dispatched can be cancelled and refunded');
    // Goods could leave after the refund: the courier shipment is cancelled first (or Returns used after pickup).
    if (await liveShipmentExists(tx, ctx.accountId, orderId)) throw new ShipmentError('shipment_live');
    const outside = !settled.length || settled.some((p) => !viaGateway(p) && (minorFromDb(p.refundable) ?? 0) > 0);
    if (outside && input.refundedOutside !== true) throw new RefundError('offline_payment');
    return settled;
  });
  const refundIds: string[] = [];
  for (const payment of payments) {
    const amount = minorFromDb(payment.refundable) ?? 0;
    if (!viaGateway(payment) || amount <= 0) continue;
    const { refundId } = await requestRefund(ctx, { paymentId: payment.id, amountMinor: amount, reason: 'cancelled', note, restock: true });
    refundIds.push(refundId);
  }
  const outcome = await asStaff(ctx, async (tx) => {
    const settled = await lockSettledPayments(tx, ctx.accountId, orderId);
    const order = await lockOrder(tx, ctx.accountId, orderId);
    if (order.status === 'cancelled') return 'done' as const; // a concurrent Cancel and refund finished it
    // A shipment requested between the two steps counts as a change too.
    const shipped = order.status === 'paid' && (await liveShipmentExists(tx, ctx.accountId, orderId));
    if (order.status !== 'paid' || shipped) {
      const withdrawn = await withdrawUnsentTx(tx, ctx, orderId, refundIds);
      await auditOrder(tx, ctx, 'order.cancel_refund_withdrawn', orderId, { withdrawn });
      return shipped ? ('shipped' as const) : ('changed' as const);
    }
    let outside = 0;
    for (const payment of settled) {
      const amount = minorFromDb(payment.refundable) ?? 0;
      if (viaGateway(payment) || amount <= 0) continue;
      if (input.refundedOutside !== true) throw new RefundError('offline_payment');
      const [row] = await tx.$queryRaw<{ id: string }[]>`INSERT INTO customer_refunds(account_id,payment_id,order_id,source,amount_minor,currency,
          reason_code,note,status,attempt,requested_by,restock)
        VALUES(${ctx.accountId}::uuid,${payment.id}::uuid,${orderId}::uuid,'external',${BigInt(amount)},${payment.currency},
          'cancelled',${note},'pending',1,${ctx.userId}::uuid,true)
        RETURNING id::text AS id`;
      await applyRefundStateTx(tx, ctx.accountId, payment, row.id, 'processed', null);
      outside += 1;
    }
    await closeOrderTx(tx, ctx.accountId, order);
    await setStatus(tx, ctx.accountId, order, 'cancelled');
    await auditOrder(tx, ctx, 'order.cancelled_refunded', orderId, {
      refunds: refundIds.length, refunded_outside: input.refundedOutside === true, outside_refunds: outside,
    });
    return 'done' as const;
  });
  if (outcome === 'changed') throw new OrderError(409, 'conflict', 'The order changed; reload and try again');
  if (outcome === 'shipped') throw new ShipmentError('shipment_live');
  return { refundIds, refundedOutside: input.refundedOutside === true };
}

/**
 * The refunds this call requested that no job has claimed yet are marked
 * failed ('order_changed'), so they are never sent; one already claimed goes
 * through reconciliation as usual. Caller holds the payment locks.
 */
async function withdrawUnsentTx(tx: TenantTransaction, ctx: StaffContext, orderId: string, refundIds: string[]): Promise<number> {
  if (!refundIds.length) return 0;
  const rows = await tx.$queryRaw<{ id: string }[]>`UPDATE customer_refunds SET status='failed', failure_code='order_changed'
    WHERE account_id=${ctx.accountId}::uuid AND id = ANY(${refundIds}::uuid[]) AND status='requested'
    RETURNING id::text AS id`;
  if (rows.length) await orderEventTx(tx, ctx.accountId, orderId, 'refund_failed', { detail: 'order_changed' });
  return rows.length;
}

// ---------------------------------------------------------------------------
// Timeline (caller's session, app role; agents and above by RLS)

export interface OrderTimeline {
  events: Array<{ id: string; kind: string; from_status: string | null; to_status: string | null; actor: string;
    actor_name: string | null; detail: string | null; created_at: string }>;
  documents: Array<{ id: string; kind: 'receipt' | 'credit_note'; number: string; total_minor: number; currency: string; issued_at: string }>;
  messages: Array<{ kind: string; status: string; reason: string | null; resolved_at: string | null; updated_at: string }>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function getOrderTimeline(ctx: TenantContext, orderId: string): Promise<OrderTimeline> {
  if (!UUID.test(orderId)) throw new OrderError(404, 'not_found', 'Order not found');
  return withTenant(ctx, async (tx) => {
    const [exists] = await tx.$queryRaw<{ id: string }[]>`SELECT id::text AS id FROM orders
      WHERE account_id=${ctx.accountId}::uuid AND id=${orderId}::uuid`;
    if (!exists) throw new OrderError(404, 'not_found', 'Order not found');
    const [events, documents, messages] = await Promise.all([
      tx.$queryRaw<{ id: string; kind: string; from_status: string | null; to_status: string | null; actor: string;
        actor_name: string | null; detail: string | null; created_at: Date }[]>`
        SELECT e.id::text AS id, e.kind, e.from_status, e.to_status, e.actor,
          (SELECT p.full_name FROM profiles p WHERE p.user_id=e.actor_user_id LIMIT 1) AS actor_name, e.detail, e.created_at
        FROM order_events e
        WHERE e.account_id=${ctx.accountId}::uuid AND e.order_id=${orderId}::uuid ORDER BY e.created_at, e.id LIMIT 500`,
      tx.$queryRaw<{ id: string; kind: 'receipt' | 'credit_note'; number: string; total_minor: bigint; currency: string; issued_at: Date }[]>`
        SELECT id::text AS id, kind, number, total_minor, currency, issued_at FROM commerce_documents
        WHERE account_id=${ctx.accountId}::uuid AND order_id=${orderId}::uuid ORDER BY issued_at`,
      tx.$queryRaw<{ kind: string; status: string; reason: string | null; resolved_at: Date | null; updated_at: Date }[]>`
        SELECT kind, status, reason, resolved_at, updated_at FROM order_messages
        WHERE account_id=${ctx.accountId}::uuid AND order_id=${orderId}::uuid ORDER BY created_at`,
    ]);
    return {
      events: events.map((e) => ({ ...e, created_at: e.created_at.toISOString() })),
      documents: documents.map((d) => ({ ...d, total_minor: minorFromDb(d.total_minor)!, issued_at: d.issued_at.toISOString() })),
      messages: messages.map((m) => ({ ...m, resolved_at: m.resolved_at?.toISOString() ?? null, updated_at: m.updated_at.toISOString() })),
    };
  });
}
