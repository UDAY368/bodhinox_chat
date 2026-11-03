/**
 * Refunds (design E11). Row-first, not dispatchOnce: the refund row, its job
 * and the audit entry commit together; the job claims requested -> sending,
 * calls Razorpay once with notes.bodhinox_refund_id, and records pending,
 * processed, failed (a definite 4xx) or unknown (timeout, 5xx, crash). An
 * unknown refund is reconciled, never re-sent automatically: staff may retry
 * only a failed one (a definite refusal, or reconciliation proved Razorpay
 * holds no refund for it), as a new attempt.
 *
 * Every attempt carries the same notes.bodhinox_refund_id, so a provider
 * refund is matched to its own attempt: the row's provider_refund_id, the
 * ids of earlier attempts (superseded_provider_refund_ids) and notes.attempt.
 * A late report about an earlier attempt never moves the live one; if it says
 * that earlier refund was processed after all, it is surfaced for
 * reconciliation (refund_unknown, detail stale_attempt_processed), never
 * counted or cleared automatically.
 *
 * Refunds made in the Razorpay dashboard arrive by refund.* webhook or
 * reconciliation and are recorded as source 'external', so reports and the
 * order's refunded amount never drift from the gateway.
 *
 * Lock order: customer_payments row -> customer_refunds row -> order row -> inventory.
 */
import { getWorkerPrisma } from '@/lib/db/prisma';
import { withTenant, type TenantContext, type TenantTransaction } from '@/lib/db/tenant';
import { requirePermission } from '@/lib/auth/permissions';
import { getT } from '@/lib/i18n/translate';
import { minorFromDb, parseMoney } from '@/lib/commerce/money';
import { restockTx, type StockLine } from '@/lib/commerce/stock';
import { loadRazorpaySecrets, PaymentProviderError } from './providers';
import { createRefund, listRefunds, type RazorpayRefund, type RazorpayRefundStatus } from './razorpay';

/** A provider refund, with the attempt number from notes.attempt when the parser supplies it. */
type ProviderRefund = RazorpayRefund & { attempt?: number | null };
const attemptOf = (refund: RazorpayRefund): number | null => {
  const attempt = (refund as ProviderRefund).attempt;
  return typeof attempt === 'number' && Number.isInteger(attempt) && attempt >= 1 ? attempt : null;
};
import { auditTx, enqueueJobTx, openExceptionTx, orderEventTx, resolveExceptionsTx, stableUuid, UUID } from './ledger';

export const REFUND_REASONS = ['customer_request', 'out_of_stock', 'return', 'duplicate', 'cancelled', 'other'] as const;
export type RefundReason = (typeof REFUND_REASONS)[number];
export type RefundStatus = 'requested' | 'sending' | 'pending' | 'processed' | 'failed' | 'unknown';

export const REFUND_JOB = 'payments.refund';
export const ISSUE_CREDIT_NOTE_JOB = 'commerce.issue_credit_note';
/** A 'sending' refund older than this is treated as an unknown outcome (the provider call times out at 15 s). */
export const STALE_SENDING_MS = 2 * 60_000;
const MAX_ATTEMPTS = 20;
export const NOTE_MAX = 500;

export interface RefundRequest {
  paymentId: string;
  amountMinor: number;
  reason: RefundReason;
  note?: string | null;
  /** Put the order's units back on hand when the refund is processed (not after dispatch, unless a return says so). */
  restock: boolean;
  returnId?: string | null;
  /** Replays with the same id return the first refund instead of refunding twice. */
  clientRequestId?: string | null;
}

/** payments.refund — dedupe refund:<refundId>:<attempt>. */
export interface RefundJobPayload {
  refundId: string;
  attempt: number;
}

export type RefundErrorCode =
  | 'not_found' | 'invalid_amount' | 'invalid_reason' | 'invalid_note' | 'not_refundable' | 'offline_payment'
  | 'amount_exceeds' | 'return_mismatch' | 'not_retryable' | 'not_reconcilable' | 'not_connected' | 'provider_unreachable';

const ERROR_STATUS: Record<RefundErrorCode, number> = {
  not_found: 404, invalid_amount: 400, invalid_reason: 400, invalid_note: 400, not_refundable: 409, offline_payment: 409,
  amount_exceeds: 409, return_mismatch: 400, not_retryable: 409, not_reconcilable: 409, not_connected: 409, provider_unreachable: 502,
};

