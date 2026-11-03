/**
 * Read side of customer payments and refunds for members (app-role tenant
 * transactions; RLS shows rows to agents and above). Fixed projections: ids,
 * amounts, codes and timestamps, never provider or customer text.
 *
 * Reconciliation (design §6): per local day, money captured (every captured
 * payment, gateway or offline, whatever its settlement) and refunds processed
 * (ours and the dashboard's), so net = captured − refunds matches the
 * gateway. T6's commerce analytics uses the same definitions.
 */
import type { TenantTransaction } from '@/lib/db/tenant';
import { minorFromDb } from '@/lib/commerce/money';
import { addDays, localMidnight, workspaceTimezone } from '@/lib/analytics/range';

export interface CustomerPaymentView {
  id: string;
  source: 'razorpay' | 'offline';
  provider_payment_id: string | null;
  payment_link_id: string | null;
  order_id: string | null;
  appointment_id: string | null;
  amount_minor: number;
  refunded_minor: number;
  /** captured − refunded − refunds in flight. */
  refundable_minor: number;
  currency: string;
  status: 'authorized' | 'captured' | 'failed';
  settlement: 'pending' | 'settled' | 'exception' | 'unattached';
  method: string | null;
  offline_reference: string | null;
  recorded_by: string | null;
  captured_at: string | null;
  created_at: string;
}

export interface CustomerRefundView {
  id: string;
  payment_id: string;
  order_id: string | null;
  appointment_id: string | null;
  source: 'bodhinox' | 'external';
  amount_minor: number;
  currency: string;
  reason_code: string;
  note: string | null;
  status: 'requested' | 'sending' | 'pending' | 'processed' | 'failed' | 'unknown';
  failure_code: string | null;
  attempt: number;
  restock: boolean;
  return_id: string | null;
  requested_by: string | null;
  processed_at: string | null;
  created_at: string;
}

const iso = (d: Date | null) => (d ? new Date(d).toISOString() : null);
const n = (v: bigint | number | null) => minorFromDb(v) ?? 0;
const clampLimit = (v: number | undefined) => Math.min(Math.max(Math.trunc(v ?? 50), 1), 100);

export async function listCustomerPayments(tx: TenantTransaction, accountId: string,
  filter: { orderId?: string; appointmentId?: string; settlement?: string; before?: Date; limit?: number } = {}): Promise<CustomerPaymentView[]> {
  const rows = await tx.$queryRaw<(Omit<CustomerPaymentView, 'amount_minor' | 'refunded_minor' | 'refundable_minor' | 'captured_at' | 'created_at'> & {
    amount_minor: bigint; refunded_minor: bigint; inflight: bigint; captured_at: Date | null; created_at: Date })[]>`
    SELECT p.id::text AS id,p.source,p.provider_payment_id,p.payment_link_id::text AS payment_link_id,p.order_id::text AS order_id,
      p.appointment_id::text AS appointment_id,p.amount_minor,p.refunded_minor,p.currency,p.status,p.settlement,p.method,p.offline_reference,
      p.recorded_by::text AS recorded_by,p.captured_at,p.created_at,
      (SELECT COALESCE(sum(r.amount_minor),0) FROM customer_refunds r WHERE r.account_id=p.account_id AND r.payment_id=p.id
        AND r.status IN ('requested','sending','pending','unknown')) AS inflight
    FROM customer_payments p
    WHERE p.account_id=${accountId}::uuid
      AND (${filter.orderId ?? null}::uuid IS NULL OR p.order_id=${filter.orderId ?? null}::uuid)
      AND (${filter.appointmentId ?? null}::uuid IS NULL OR p.appointment_id=${filter.appointmentId ?? null}::uuid)
      AND (${filter.settlement ?? null}::text IS NULL OR p.settlement=${filter.settlement ?? null})
      AND (${filter.before ?? null}::timestamptz IS NULL OR p.created_at<${filter.before ?? null}::timestamptz)
    ORDER BY p.created_at DESC, p.id DESC LIMIT ${clampLimit(filter.limit)}`;
  return rows.map((r) => ({
    id: r.id, source: r.source, provider_payment_id: r.provider_payment_id, payment_link_id: r.payment_link_id, order_id: r.order_id,
    appointment_id: r.appointment_id, amount_minor: n(r.amount_minor), refunded_minor: n(r.refunded_minor),
    refundable_minor: r.status === 'captured' && r.source === 'razorpay' ? Math.max(0, n(r.amount_minor) - n(r.refunded_minor) - n(r.inflight)) : 0,
    currency: r.currency, status: r.status, settlement: r.settlement, method: r.method, offline_reference: r.offline_reference,
    recorded_by: r.recorded_by, captured_at: iso(r.captured_at), created_at: iso(r.created_at)!,
  }));
}

