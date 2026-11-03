/**
 * Record offline payment (design E10). The only staff path to "paid": a member
 * with commerce.record_payments records cash, bank transfer or another
 * payment taken outside the gateway, for exactly the amount still due. It is
 * labelled staff-recorded, audited, and settles through the same credit path
 * as a verified gateway payment (stock, coupon, receipt, Purchase, order.paid).
 * Any live payment link for the order is cancelled first, so the customer
 * cannot also pay online; a gateway capture that still arrives is a
 * duplicate_payment exception, never a second credit.
 */
import { getWorkerPrisma } from '@/lib/db/prisma';
import { withTenant, type TenantContext, type TenantTransaction } from '@/lib/db/tenant';
import { requirePermission } from '@/lib/auth/permissions';
import { getT } from '@/lib/i18n/translate';
import { parseMoney } from '@/lib/commerce/money';
import { cancelPaymentLinkRecord, PaymentLinkError } from './links';
import { creditOrderTx, lockOrderTx, orderSettlementPlan, type OrderLockRow } from './settle';
import { auditTx, stableUuid, UUID } from './ledger';

export const OFFLINE_METHODS = ['cash', 'upi', 'bank_transfer', 'card', 'cheque', 'other'] as const;
export type OfflineMethod = (typeof OFFLINE_METHODS)[number];
export const REFERENCE_MAX = 100;

export type OfflinePaymentErrorCode =
  | 'not_found' | 'invalid_amount' | 'invalid_method' | 'invalid_reference' | 'not_payable' | 'amount_not_due'
  | 'currency_mismatch' | 'link_pending' | 'link_paid';

const ERROR_STATUS: Record<OfflinePaymentErrorCode, number> = {
  not_found: 404, invalid_amount: 400, invalid_method: 400, invalid_reference: 400, not_payable: 409, amount_not_due: 409,
  currency_mismatch: 409, link_pending: 409, link_paid: 409,
};

export class OfflinePaymentError extends Error {
  readonly status: number;
  constructor(readonly code: OfflinePaymentErrorCode) {
    super(getT('Payments.offline.errors')(code));
    this.name = 'OfflinePaymentError';
    this.status = ERROR_STATUS[code];
  }
}

export interface OfflinePaymentInput {
  /** Decimal text in the order's currency, e.g. "1499.00". */
  amount: string;
  method: OfflineMethod;
  reference?: string | null;
  /** A replay with the same id returns the first payment. */
  clientRequestId: string;
}

function planOrThrow(order: OrderLockRow, amountMinor: number): void {
  const plan = orderSettlementPlan(order, { amountMinor, currency: order.currency });
  if (plan === 'amount_mismatch' || (plan === 'duplicate_payment' && order.status === 'awaiting_payment')) throw new OfflinePaymentError('amount_not_due');
  if (plan === 'currency_mismatch') throw new OfflinePaymentError('currency_mismatch');
  // An expired order needs its stock back first: staff re-open checkout instead.
  if (plan !== 'credit') throw new OfflinePaymentError('not_payable');
}

interface LiveLink { id: string; status: string; unsettled: boolean }

/**
 * The order's links that can still take, or have taken but not yet settled, money.
 * `unsettled` marks a paid link with no captured payment settled yet (settlement queued or slow).
 */
function liveLinks(tx: TenantTransaction, accountId: string, orderId: string): Promise<LiveLink[]> {
  return tx.$queryRaw<LiveLink[]>`
    SELECT l.id::text AS id,l.status,
      (l.status='paid' AND NOT EXISTS (SELECT 1 FROM customer_payments p WHERE p.account_id=l.account_id AND p.payment_link_id=l.id
        AND p.status='captured' AND p.settlement<>'pending')) AS unsettled
    FROM payment_links l WHERE l.account_id=${accountId}::uuid AND l.order_id=${orderId}::uuid
      AND l.status IN ('creating','unknown','created','partially_paid','paid')`;
}

/**
 * A paid link whose payment has not settled yet would credit the order next: recording cash too
 * would take the money twice. A paid link settled as an exception (e.g. amount_mismatch) does not block.
 */
export function refuseLiveLinks(links: readonly LiveLink[]): void {
  if (links.some((l) => l.status === 'creating' || l.status === 'unknown' || l.status === 'partially_paid')) throw new OfflinePaymentError('link_pending');
  if (links.some((l) => l.status === 'paid' && l.unsettled)) throw new OfflinePaymentError('link_paid');
}

