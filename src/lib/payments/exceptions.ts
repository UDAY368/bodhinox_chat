/**
 * The payment exception queue (design E9): payments that must not settle
 * silently, and refunds whose outcome needs a person. Admins read and resolve
 * them. A payment that is held (late, closed order, duplicate, mismatch) is
 * resolved only by refunding it, or, for a late payment that found no stock,
 * by restocking and accepting it; the others (merchant changed, unmatched,
 * refund unknown or failed) are dismissed once handled.
 */
import { getWorkerPrisma } from '@/lib/db/prisma';
import { withTenant, type TenantContext, type TenantTransaction } from '@/lib/db/tenant';
import { hasMinRole } from '@/lib/auth/roles';
import { ForbiddenError } from '@/lib/auth/errors';
import { getT } from '@/lib/i18n/translate';
import { minorFromDb } from '@/lib/commerce/money';
import { creditOrderTx, lockOrderTx, orderDue } from './settle';
import { auditTx, EXCEPTION_KINDS, resolveExceptionsTx, UUID, type ExceptionKind } from './ledger';
import { selectLink } from './links';

export const RESOLUTIONS = ['refunded', 'restocked', 'accepted', 'dismissed'] as const;
export type Resolution = (typeof RESOLUTIONS)[number];

/** Kinds that hold the customer's money: only a full refund (or restock-and-accept) closes them. */
const HOLDS_MONEY: ReadonlySet<ExceptionKind> = new Set([
  'late_payment_no_stock', 'late_payment_slot_lost', 'payment_on_closed_order', 'duplicate_payment', 'amount_mismatch', 'currency_mismatch',
]);

/** The resolutions an admin may choose for a kind (the UI offers exactly these). */
export function allowedResolutions(kind: ExceptionKind): Resolution[] {
  if (kind === 'late_payment_no_stock') return ['refunded', 'restocked'];
  if (HOLDS_MONEY.has(kind)) return ['refunded'];
  return ['dismissed'];
}