export class RefundError extends Error {
  readonly status: number;
  constructor(readonly code: RefundErrorCode) {
    super(getT('Payments.refunds.errors')(code));
    this.name = 'RefundError';
    this.status = ERROR_STATUS[code];
  }
}

const worker = <T>(ctx: TenantContext, op: (tx: TenantTransaction) => Promise<T>) => withTenant(ctx, op, getWorkerPrisma());

interface LockedPayment {
  id: string;
  source: string;
  status: string;
  settlement: string;
  provider_payment_id: string | null;
  amount_minor: bigint | number;
  refunded_minor: bigint | number;
  currency: string;
  order_id: string | null;
  appointment_id: string | null;
}

async function lockPayment(tx: TenantTransaction, accountId: string, paymentId: string): Promise<LockedPayment | null> {
  const rows = await tx.$queryRaw<LockedPayment[]>`SELECT id::text AS id,source,status,settlement,provider_payment_id,amount_minor,refunded_minor,currency,
      order_id::text AS order_id, appointment_id::text AS appointment_id
    FROM customer_payments WHERE account_id=${accountId}::uuid AND id=${paymentId}::uuid FOR UPDATE`;
  return rows[0] ?? null;
}

/** What may still be refunded: captured − refunded − refunds already in flight. */
async function refundableTx(tx: TenantTransaction, accountId: string, payment: LockedPayment, excludeRefundId?: string): Promise<number> {
  const inflight = await tx.$queryRaw<{ n: bigint | number | null }[]>`SELECT COALESCE(sum(amount_minor),0) AS n FROM customer_refunds
    WHERE account_id=${accountId}::uuid AND payment_id=${payment.id}::uuid AND status IN ('requested','sending','pending','unknown')
      AND (${excludeRefundId ?? null}::uuid IS NULL OR id<>${excludeRefundId ?? null}::uuid)`;
  return (minorFromDb(payment.amount_minor) ?? 0) - (minorFromDb(payment.refunded_minor) ?? 0) - (minorFromDb(inflight[0]?.n) ?? 0);
}

/** Amount entered as decimal text in the payment's currency (e.g. "120.50"). */
export function refundAmountFrom(input: string | number, currency: string): number {
  try {
    return parseMoney(input, currency);
  } catch {
    throw new RefundError('invalid_amount');
  }
}

/**
 * Staff refund (permission commerce.refunds, checked here). Refuses an amount
 * above captured − refunded − in-flight refunds. Returns the new refund's id.
 */
