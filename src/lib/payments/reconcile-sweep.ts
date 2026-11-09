/**
 * payments.reconcile_sweep (design §3, T4): every 10 minutes, per workspace,
 * reconcile unknown and stale creating links, links expired more than five
 * minutes ago, paid links whose payment is not yet settled (a crash between
 * the link update and settlement, or a provider outage), live links older than
 * 30 minutes whose payment_link.paid webhook may never have arrived (audit
 * finding 54: a wrong secret, a missing event subscription or a disabled
 * webhook; links with no expiry included), with a back-off, and unknown or
 * stale sending refunds. Never re-sends a refund and never creates a link that
 * Razorpay may already hold (reconcile looks it up by reference first).
 */
import { getWorkerPrisma } from '@/lib/db/prisma';
import { withTenant } from '@/lib/db/tenant';
import { loadRazorpaySecrets, PaymentProviderError } from './providers';
import { reconcilePaymentLink, STALE_CREATING_MS } from './links';
import { reconcileRefund, RefundError, STALE_SENDING_MS } from './refunds';

export const RECONCILE_SWEEP_JOB = 'payments.reconcile_sweep';
export const SWEEP_INTERVAL_MS = 10 * 60_000;
/** Rows per kind per sweep: a backlog drains over several sweeps instead of one long job. */
const BATCH = 50;
/** Refunds merely still pending at Razorpay (the webhook usually settles them): a smaller share per sweep. */
const PENDING_BATCH = 20;
/** Live (created / partially paid) links are first re-read this long after creation. */
export const LIVE_LINK_MIN_AGE_MS = 30 * 60_000;
/** A live link is re-read again after a quarter of its age, but at least this often. */
export const LIVE_LINK_MAX_BACKOFF_MS = 6 * 60 * 60_000;

let lastSchedule = Number.NEGATIVE_INFINITY;
let missingFunctionLogged = false;

/**
 * Queue one sweep job per workspace with payment work (dedupe
 * rsweep:<acct>:<slot>). Called by scheduleWork on every worker tick; acts at
 * most once per interval per process, and the dedupe key makes concurrent
 * workers queue each slot once.
 */
export async function scheduleReconcileSweeps(now: number = Date.now(), force = false): Promise<number> {
  if (!force && now - lastSchedule < SWEEP_INTERVAL_MS) return 0;
  let accounts: { account_id: string }[];
  try {
    accounts = await getWorkerPrisma().$queryRaw<{ account_id: string }[]>`SELECT account_id::text AS account_id FROM crm_accounts_for_payment_reconcile()`;
  } catch (error) {
    // Until the definer function's migration is applied there is nothing to enumerate workspaces with.
    if (/crm_accounts_for_payment_reconcile|42883/.test(error instanceof Error ? error.message : '')) {
      if (!missingFunctionLogged) console.error('[payments] reconcile sweep function missing');
      missingFunctionLogged = true;
      lastSchedule = now;
      return 0;
    }
    throw error;
  }
  const slot = Math.floor(now / SWEEP_INTERVAL_MS);
  for (const { account_id } of accounts) {
    await getWorkerPrisma().$executeRaw`INSERT INTO jobs(type,tenant_id,payload,dedupe_key,max_attempts)
      VALUES(${RECONCILE_SWEEP_JOB},${account_id}::uuid,'{}'::jsonb,${`rsweep:${account_id}:${slot}`},2)
      ON CONFLICT(dedupe_key) DO NOTHING`;
  }
  lastSchedule = now;
  return accounts.length;
}

/** Test hook. */
export function resetReconcileScheduleForTests(): void {
  lastSchedule = Number.NEGATIVE_INFINITY;
}

export interface SweepSummary {
  links: number;
  refunds: number;
  failures: number;
}

