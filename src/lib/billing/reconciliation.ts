// SaaS billing reconciliation items (Phase 14). Server only.
//
// billing_reconciliation_items is a platform table: the worker opens an item
// for an operator, the platform console lists and resolves it. Producers:
//   event_error        a billing webhook event that could not be applied (markEvent)
//   intent_unknown     a provider call still 'unknown' 24 h after the sweep's reconcile attempt
//   invoice_unissued   a paid charge whose GST invoice could not be issued
//   state_mismatch     the daily billing.reconcile fetch disagrees with the stored subscription
//   shared_razorpay_key  opened by crm_platform_integration_health (a commerce key equal to the platform key)
// Each is inserted ON CONFLICT (kind, source_ref) DO NOTHING, in the producer's
// own transaction; nothing re-opens a resolved item automatically.
//
// billing.reconcile only reads: it never writes a subscription and never
// closes an intent. "Re-fetch from provider" in the console queues the
// existing billing.lifecycle_sweep, which is fetch-then-apply and safe to repeat.
// detail carries ids, statuses, plan ids, dates and amounts only.

import { getWorkerPrisma } from '@/lib/db/prisma';
import { withTenant, type TenantTransaction } from '@/lib/db/tenant';
import type { ReconciliationKind } from '@/types/platform';
import { applySnapshot, type ProviderSnapshot, type SubscriptionRow } from './lifecycle';
import type { BillingProvider } from './provider';
import { billingConfigured, getBillingProvider } from './razorpay-billing';

export const BILLING_RECONCILE_JOB = 'billing.reconcile';
/** An intent still 'unknown' this long after it was created needs an operator. */
export const INTENT_UNKNOWN_AFTER_MS = 24 * 3_600_000;
/** Period ends closer than this are the same (provider timestamps are whole seconds). */
const PERIOD_TOLERANCE_MS = 60_000;
const SCHEDULE_EVERY_MS = 60 * 60_000;

type Executor = { $executeRaw: (query: TemplateStringsArray, ...values: unknown[]) => Promise<number> };

/** Opens one item (idempotent per kind + source); true when newly opened. */
export async function openReconciliationItem(
  db: Executor,
  item: { accountId: string | null; kind: ReconciliationKind; sourceRef: string; detail?: Record<string, unknown> },
): Promise<boolean> {
  const sourceRef = item.sourceRef.slice(0, 200);
  const inserted = await db.$executeRaw`
    INSERT INTO billing_reconciliation_items (account_id, kind, source_ref, detail)
    VALUES (${item.accountId}::uuid, ${item.kind}, ${sourceRef}, ${JSON.stringify(item.detail ?? {})}::jsonb)
    ON CONFLICT (kind, source_ref) DO NOTHING`;
  return inserted > 0;
}

/** The IST calendar day (YYYY-MM-DD), matching usagePeriod's timezone. */
export function istDay(now: Date): string {
  return new Date(now.getTime() + 330 * 60_000).toISOString().slice(0, 10);
}

const isoOrNull = (d: Date | null) => (d ? d.toISOString() : null);

/**
 * What differs between the stored subscription and the provider's state, or
 * null when they agree. Uses the same state machine the webhook and sweep
 * apply (applySnapshot), so our own steps (grace -> suspended, an overdue
 * trial moved to grace) are not reported as differences.
 */
export function stateDifference(row: SubscriptionRow, snap: ProviderSnapshot, now: Date): Record<string, unknown> | null {
  const provider = { plan: snap.planId, status: snap.status, interval: snap.interval, period_end: isoOrNull(snap.currentEnd) };
  const stored = { plan: row.planId, status: row.status, interval: row.interval, period_end: isoOrNull(row.currentPeriodEnd) };
  const base = { subscription_id: snap.subscriptionId, stored, provider };
  if (snap.status === null) return { ...base, reason: 'unknown_state' };
  if (snap.planId === null) return { ...base, reason: 'unmapped_plan' };
  const t = applySnapshot(row, snap, now);
  if (!t) return null;
  const fields: string[] = [];
  if (t.next.planId !== row.planId) fields.push('plan');
  if (t.next.status !== row.status) fields.push('status');
  if (t.next.interval !== row.interval) fields.push('interval');
  const a = t.next.currentPeriodEnd?.getTime() ?? null, b = row.currentPeriodEnd?.getTime() ?? null;
  if ((a === null) !== (b === null) || (a !== null && b !== null && Math.abs(a - b) > PERIOD_TOLERANCE_MS)) fields.push('period_end');
  return fields.length ? { ...base, reason: 'differs', fields } : null;
}