export async function requestRefund(ctx: TenantContext & { userId: string }, input: RefundRequest): Promise<{ refundId: string }> {
  await requirePermission(ctx, 'commerce.refunds');
  if (!UUID.test(input.paymentId)) throw new RefundError('not_found');
  if (!Number.isSafeInteger(input.amountMinor) || input.amountMinor <= 0) throw new RefundError('invalid_amount');
  if (!(REFUND_REASONS as readonly string[]).includes(input.reason)) throw new RefundError('invalid_reason');
  const note = typeof input.note === 'string' ? input.note.trim() : '';
  if (note.length > NOTE_MAX) throw new RefundError('invalid_note');
  if (input.returnId && !UUID.test(input.returnId)) throw new RefundError('return_mismatch');
  const refundId = input.clientRequestId && UUID.test(input.clientRequestId)
    ? stableUuid(`refund:${ctx.accountId}:${ctx.userId}:${input.clientRequestId}`) : null;

  return worker(ctx, async (tx) => {
    const payment = await lockPayment(tx, ctx.accountId, input.paymentId);
    if (!payment) throw new RefundError('not_found');
    if (refundId) {
      const replay = await tx.$queryRaw<{ id: string }[]>`SELECT id::text AS id FROM customer_refunds WHERE account_id=${ctx.accountId}::uuid AND id=${refundId}::uuid`;
      if (replay[0]) return { refundId: replay[0].id };
    }
    if (payment.source !== 'razorpay' || !payment.provider_payment_id) throw new RefundError('offline_payment');
    if (payment.status !== 'captured') throw new RefundError('not_refundable');
    if (input.amountMinor > (await refundableTx(tx, ctx.accountId, payment))) throw new RefundError('amount_exceeds');
    if (input.returnId) {
      const ret = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM order_returns WHERE account_id=${ctx.accountId}::uuid
        AND id=${input.returnId}::uuid AND order_id=${payment.order_id}::uuid`;
      if (!ret[0]) throw new RefundError('return_mismatch');
    }
    const rows = await tx.$queryRaw<{ id: string }[]>`INSERT INTO customer_refunds(id,account_id,payment_id,order_id,appointment_id,source,amount_minor,currency,
        reason_code,note,status,attempt,requested_by,restock,return_id)
      VALUES(COALESCE(${refundId}::uuid, gen_random_uuid()),${ctx.accountId}::uuid,${payment.id}::uuid,${payment.order_id}::uuid,${payment.appointment_id}::uuid,
        'bodhinox',${BigInt(input.amountMinor)},${payment.currency},${input.reason},${note || null},'requested',1,${ctx.userId}::uuid,
        ${input.restock === true},${input.returnId ?? null}::uuid)
      RETURNING id::text AS id`;
    const id = rows[0].id;
    if (input.returnId) await tx.$executeRaw`UPDATE order_returns SET refund_id=${id}::uuid WHERE account_id=${ctx.accountId}::uuid AND id=${input.returnId}::uuid AND refund_id IS NULL`;
    await enqueueJobTx(tx, ctx.accountId, REFUND_JOB, { refundId: id, attempt: 1 }, `refund:${id}:1`);
    await auditTx(tx, ctx.accountId, ctx.userId, 'commerce.refund_requested', id, {
      payment_id: payment.id, order_id: payment.order_id, amount_minor: input.amountMinor, currency: payment.currency, reason: input.reason, restock: input.restock === true,
    });
    if (payment.order_id) await orderEventTx(tx, ctx.accountId, payment.order_id, 'refund_requested', { actorUserId: ctx.userId, detail: input.reason });
    return { refundId: id };
  });
}

/**
 * Staff retry of a refund Razorpay definitely did not make (a refusal, or
 * reconciliation proved absence): a new attempt with its own job.
 */
export async function retryRefund(ctx: TenantContext & { userId: string }, refundId: string): Promise<{ attempt: number }> {
  await requirePermission(ctx, 'commerce.refunds');
  if (!UUID.test(refundId)) throw new RefundError('not_found');
  return worker(ctx, async (tx) => {
    const head = await tx.$queryRaw<{ payment_id: string }[]>`SELECT payment_id::text AS payment_id FROM customer_refunds WHERE account_id=${ctx.accountId}::uuid AND id=${refundId}::uuid`;
    if (!head[0]) throw new RefundError('not_found');
    const payment = await lockPayment(tx, ctx.accountId, head[0].payment_id);
    const rows = await tx.$queryRaw<{ status: string; source: string; attempt: number; amount_minor: bigint | number; order_id: string | null }[]>`
      SELECT status,source,attempt,amount_minor,order_id::text AS order_id FROM customer_refunds WHERE account_id=${ctx.accountId}::uuid AND id=${refundId}::uuid FOR UPDATE`;
    const refund = rows[0];
    if (!payment || !refund) throw new RefundError('not_found');
    if (refund.status !== 'failed' || refund.source !== 'bodhinox' || refund.attempt >= MAX_ATTEMPTS) throw new RefundError('not_retryable');
    if ((minorFromDb(refund.amount_minor) ?? 0) > (await refundableTx(tx, ctx.accountId, payment, refundId))) throw new RefundError('amount_exceeds');
    const attempt = refund.attempt + 1;
    // The earlier attempt's Razorpay id is kept, so a late report about it can never move this attempt.
    await tx.$executeRaw`UPDATE customer_refunds SET status='requested', attempt=${attempt}, failure_code=NULL, provider_refund_id=NULL,
        superseded_provider_refund_ids = CASE WHEN provider_refund_id IS NULL THEN superseded_provider_refund_ids
          ELSE array_append(superseded_provider_refund_ids, provider_refund_id) END
      WHERE account_id=${ctx.accountId}::uuid AND id=${refundId}::uuid`;
    await enqueueJobTx(tx, ctx.accountId, REFUND_JOB, { refundId, attempt }, `refund:${refundId}:${attempt}`);
    await resolveExceptionsTx(tx, ctx.accountId, { subjectKey: `refund:${refundId}` }, 'dismissed', ctx.userId);
    await auditTx(tx, ctx.accountId, ctx.userId, 'commerce.refund_retried', refundId, { attempt });
    if (refund.order_id) await orderEventTx(tx, ctx.accountId, refund.order_id, 'refund_retried', { actorUserId: ctx.userId });
    return { attempt };
  });
}

/** One refund send. Claims requested -> sending first, so a replayed job never sends twice. */
export async function handleRefundJob(accountId: string, payload: RefundJobPayload): Promise<void> {
  const ctx: TenantContext = { accountId, role: 'owner' };
  if (!UUID.test(payload.refundId) || !Number.isInteger(payload.attempt) || payload.attempt < 1) throw new Error('Invalid refund job contract');
  const claimed = await worker(ctx, (tx) => tx.$queryRaw<{ id: string; amount_minor: bigint | number; provider_payment_id: string | null }[]>`
    UPDATE customer_refunds r SET status='sending' FROM customer_payments p
    WHERE r.account_id=${accountId}::uuid AND r.id=${payload.refundId}::uuid AND r.status='requested' AND r.attempt=${payload.attempt}
      AND p.account_id=r.account_id AND p.id=r.payment_id
    RETURNING r.id::text AS id, r.amount_minor, p.provider_payment_id`);
  const refund = claimed[0];
  if (!refund) return;
  if (!refund.provider_payment_id) {
    await recordProviderOutcome(accountId, refund.id, { kind: 'failed', code: 'offline_payment' });
    return;
  }
  let secrets;
  try {
    secrets = await loadRazorpaySecrets(accountId);
  } catch (error) {
    if (!(error instanceof PaymentProviderError)) throw error;
    // Nothing was sent: a definite failure staff can retry once Razorpay is connected again.
    await recordProviderOutcome(accountId, refund.id, { kind: 'failed', code: 'not_connected' });
    return;
  }
  let result;
  try {
    result = await createRefund({
      keyId: secrets.keyId, keySecret: secrets.keySecret, paymentId: refund.provider_payment_id,
      amountMinor: minorFromDb(refund.amount_minor) ?? 0, refundId: refund.id, attempt: payload.attempt,
    });
  } catch {
    // Refused before any request.
    await recordProviderOutcome(accountId, refund.id, { kind: 'failed', code: 'invalid_request' });
    return;
  }
  if (result.outcome === 'created') await applyProviderRefund(accountId, result.refund, refund.id);
  else if (result.outcome === 'rejected') await recordProviderOutcome(accountId, refund.id, { kind: 'failed', code: result.reason });
  else await recordProviderOutcome(accountId, refund.id, { kind: 'unknown' });
}

/** A refusal or an unclear outcome for one of our sends (never moves a processed refund). */
async function recordProviderOutcome(accountId: string, refundId: string, outcome: { kind: 'failed'; code: string } | { kind: 'unknown' }): Promise<void> {
  await worker({ accountId, role: 'owner' }, async (tx) => {
    const rows = await tx.$queryRaw<{ payment_id: string }[]>`SELECT payment_id::text AS payment_id FROM customer_refunds WHERE account_id=${accountId}::uuid AND id=${refundId}::uuid`;
    if (!rows[0]) return;
    await lockPayment(tx, accountId, rows[0].payment_id);
    const refund = await lockRefund(tx, accountId, refundId);
    if (!refund || refund.status === 'processed' || refund.status === 'pending') return;
    if (outcome.kind === 'failed') await markFailedTx(tx, accountId, refund, outcome.code);
    else {
      await tx.$executeRaw`UPDATE customer_refunds SET status='unknown' WHERE account_id=${accountId}::uuid AND id=${refundId}::uuid`;
      await openExceptionTx(tx, { accountId, kind: 'refund_unknown', subjectKey: `refund:${refundId}`, refundId, paymentId: refund.payment_id, orderId: refund.order_id, detail: 'provider_unclear' });
    }
  });
}

interface RefundRow {
  id: string;
  payment_id: string;
  order_id: string | null;
  appointment_id: string | null;
  return_id: string | null;
  source: string;
  status: string;
  amount_minor: bigint | number;
  restock: boolean;
  provider_refund_id: string | null;
  attempt: number;
  superseded_provider_refund_ids: string[];
}

/**
 * True when a provider refund belongs to an earlier attempt of this row: its
 * id was superseded, the row already holds a different provider id, or its
 * notes.attempt names another attempt.
 */
export function isStaleAttempt(row: Pick<RefundRow, 'provider_refund_id' | 'attempt' | 'superseded_provider_refund_ids'>,
  provider: { id: string; attempt: number | null }): boolean {
  if (row.provider_refund_id === provider.id) return false;
  if ((row.superseded_provider_refund_ids ?? []).includes(provider.id)) return true;
  if (row.provider_refund_id) return true;
  return provider.attempt !== null && provider.attempt !== row.attempt;
}

async function lockRefund(tx: TenantTransaction, accountId: string, refundId: string): Promise<RefundRow | null> {
  const rows = await tx.$queryRaw<RefundRow[]>`SELECT id::text AS id,payment_id::text AS payment_id,order_id::text AS order_id,appointment_id::text AS appointment_id,
      return_id::text AS return_id,source,status,amount_minor,restock,provider_refund_id,attempt,superseded_provider_refund_ids
    FROM customer_refunds WHERE account_id=${accountId}::uuid AND id=${refundId}::uuid FOR UPDATE`;
  return rows[0] ?? null;
}

async function markFailedTx(tx: TenantTransaction, accountId: string, refund: RefundRow, code: string): Promise<void> {
  const failure = /^[a-z0-9_]{1,64}$/.test(code) ? code : 'provider_rejected';
  await tx.$executeRaw`UPDATE customer_refunds SET status='failed', failure_code=${failure} WHERE account_id=${accountId}::uuid AND id=${refund.id}::uuid`;
  await resolveExceptionsTx(tx, accountId, { subjectKey: `refund:${refund.id}` }, 'dismissed', null);
  await openExceptionTx(tx, { accountId, kind: 'refund_failed', subjectKey: `refund:${refund.id}`, refundId: refund.id, paymentId: refund.payment_id, orderId: refund.order_id, detail: failure });
  if (refund.order_id) await orderEventTx(tx, accountId, refund.order_id, 'refund_failed', { detail: failure });
}

/**
 * Applies what Razorpay holds for one refund (ours or the dashboard's) under
 * the payment and refund locks. `ourId` names our row when the caller knows
 * it (the send's own answer). Idempotent: processed is final and counted once.
 */
export async function applyProviderRefund(accountId: string, refund: RazorpayRefund, ourId?: string): Promise<void> {
  await worker({ accountId, role: 'owner' }, async (tx) => {
    const payments = await tx.$queryRaw<{ id: string }[]>`SELECT id::text AS id FROM customer_payments
      WHERE account_id=${accountId}::uuid AND provider_payment_id=${refund.paymentId}`;
    if (!payments[0]) return;
    const payment = await lockPayment(tx, accountId, payments[0].id);
    if (!payment) return;
    const known = await tx.$queryRaw<{ id: string }[]>`SELECT id::text AS id FROM customer_refunds WHERE account_id=${accountId}::uuid AND payment_id=${payment.id}::uuid
      AND (provider_refund_id=${refund.id} OR id=${ourId ?? refund.bodhinoxRefundId ?? null}::uuid) LIMIT 1`;
    let refundId = known[0]?.id ?? null;
    if (!refundId) {
      if (refund.amountMinor <= 0 || refund.status === 'failed' || refund.status === 'unknown') return;
      refundId = await recordExternalRefundTx(tx, accountId, payment, refund);
    }
    await applyRefundStateTx(tx, accountId, payment, refundId, refund.status, refund.id, attemptOf(refund));
  });
}

/** A refund made outside Bodhinox (the Razorpay dashboard): recorded so collections and refunds reconcile. */
export async function recordExternalRefundTx(tx: TenantTransaction, accountId: string, payment: LockedPayment, refund: RazorpayRefund): Promise<string> {
  const rows = await tx.$queryRaw<{ id: string }[]>`INSERT INTO customer_refunds(account_id,payment_id,order_id,appointment_id,source,amount_minor,currency,
      reason_code,status,provider_refund_id,attempt,restock)
    VALUES(${accountId}::uuid,${payment.id}::uuid,${payment.order_id}::uuid,${payment.appointment_id}::uuid,'external',${BigInt(refund.amountMinor)},
      ${payment.currency},'other','pending',${refund.id},1,false)
    ON CONFLICT (account_id,provider_refund_id) DO NOTHING RETURNING id::text AS id`;
  if (rows[0]) {
    if (payment.order_id) await orderEventTx(tx, accountId, payment.order_id, 'refund_external');
    return rows[0].id;
  }
  const existing = await tx.$queryRaw<{ id: string }[]>`SELECT id::text AS id FROM customer_refunds WHERE account_id=${accountId}::uuid AND provider_refund_id=${refund.id}`;
  return existing[0].id;
}

/**
 * Moves one refund to the provider's status. On the first 'processed': the
 * payment's and order's refunded amounts, the order's refund state, a restock
 * (once), the credit note job, the payment's open exceptions resolved when it
 * is fully refunded, and a payment-review order closed.
 */
export async function applyRefundStateTx(tx: TenantTransaction, accountId: string, payment: LockedPayment, refundId: string,
  status: RazorpayRefundStatus, providerRefundId: string | null, providerAttempt: number | null = null): Promise<void> {
  const refund = await lockRefund(tx, accountId, refundId);
  if (!refund || refund.payment_id !== payment.id) return;
  if (providerRefundId && isStaleAttempt(refund, { id: providerRefundId, attempt: providerAttempt })) {
    // An earlier attempt: never moves this row. Money it reports as refunded is surfaced, not counted or dropped.
    if (status === 'processed') {
      await openExceptionTx(tx, { accountId, kind: 'refund_unknown', subjectKey: `provider_refund:${providerRefundId}`, refundId,
        orderId: refund.order_id, detail: 'stale_attempt_processed' });
    }
    return;
  }
  if (refund.status === 'processed' || status === 'unknown') return;
  if (providerRefundId && !refund.provider_refund_id) {
    await tx.$executeRaw`UPDATE customer_refunds SET provider_refund_id=${providerRefundId} WHERE account_id=${accountId}::uuid AND id=${refundId}::uuid`;
  }
  if (status === 'failed') {
    if (refund.status !== 'failed') await markFailedTx(tx, accountId, refund, 'provider_failed');
    return;
  }
  if (status === 'pending') {
    if (refund.status !== 'pending') {
      await tx.$executeRaw`UPDATE customer_refunds SET status='pending' WHERE account_id=${accountId}::uuid AND id=${refundId}::uuid`;
      await resolveExceptionsTx(tx, accountId, { subjectKey: `refund:${refundId}` }, 'dismissed', null);
    }
    return;
  }
  // processed: counted exactly once (processed is final).
  const amount = minorFromDb(refund.amount_minor) ?? 0;
  await tx.$executeRaw`UPDATE customer_refunds SET status='processed', processed_at=now(), failure_code=NULL WHERE account_id=${accountId}::uuid AND id=${refundId}::uuid`;
  const updated = await tx.$queryRaw<{ amount_minor: bigint | number; refunded_minor: bigint | number }[]>`
    UPDATE customer_payments SET refunded_minor=refunded_minor + ${BigInt(amount)}
    WHERE account_id=${accountId}::uuid AND id=${payment.id}::uuid RETURNING amount_minor, refunded_minor`;
  const fully = updated[0] && minorFromDb(updated[0].refunded_minor) === minorFromDb(updated[0].amount_minor);
  await resolveExceptionsTx(tx, accountId, { subjectKey: `refund:${refundId}` }, 'dismissed', null);
  if (fully) await resolveExceptionsTx(tx, accountId, { paymentId: payment.id }, 'refunded', null);
  await enqueueJobTx(tx, accountId, ISSUE_CREDIT_NOTE_JOB, { refundId }, `credit:${refundId}`);

  if (payment.order_id) {
    const orders = await tx.$queryRaw<{ status: string; amount_paid_minor: bigint | number; amount_refunded_minor: bigint | number }[]>`
      SELECT status,amount_paid_minor,amount_refunded_minor FROM orders WHERE account_id=${accountId}::uuid AND id=${payment.order_id}::uuid FOR UPDATE`;
    const order = orders[0];
    if (order) {
      // Only money credited to the order counts against it; an exception payment was never credited.
      if (payment.settlement === 'settled') {
        const refunded = (minorFromDb(order.amount_refunded_minor) ?? 0) + amount;
        const paid = minorFromDb(order.amount_paid_minor) ?? 0;
        const state = refunded <= 0 ? 'none' : refunded >= paid ? 'full' : 'partial';
        await tx.$executeRaw`UPDATE orders SET amount_refunded_minor=${BigInt(refunded)}, refund_state=${state}
          WHERE account_id=${accountId}::uuid AND id=${payment.order_id}::uuid`;
      }
      await orderEventTx(tx, accountId, payment.order_id, 'refund_processed', { detail: refund.source === 'external' ? 'external' : null });
      // A late payment that found no stock, refunded in full: the order closes (state machine: payment_review -> cancelled).
      if (fully && order.status === 'payment_review') {
        await tx.$executeRaw`UPDATE orders SET status='cancelled' WHERE account_id=${accountId}::uuid AND id=${payment.order_id}::uuid AND status='payment_review'`;
      }
      if (refund.restock) await restockForRefundTx(tx, accountId, payment.order_id, refund);
    }
  }
  if (payment.appointment_id && fully && payment.settlement === 'settled') {
    await tx.$executeRaw`UPDATE appointments SET payment_status='refunded'
      WHERE account_id=${accountId}::uuid AND id=${payment.appointment_id}::uuid AND payment_status='paid'`;
  }
}

/**
 * Units back on hand for a processed refund that asked for it, once: a linked
 * return restocks its items marked 'restock'; otherwise the order's sold units,
 * only while it was not dispatched, only if a sale was committed, and only
 * when the order is being unwound (cancelled, or refunded in full). A partial
 * refund of an order that still ships restocks nothing: units go back through
 * a return with a disposition per line. The 'refund_restocked' order event is
 * the order-level marker: once set, nothing restocks the order's units again.
 */
async function restockForRefundTx(tx: TenantTransaction, accountId: string, orderId: string, refund: RefundRow): Promise<void> {
  const already = await tx.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM order_events WHERE account_id=${accountId}::uuid AND order_id=${orderId}::uuid AND kind='refund_restocked'`;
  if ((already[0]?.n ?? 0) > 0) return;
  if (refund.return_id) {
    const returns = await tx.$queryRaw<{ items: unknown; disposition: unknown }[]>`UPDATE order_returns SET restocked_at=now()
      WHERE account_id=${accountId}::uuid AND id=${refund.return_id}::uuid AND restocked_at IS NULL RETURNING items, disposition`;
    const ret = returns[0];
    if (!ret) return;
    const disposition = (ret.disposition && typeof ret.disposition === 'object' ? ret.disposition : {}) as Record<string, unknown>;
    const items = (Array.isArray(ret.items) ? ret.items : []) as { order_item_id?: unknown; qty?: unknown }[];
    const wanted = items.filter((i) => typeof i.order_item_id === 'string' && disposition[i.order_item_id] === 'restock'
      && Number.isInteger(i.qty) && (i.qty as number) > 0);
    if (!wanted.length) return;
    const variants = await tx.$queryRaw<{ id: string; variant_id: string | null }[]>`SELECT id::text AS id, variant_id::text AS variant_id FROM order_items
      WHERE account_id=${accountId}::uuid AND order_id=${orderId}::uuid AND id = ANY(${wanted.map((w) => w.order_item_id as string)}::uuid[])`;
    const lines = mergeLines(wanted.map((w) => ({ variantId: variants.find((v) => v.id === w.order_item_id)?.variant_id ?? '', quantity: w.qty as number })));
    if (lines.length) await restockTx(tx, accountId, { orderId, lines, kind: 'return_restock', returnId: refund.return_id });
    return;
  }
  const orders = await tx.$queryRaw<{ status: string; dispatched_at: Date | null; refund_state: string | null }[]>`SELECT status,dispatched_at,refund_state
    FROM orders WHERE account_id=${accountId}::uuid AND id=${orderId}::uuid`;
  if (!orders[0] || !orderRestockable(orders[0])) return;
  const sold = await tx.$queryRaw<{ variant_id: string; quantity: number }[]>`SELECT variant_id::text AS variant_id, quantity FROM stock_reservations
    WHERE account_id=${accountId}::uuid AND order_id=${orderId}::uuid AND status='committed'`;
  const lines = mergeLines(sold.map((s) => ({ variantId: s.variant_id, quantity: s.quantity })));
  if (!lines.length) return;
  await restockTx(tx, accountId, { orderId, lines, kind: 'refund_restock' });
  await orderEventTx(tx, accountId, orderId, 'refund_restocked');
}

/** The non-return restock applies only to an order being unwound before dispatch. */
export function orderRestockable(order: { status: string; dispatched_at: Date | null; refund_state: string | null }): boolean {
  if (order.dispatched_at || order.status === 'dispatched' || order.status === 'fulfilled' || order.status === 'delivered') return false;
  return order.status === 'cancelled' || order.refund_state === 'full';
}

function mergeLines(lines: StockLine[]): StockLine[] {
  const merged = new Map<string, number>();
  for (const l of lines) if (UUID.test(l.variantId) && l.quantity > 0) merged.set(l.variantId, (merged.get(l.variantId) ?? 0) + l.quantity);
  return [...merged].map(([variantId, quantity]) => ({ variantId, quantity }));
}

/**
 * Reads every refund Razorpay holds for one gateway payment and applies them:
 * ours by notes.bodhinox_refund_id or provider id, the rest as external.
 * Throws a provider error so the calling job retries.
 */
export async function syncProviderRefunds(accountId: string, providerPaymentId: string): Promise<void> {
  if (!/^pay_[A-Za-z0-9]{1,40}$/.test(providerPaymentId)) return;
  let secrets;
  try {
    secrets = await loadRazorpaySecrets(accountId);
  } catch (error) {
    if (error instanceof PaymentProviderError) return;
    throw error;
  }
  const refunds = await listRefunds({ keyId: secrets.keyId, keySecret: secrets.keySecret, paymentId: providerPaymentId });
  for (const refund of refunds) await applyProviderRefund(accountId, refund);
}

export type ReconcileRefundResult = 'pending' | 'processed' | 'failed' | 'absent' | 'unchanged';

/**
 * Settles an unknown, stale sending or pending refund against Razorpay's list
 * for its payment. Absent (Razorpay holds no refund carrying our id) marks it
 * failed with code 'absent', which is what lets staff retry it. Never sends.
 */
export async function reconcileRefund(accountId: string, refundId: string): Promise<ReconcileRefundResult> {
  if (!UUID.test(refundId)) throw new RefundError('not_found');
  const ctx: TenantContext = { accountId, role: 'owner' };
  const rows = await worker(ctx, (tx) => tx.$queryRaw<{ status: string; updated_at: Date; provider_payment_id: string | null; source: string;
      attempt: number; provider_refund_id: string | null; superseded_provider_refund_ids: string[] }[]>`
    SELECT r.status, r.updated_at, r.source, r.attempt, r.provider_refund_id, r.superseded_provider_refund_ids, p.provider_payment_id FROM customer_refunds r JOIN customer_payments p ON p.account_id=r.account_id AND p.id=r.payment_id
    WHERE r.account_id=${accountId}::uuid AND r.id=${refundId}::uuid`);
  const row = rows[0];
  if (!row) throw new RefundError('not_found');
  const staleSending = row.status === 'sending' && Date.now() - new Date(row.updated_at).getTime() > STALE_SENDING_MS;
  if (!(row.status === 'unknown' || row.status === 'pending' || staleSending)) throw new RefundError('not_reconcilable');
  if (!row.provider_payment_id) throw new RefundError('not_reconcilable');
  let secrets;
  try {
    secrets = await loadRazorpaySecrets(accountId);
  } catch (error) {
    if (error instanceof PaymentProviderError) throw new RefundError('not_connected');
    throw error;
  }
  let list: RazorpayRefund[];
  try {
    list = await listRefunds({ keyId: secrets.keyId, keySecret: secrets.keySecret, paymentId: row.provider_payment_id });
  } catch {
    throw new RefundError('provider_unreachable');
  }
  // Ours is the live attempt's refund, never an earlier attempt's that carries the same bodhinox id.
  const ours = list.find((r) => row.provider_refund_id !== null && r.id === row.provider_refund_id)
    ?? list.find((r) => r.bodhinoxRefundId === refundId && !isStaleAttempt(row, { id: r.id, attempt: attemptOf(r) }));
  // Every other refund on the payment is applied (a dashboard refund, an earlier attempt too), ours last.
  for (const refund of list.filter((r) => r !== ours)) await applyProviderRefund(accountId, refund);
  if (ours) {
    await applyProviderRefund(accountId, ours, refundId);
    return ours.status === 'unknown' ? 'unchanged' : ours.status;
  }
  if (row.status === 'pending') return 'unchanged';
  // Razorpay has none carrying our id: proven absent (the send never reached it). Staff may retry.
  await worker(ctx, async (tx) => {
    const head = await tx.$queryRaw<{ payment_id: string }[]>`SELECT payment_id::text AS payment_id FROM customer_refunds WHERE account_id=${accountId}::uuid AND id=${refundId}::uuid`;
    if (!head[0]) return;
    await lockPayment(tx, accountId, head[0].payment_id);
    const refund = await lockRefund(tx, accountId, refundId);
    if (!refund || !(refund.status === 'unknown' || refund.status === 'sending')) return;
    await tx.$executeRaw`UPDATE customer_refunds SET status='failed', failure_code='absent' WHERE account_id=${accountId}::uuid AND id=${refundId}::uuid`;
    await resolveExceptionsTx(tx, accountId, { subjectKey: `refund:${refundId}` }, 'dismissed', null);
    await openExceptionTx(tx, { accountId, kind: 'refund_failed', subjectKey: `refund:${refundId}`, refundId, paymentId: refund.payment_id, orderId: refund.order_id, detail: 'absent' });
  });
  return 'absent';
}