/** One workspace's sweep. A single row's failure is counted and left for the next sweep. */
export async function runReconcileSweep(accountId: string): Promise<SweepSummary> {
  const summary: SweepSummary = { links: 0, refunds: 0, failures: 0 };
  try {
    await loadRazorpaySecrets(accountId);
  } catch (error) {
    if (error instanceof PaymentProviderError) return summary;
    throw error;
  }
  // Each class has its own limit, and rows are taken in random order within it: a row that keeps reconciling to
  // 'unchanged' (a refund still pending at Razorpay, a paid link skipped as merchant_changed) is never updated, so
  // ordering by updated_at would put the same rows first on every sweep and starve the rest.
  const { links, refunds } = await withTenant({ accountId, role: 'owner' }, async (tx) => {
    const unclearLinks = await tx.$queryRaw<{ id: string }[]>`
      SELECT l.id::text AS id FROM payment_links l
      WHERE l.account_id=${accountId}::uuid AND (
        l.status='unknown'
        OR (l.status='creating' AND l.updated_at < now() - (${STALE_CREATING_MS}::int * interval '1 millisecond'))
        OR (l.status IN ('created','partially_paid') AND l.expires_at IS NOT NULL AND l.expires_at < now() - interval '5 minutes')
      )
      ORDER BY random() LIMIT ${BATCH}`;
    // Live links the webhook should have settled if they were paid: re-read at Razorpay with a back-off (a quarter
    // of the link's age, at most LIVE_LINK_MAX_BACKOFF_MS), so a paid link is noticed without its webhook and a link
    // with no expiry is still looked at. The check time is stamped as the rows are taken, so a link still open at
    // Razorpay (reconciled as unchanged) waits for its back-off instead of being re-read every sweep.
    const liveLinks = await tx.$queryRaw<{ id: string }[]>`
      UPDATE payment_links SET reconcile_checked_at=now()
      WHERE account_id=${accountId}::uuid AND id IN (
        SELECT l.id FROM payment_links l
        WHERE l.account_id=${accountId}::uuid AND l.status IN ('created','partially_paid')
          AND l.created_at < now() - (${LIVE_LINK_MIN_AGE_MS}::int * interval '1 millisecond')
          AND (l.expires_at IS NULL OR l.expires_at >= now() - interval '5 minutes')
          AND (l.reconcile_checked_at IS NULL OR l.reconcile_checked_at < now()
            - LEAST((now() - l.created_at) / 4, ${LIVE_LINK_MAX_BACKOFF_MS}::int * interval '1 millisecond'))
        ORDER BY random() LIMIT ${BATCH}
        FOR UPDATE SKIP LOCKED)
      RETURNING id::text AS id`;
    const paidLinks = await tx.$queryRaw<{ id: string }[]>`
      SELECT l.id::text AS id FROM payment_links l
      WHERE l.account_id=${accountId}::uuid AND l.status='paid'
        AND (l.order_id IS NOT NULL OR l.appointment_id IS NOT NULL OR l.updated_at > now() - interval '7 days')
        AND l.updated_at > now() - interval '30 days'
        AND NOT EXISTS (SELECT 1 FROM customer_payments p WHERE p.account_id=l.account_id AND p.payment_link_id=l.id
          AND p.status='captured' AND p.settlement<>'pending')
      ORDER BY random() LIMIT ${BATCH}`;
    // Ambiguous sends first: an unknown or stale sending refund blocks retries and holds an exception open.
    const unclearRefunds = await tx.$queryRaw<{ id: string }[]>`
      SELECT id::text AS id FROM customer_refunds
      WHERE account_id=${accountId}::uuid AND (
        status='unknown' OR (status='sending' AND updated_at < now() - (${STALE_SENDING_MS}::int * interval '1 millisecond'))
      )
      ORDER BY random() LIMIT ${BATCH}`;
    const pendingRefunds = await tx.$queryRaw<{ id: string }[]>`
      SELECT id::text AS id FROM customer_refunds
      WHERE account_id=${accountId}::uuid AND status='pending' AND updated_at < now() - interval '1 hour'
      ORDER BY random() LIMIT ${PENDING_BATCH}`;
    return { links: [...unclearLinks, ...liveLinks, ...paidLinks], refunds: [...unclearRefunds, ...pendingRefunds] };
  }, getWorkerPrisma());

  for (const { id } of links) {
    try {
      await reconcilePaymentLink(accountId, id);
      summary.links += 1;
    } catch {
      summary.failures += 1;
    }
  }
  for (const { id } of refunds) {
    try {
      await reconcileRefund(accountId, id);
      summary.refunds += 1;
    } catch (error) {
      // Settled meanwhile (an earlier row's reconcile applied the same payment's refund list).
      if (error instanceof RefundError && error.code === 'not_reconcilable') continue;
      summary.failures += 1;
    }
  }
  if (summary.failures) console.error('[payments] reconcile sweep left rows for the next run', { failures: summary.failures });
  return summary;
}