export async function listCustomerRefunds(tx: TenantTransaction, accountId: string,
  filter: { orderId?: string; paymentId?: string; status?: string; before?: Date; limit?: number } = {}): Promise<CustomerRefundView[]> {
  const rows = await tx.$queryRaw<(Omit<CustomerRefundView, 'amount_minor' | 'processed_at' | 'created_at'> & { amount_minor: bigint; processed_at: Date | null; created_at: Date })[]>`
    SELECT id::text AS id,payment_id::text AS payment_id,order_id::text AS order_id,appointment_id::text AS appointment_id,source,amount_minor,currency,
      reason_code,note,status,failure_code,attempt,restock,return_id::text AS return_id,requested_by::text AS requested_by,processed_at,created_at
    FROM customer_refunds
    WHERE account_id=${accountId}::uuid
      AND (${filter.orderId ?? null}::uuid IS NULL OR order_id=${filter.orderId ?? null}::uuid)
      AND (${filter.paymentId ?? null}::uuid IS NULL OR payment_id=${filter.paymentId ?? null}::uuid)
      AND (${filter.status ?? null}::text IS NULL OR status=${filter.status ?? null})
      AND (${filter.before ?? null}::timestamptz IS NULL OR created_at<${filter.before ?? null}::timestamptz)
    ORDER BY created_at DESC, id DESC LIMIT ${clampLimit(filter.limit)}`;
  return rows.map((r) => ({ ...r, amount_minor: n(r.amount_minor), processed_at: iso(r.processed_at), created_at: iso(r.created_at)! }));
}

export interface ReconciliationDay {
  /** Local day (YYYY-MM-DD) in the workspace timezone. */
  day: string;
  currency: string;
  captured_minor: number;
  captured_count: number;
  refunds_minor: number;
  refunds_count: number;
  /** Of refunds_minor, made in the Razorpay dashboard. */
  external_refunds_minor: number;
  net_minor: number;
}

export interface ReconciliationReport {
  from: string;
  to: string;
  timezone: string;
  days: ReconciliationDay[];
  totals: Omit<ReconciliationDay, 'day'>[];
  open_exceptions: number;
  /** Refunds whose outcome is not yet known (unknown, or still sending). */
  unresolved_refunds: number;
}

export const MAX_REPORT_DAYS = 92;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

export class ReportRangeError extends Error {
  constructor() {
    super('invalid_range');
    this.name = 'ReportRangeError';
  }
}

/** Per local day and currency, inclusive of both days. */
export async function reconciliationReport(tx: TenantTransaction, accountId: string, range: { from: string; to: string }): Promise<ReconciliationReport> {
  if (!DAY.test(range.from) || !DAY.test(range.to) || range.from > range.to) throw new ReportRangeError();
  const tz = await workspaceTimezone(tx, accountId);
  const start = localMidnight(range.from, tz);
  const end = localMidnight(addDays(range.to, 1), tz);
  if (end.getTime() - start.getTime() > MAX_REPORT_DAYS * 86_400_000 + 7_200_000) throw new ReportRangeError();
  const rows = await tx.$queryRaw<{ day: string; currency: string; captured: bigint; captured_n: number; refunds: bigint; refunds_n: number; external: bigint }[]>`
    WITH cap AS (
      SELECT to_char((captured_at AT TIME ZONE ${tz}), 'YYYY-MM-DD') AS day, currency, sum(amount_minor) AS amount, count(*)::int AS n
      FROM customer_payments WHERE account_id=${accountId}::uuid AND status='captured' AND captured_at>=${start} AND captured_at<${end}
      GROUP BY 1,2
    ), ref AS (
      SELECT to_char((processed_at AT TIME ZONE ${tz}), 'YYYY-MM-DD') AS day, currency, sum(amount_minor) AS amount, count(*)::int AS n,
        sum(amount_minor) FILTER (WHERE source='external') AS external
      FROM customer_refunds WHERE account_id=${accountId}::uuid AND status='processed' AND processed_at>=${start} AND processed_at<${end}
      GROUP BY 1,2
    )
    SELECT COALESCE(c.day,r.day) AS day, COALESCE(c.currency,r.currency) AS currency,
      COALESCE(c.amount,0) AS captured, COALESCE(c.n,0) AS captured_n, COALESCE(r.amount,0) AS refunds, COALESCE(r.n,0) AS refunds_n,
      COALESCE(r.external,0) AS external
    FROM cap c FULL JOIN ref r ON r.day=c.day AND r.currency=c.currency
    ORDER BY 1 DESC, 2`;
  const days: ReconciliationDay[] = rows.map((r) => ({
    day: r.day, currency: r.currency, captured_minor: n(r.captured), captured_count: r.captured_n, refunds_minor: n(r.refunds),
    refunds_count: r.refunds_n, external_refunds_minor: n(r.external), net_minor: n(r.captured) - n(r.refunds),
  }));
  const totals = new Map<string, Omit<ReconciliationDay, 'day'>>();
  for (const d of days) {
    const t = totals.get(d.currency) ?? { currency: d.currency, captured_minor: 0, captured_count: 0, refunds_minor: 0, refunds_count: 0, external_refunds_minor: 0, net_minor: 0 };
    t.captured_minor += d.captured_minor; t.captured_count += d.captured_count; t.refunds_minor += d.refunds_minor;
    t.refunds_count += d.refunds_count; t.external_refunds_minor += d.external_refunds_minor; t.net_minor += d.net_minor;
    totals.set(d.currency, t);
  }
  const counts = await tx.$queryRaw<{ exceptions: number; refunds: number }[]>`SELECT
    (SELECT count(*)::int FROM payment_exceptions WHERE account_id=${accountId}::uuid AND status='open') AS exceptions,
    (SELECT count(*)::int FROM customer_refunds WHERE account_id=${accountId}::uuid AND status IN ('unknown','sending')) AS refunds`;
  return { from: range.from, to: range.to, timezone: tz, days, totals: [...totals.values()], open_exceptions: counts[0]?.exceptions ?? 0, unresolved_refunds: counts[0]?.refunds ?? 0 };
}