const worker = <T>(accountId: string, fn: (tx: TenantTransaction) => Promise<T>) =>
  withTenant({ accountId, role: 'owner' }, fn, getWorkerPrisma());

let lastSchedule = Number.NEGATIVE_INFINITY;

/**
 * Queues one billing.reconcile per workspace with a live provider subscription
 * per IST day; 0 while billing is off.
 */
export async function scheduleBillingReconcile(now: number = Date.now()): Promise<number> {
  if (!billingConfigured() || now - lastSchedule < SCHEDULE_EVERY_MS) return 0;
  const db = getWorkerPrisma();
  // Every live provider subscription (definer function: the worker cannot list
  // account_subscriptions across workspaces).
  const rows = await db.$queryRaw<{ account_id: string }[]>`SELECT account_id FROM crm_accounts_for_billing_reconcile()`;
  const day = istDay(new Date(now));
  for (const { account_id } of rows)
    await db.$executeRaw`INSERT INTO jobs(type,tenant_id,payload,dedupe_key,max_attempts)
      VALUES(${BILLING_RECONCILE_JOB},${account_id}::uuid,'{}'::jsonb,${`billing-reconcile:${account_id}:${day}`},3)
      ON CONFLICT(dedupe_key) DO NOTHING`;
  lastSchedule = now;
  return rows.length;
}

/** Test hook. */
export function resetBillingReconcileScheduleForTests(): void {
  lastSchedule = Number.NEGATIVE_INFINITY;
}

/**
 * Fetches provider state and opens a state_mismatch item (one per subscription
 * per IST day) on any difference. Changes nothing else. Skipped while a
 * provider call of the workspace is still being confirmed (the sweep and the
 * intent_unknown item cover that).
 */
export async function runBillingReconcile(accountId: string, provider: BillingProvider | null = getBillingProvider(), now: Date = new Date()): Promise<void> {
  if (!provider) return;
  // Loaded lazily: subscriptions.ts imports this module for its producers.
  const { readSubscription, providerSnapshot } = await import('./subscriptions');
  const before = await worker(accountId, (tx) => readSubscription(tx, accountId));
  if (!before?.providerSubscriptionId || before.status === 'cancelled') return;
  const fetched = await provider.fetchSubscription(before.providerSubscriptionId);
  // A read: the job retries through its own backoff.
  if (fetched.outcome === 'unknown') throw new Error('Billing provider unavailable');
  await worker(accountId, async (tx) => {
    const row = await readSubscription(tx, accountId);
    if (!row || row.providerSubscriptionId !== before.providerSubscriptionId) return;
    const open = await tx.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM billing_intents
      WHERE account_id=${accountId}::uuid AND status IN ('pending','unknown')`;
    if ((open[0]?.n ?? 0) > 0) return;
    const detail = fetched.outcome === 'rejected'
      ? { subscription_id: row.providerSubscriptionId, reason: 'fetch_rejected', http_status: fetched.httpStatus,
          stored: { plan: row.planId, status: row.status, interval: row.interval, period_end: isoOrNull(row.currentPeriodEnd) } }
      : stateDifference(row, await providerSnapshot(tx, fetched.value), now);
    if (detail)
      await openReconciliationItem(tx, { accountId, kind: 'state_mismatch', sourceRef: `${row.providerSubscriptionId}:${istDay(now)}`, detail });
  });
}