/** Records an offline payment for an order; returns the customer payment id. */
export async function recordOfflinePayment(ctx: TenantContext & { userId: string }, orderId: string, input: OfflinePaymentInput): Promise<{ paymentId: string }> {
  await requirePermission(ctx, 'commerce.record_payments');
  if (!UUID.test(orderId)) throw new OfflinePaymentError('not_found');
  if (!(OFFLINE_METHODS as readonly string[]).includes(input.method)) throw new OfflinePaymentError('invalid_method');
  const reference = typeof input.reference === 'string' ? input.reference.trim() : '';
  if (reference.length > REFERENCE_MAX || /[\u0000-\u001f]/.test(reference)) throw new OfflinePaymentError('invalid_reference');
  if (!UUID.test(input.clientRequestId)) throw new OfflinePaymentError('invalid_amount');
  const paymentId = stableUuid(`offline:${ctx.accountId}:${ctx.userId}:${input.clientRequestId}`);
  const db = getWorkerPrisma();

  // A replay returns the first payment.
  const head = await withTenant(ctx, (tx) => tx.$queryRaw<{ currency: string; replay: boolean }[]>`
    SELECT o.currency, EXISTS(SELECT 1 FROM customer_payments p WHERE p.account_id=o.account_id AND p.id=${paymentId}::uuid) AS replay
    FROM orders o WHERE o.account_id=${ctx.accountId}::uuid AND o.id=${orderId}::uuid`, db);
  if (!head[0]) throw new OfflinePaymentError('not_found');
  if (head[0].replay) return { paymentId };
  let amountMinor: number;
  try {
    amountMinor = parseMoney(input.amount, head[0].currency);
  } catch {
    throw new OfflinePaymentError('invalid_amount');
  }
  if (amountMinor <= 0) throw new OfflinePaymentError('invalid_amount');
  // Refuse a wrong amount or a closed order before touching any link; checked again under the lock below.
  const current = await withTenant(ctx, (tx) => tx.$queryRaw<OrderLockRow[]>`SELECT id::text AS id,status,source,external_id,priced_at,total_minor,subtotal_minor,
      amount_paid_minor,currency,contact_id::text AS contact_id,conversation_id::text AS conversation_id
    FROM orders WHERE account_id=${ctx.accountId}::uuid AND id=${orderId}::uuid`, db);
  if (current[0]) planOrThrow(current[0], amountMinor);

  // Close the online path first. A link whose create is unclear may still take money: refuse until it is reconciled.
  const links = await withTenant(ctx, (tx) => liveLinks(tx, ctx.accountId, orderId), db);
  refuseLiveLinks(links);
  for (const link of links.filter((l) => l.status === 'created')) {
    try {
      const cancelled = await cancelPaymentLinkRecord(ctx.accountId, link.id);
      if (cancelled.status === 'paid') throw new OfflinePaymentError('link_paid');
    } catch (error) {
      if (error instanceof PaymentLinkError && error.code === 'not_cancellable') throw new OfflinePaymentError('link_paid');
      throw error;
    }
  }

  return withTenant(ctx, async (tx) => {
    const order = await lockOrderTx(tx, ctx.accountId, orderId);
    if (!order) throw new OfflinePaymentError('not_found');
    planOrThrow(order, amountMinor);
    // Again under the order lock: a link may have been paid since the check above.
    refuseLiveLinks(await liveLinks(tx, ctx.accountId, orderId));
    await tx.$executeRaw`INSERT INTO customer_payments(id,account_id,source,order_id,amount_minor,currency,status,method,offline_reference,recorded_by,captured_at)
      VALUES(${paymentId}::uuid,${ctx.accountId}::uuid,'offline',${orderId}::uuid,${BigInt(amountMinor)},${order.currency},'captured',${input.method},
        ${reference || null},${ctx.userId}::uuid,now())`;
    await creditOrderTx(tx, { accountId: ctx.accountId, order, paymentId, amountMinor, link: null, late: false, actorUserId: ctx.userId });
    await auditTx(tx, ctx.accountId, ctx.userId, 'commerce.offline_payment_recorded', paymentId, {
      order_id: orderId, amount_minor: amountMinor, currency: order.currency, method: input.method,
    });
    return { paymentId };
  }, db);
}