export interface PaymentExceptionView {
  id: string;
  kind: ExceptionKind;
  status: 'open' | 'resolved';
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

interface ExceptionRow {
  id: string; kind: ExceptionKind; status: 'open' | 'resolved'; resolution: Resolution | null; detail: string | null;
  order_id: string | null; payment_id: string | null; refund_id: string | null; appointment_id: string | null; payment_link_id: string | null;
  amount_minor: bigint | number | null; currency: string | null; resolved_by: string | null; resolved_at: Date | null; created_at: Date;
}

const iso = (d: Date | null) => (d ? new Date(d).toISOString() : null);

/** Newest first; `tx` is an app-role tenant transaction (RLS: agent and above read; the route requires admin). */
export async function listPaymentExceptions(tx: TenantTransaction, accountId: string, filter: { status?: 'open' | 'resolved'; orderId?: string; before?: Date; limit?: number } = {}): Promise<PaymentExceptionView[]> {
  const limit = Math.min(Math.max(Math.trunc(filter.limit ?? 50), 1), 100);
  const rows = await tx.$queryRaw<ExceptionRow[]>`
    SELECT e.id::text AS id,e.kind,e.status,e.resolution,e.detail,e.order_id::text AS order_id,e.payment_id::text AS payment_id,
      e.refund_id::text AS refund_id,e.appointment_id::text AS appointment_id,e.payment_link_id::text AS payment_link_id,
      COALESCE(r.amount_minor,p.amount_minor) AS amount_minor, COALESCE(r.currency,p.currency) AS currency,
      e.resolved_by::text AS resolved_by,e.resolved_at,e.created_at
    FROM payment_exceptions e
      LEFT JOIN customer_payments p ON p.account_id=e.account_id AND p.id=e.payment_id
      LEFT JOIN customer_refunds r ON r.account_id=e.account_id AND r.id=e.refund_id
    WHERE e.account_id=${accountId}::uuid
      AND (${filter.status ?? null}::text IS NULL OR e.status=${filter.status ?? null})
      AND (${filter.orderId ?? null}::uuid IS NULL OR e.order_id=${filter.orderId ?? null}::uuid)
      AND (${filter.before ?? null}::timestamptz IS NULL OR e.created_at<${filter.before ?? null}::timestamptz)
    ORDER BY e.created_at DESC, e.id DESC LIMIT ${limit}`;
  return rows.map((r) => ({
    id: r.id, kind: r.kind, status: r.status, resolution: r.resolution, detail: r.detail, order_id: r.order_id, payment_id: r.payment_id,
    refund_id: r.refund_id, appointment_id: r.appointment_id, payment_link_id: r.payment_link_id,
    amount_minor: minorFromDb(r.amount_minor), currency: r.currency, allowed_resolutions: r.status === 'open' ? allowedResolutions(r.kind) : [],
    resolved_by: r.resolved_by, resolved_at: iso(r.resolved_at), created_at: iso(r.created_at)!,
  }));
}

export type ExceptionErrorCode = 'not_found' | 'not_open' | 'invalid_resolution' | 'not_refunded' | 'out_of_stock' | 'not_payable';
const ERROR_STATUS: Record<ExceptionErrorCode, number> = { not_found: 404, not_open: 409, invalid_resolution: 400, not_refunded: 409, out_of_stock: 409, not_payable: 409 };

export class ExceptionError extends Error {
  readonly status: number;
  constructor(readonly code: ExceptionErrorCode) {
    super(getT('Payments.exceptions.errors')(code));
    this.name = 'ExceptionError';
    this.status = ERROR_STATUS[code];
  }
}

/**
 * Resolves one open exception (admin). 'refunded' requires the payment to be
 * fully refunded already (Refund first); 'restocked' takes the stock back and
 * credits a late payment exactly as settlement would have.
 */
export async function resolvePaymentException(ctx: TenantContext & { userId: string }, exceptionId: string, resolution: Resolution): Promise<void> {
  if (!ctx.role || !hasMinRole(ctx.role, 'admin')) throw new ForbiddenError('Insufficient workspace role');
  if (!UUID.test(exceptionId)) throw new ExceptionError('not_found');
  if (!(RESOLUTIONS as readonly string[]).includes(resolution)) throw new ExceptionError('invalid_resolution');
  await withTenant(ctx, async (tx) => {
    const heads = await tx.$queryRaw<{ payment_id: string | null }[]>`SELECT payment_id::text AS payment_id FROM payment_exceptions
      WHERE account_id=${ctx.accountId}::uuid AND id=${exceptionId}::uuid`;
    if (!heads[0]) throw new ExceptionError('not_found');
    // Lock order: payment -> exception -> order.
    const payments = heads[0].payment_id ? await tx.$queryRaw<{ id: string; amount_minor: bigint | number; refunded_minor: bigint | number; settlement: string; payment_link_id: string | null }[]>`
      SELECT id::text AS id,amount_minor,refunded_minor,settlement,payment_link_id::text AS payment_link_id FROM customer_payments
      WHERE account_id=${ctx.accountId}::uuid AND id=${heads[0].payment_id}::uuid FOR UPDATE` : [];
    const rows = await tx.$queryRaw<{ kind: ExceptionKind; status: string; order_id: string | null; subject_key: string }[]>`
      SELECT kind,status,order_id::text AS order_id,subject_key FROM payment_exceptions WHERE account_id=${ctx.accountId}::uuid AND id=${exceptionId}::uuid FOR UPDATE`;
    const exception = rows[0];
    if (!exception) throw new ExceptionError('not_found');
    if (exception.status !== 'open') throw new ExceptionError('not_open');
    if (!allowedResolutions(exception.kind).includes(resolution)) throw new ExceptionError('invalid_resolution');
    const payment = payments[0];
    if (resolution === 'refunded' && (!payment || minorFromDb(payment.refunded_minor) !== minorFromDb(payment.amount_minor))) throw new ExceptionError('not_refunded');
    if (resolution === 'restocked') {
      if (!payment || !exception.order_id || minorFromDb(payment.refunded_minor) !== 0) throw new ExceptionError('not_payable');
      // A refund still in flight (requested, sending, pending at Razorpay, or unknown) may yet return the money:
      // crediting now would ship goods the customer is being refunded for. The payment row lock keeps a new refund out.
      const inflight = await tx.$queryRaw<{ n: bigint | number }[]>`SELECT count(*) AS n FROM customer_refunds
        WHERE account_id=${ctx.accountId}::uuid AND payment_id=${payment.id}::uuid AND status IN ('requested','sending','pending','unknown')`;
      if (Number(inflight[0]?.n ?? 0) > 0) throw new ExceptionError('not_payable');
      const order = await lockOrderTx(tx, ctx.accountId, exception.order_id);
      if (!order || order.status !== 'payment_review' ) throw new ExceptionError('not_payable');
      const amount = minorFromDb(payment.amount_minor) ?? 0;
      if (amount !== orderDue(order)) throw new ExceptionError('not_payable');
      const link = payment.payment_link_id ? await selectLink(tx, ctx.accountId, { id: payment.payment_link_id }) : null;
      const credited = await creditOrderTx(tx, { accountId: ctx.accountId, order, paymentId: payment.id, amountMinor: amount, link, late: true, actorUserId: ctx.userId });
      if (!credited) throw new ExceptionError('out_of_stock');
    }
    await tx.$executeRaw`UPDATE payment_exceptions SET status='resolved', resolution=${resolution}, resolved_by=${ctx.userId}::uuid, resolved_at=now()
      WHERE account_id=${ctx.accountId}::uuid AND id=${exceptionId}::uuid`;
    await auditTx(tx, ctx.accountId, ctx.userId, 'commerce.payment_exception_resolved', exceptionId, { kind: exception.kind, resolution });
  }, getWorkerPrisma());
}

export { EXCEPTION_KINDS, resolveExceptionsTx };
