// Current usage against each plan limit, for the Plan & usage panel and limit checks.
// Monthly metrics use the calendar month in India time (Asia/Kolkata), the same
// period usage_counters and billing_increment_usage use.

import type { TenantTransaction } from '@/lib/db/tenant';
import type { LimitKey } from './entitlements';

export type UsageKey = Exclude<LimitKey, 'campaign_recipients'>;
/** Metered counters kept in usage_counters. */
export const USAGE_METRICS = ['ai_messages', 'monthly_active_contacts', 'storage_bytes'] as const;
export type UsageMetric = (typeof USAGE_METRICS)[number];

const BILLING_TIME_ZONE = 'Asia/Kolkata';

/** The usage period ('YYYY-MM') a moment falls in, in India time. */
export function usagePeriod(at: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: BILLING_TIME_ZONE, year: 'numeric', month: '2-digit' }).formatToParts(at);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}`;
}

/**
 * Adds `by` to this workspace's counter for the current period and returns the
 * new total. Atomic under concurrency (one upsert); the workspace is the
 * transaction's tenant. Call it inside withTenant, in the same transaction as
 * the work it meters, so a rollback also un-counts it.
 */
export async function incrementUsage(tx: TenantTransaction, metric: UsageMetric, by = 1): Promise<number> {
  if (!USAGE_METRICS.includes(metric)) throw new Error('Unknown usage metric');
  if (!Number.isSafeInteger(by) || by <= 0) throw new Error('Usage increment must be a positive integer');
  const [row] = await tx.$queryRaw<{ value: bigint }[]>`SELECT billing_increment_usage(${metric}, ${by}::bigint) AS value`;
  return Number(row.value);
}

/**
 * Counted the same way the limits are enforced (archived segments and lists do not count). campaign_recipients is per campaign, so it has no running total.
 * storage_bytes counts member uploads only: inbound customer media the worker mirrors (chat-media, account-<id>/inbound/) is never refused, so it never
 * counts against the plan. whatsapp_numbers counts connected numbers and ones mid-setup; a number an admin removed (token cleared) frees its slot.
 */
export async function currentUsage(tx: TenantTransaction, accountId: string): Promise<Record<UsageKey, number>> {
  const period = usagePeriod();
  const [row] = await tx.$queryRaw<(Omit<Record<UsageKey, number>, 'storage_bytes' | 'ai_messages' | 'monthly_active_contacts'> & { storage_bytes: bigint; ai_messages: bigint })[]>`
    SELECT
      (SELECT count(*)::int FROM account_memberships m WHERE m.account_id=${accountId}::uuid)
        + (SELECT count(*)::int FROM account_invitations i WHERE i.account_id=${accountId}::uuid AND i.accepted_at IS NULL AND i.expires_at > now()) AS seats,
      (SELECT count(*)::int FROM segments s WHERE s.account_id=${accountId}::uuid AND s.archived_at IS NULL) AS segments,
      (SELECT count(*)::int FROM contact_lists l WHERE l.account_id=${accountId}::uuid AND l.archived_at IS NULL) AS lists,
      (SELECT count(*)::int FROM flows f WHERE f.account_id=${accountId}::uuid
        AND (f.status='active' OR (f.status='draft' AND cardinality(f.test_numbers)>0))) AS active_flows,
      (SELECT count(*)::int FROM automations a WHERE a.account_id=${accountId}::uuid AND a.is_active) AS active_automations,
      (SELECT COALESCE(max(u.value), 0)::bigint FROM usage_counters u
        WHERE u.account_id=${accountId}::uuid AND u.metric='ai_messages' AND u.period=${period}) AS ai_messages,
      (SELECT COALESCE(sum(o.byte_size), 0)::bigint FROM media_objects o
        WHERE o.account_id=${accountId}::uuid AND o.deleted_at IS NULL
          AND NOT (o.bucket='chat-media' AND o.object_key LIKE 'account-' || o.account_id::text || '/inbound/%')) AS storage_bytes,
      (SELECT count(*)::int FROM whatsapp_config w WHERE w.account_id=${accountId}::uuid
        AND NOT (w.status='disconnected' AND w.access_token='')) AS whatsapp_numbers`;
  return { ...row, ai_messages: Number(row.ai_messages), storage_bytes: Number(row.storage_bytes),
    monthly_active_contacts: await monthlyActiveContacts(tx, accountId) };
}

/** How long a computed monthly-active-contacts count is reused. */
export const ACTIVE_CONTACTS_CACHE_MS = 10 * 60 * 1000;

/** True when a meter value computed at `updatedAt` may still be used at `now`. */
export function meterIsFresh(updatedAt: Date | null | undefined, now: Date = new Date(), maxAgeMs = ACTIVE_CONTACTS_CACHE_MS): boolean {
  if (!(updatedAt instanceof Date)) return false;
  const age = now.getTime() - updatedAt.getTime();
  return age >= 0 && age < maxAgeMs;
}

/**
 * Distinct contacts with any message (inbound or outbound) since the IST month
 * began. Kept per period in usage_counters and recomputed at most every
 * ACTIVE_CONTACTS_CACHE_MS, so reading the panel stays cheap.
 */
export async function monthlyActiveContacts(tx: TenantTransaction, accountId: string, now: Date = new Date()): Promise<number> {
  const period = usagePeriod(now);
  const [cached] = await tx.$queryRaw<{ value: bigint; updated_at: Date }[]>`SELECT value, updated_at FROM usage_counters
    WHERE account_id=${accountId}::uuid AND metric='monthly_active_contacts' AND period=${period}`;
  if (cached && meterIsFresh(cached.updated_at, now)) return Number(cached.value);
  const [row] = await tx.$queryRaw<{ n: number }[]>`
    WITH month AS (SELECT date_trunc('month', now() AT TIME ZONE ${BILLING_TIME_ZONE}) AT TIME ZONE ${BILLING_TIME_ZONE} AS start)
    SELECT count(DISTINCT c.contact_id)::int AS n FROM conversations c
    WHERE c.account_id=${accountId}::uuid AND c.contact_id IS NOT NULL AND EXISTS (
      SELECT 1 FROM messages m, month WHERE m.account_id=c.account_id AND m.conversation_id=c.id AND m.created_at >= month.start)`;
  const n = row?.n ?? 0;
  await tx.$executeRaw`INSERT INTO usage_counters(account_id, metric, period, value)
    VALUES (${accountId}::uuid, 'monthly_active_contacts', ${period}, ${n})
    ON CONFLICT (account_id, metric, period) DO UPDATE SET value=EXCLUDED.value, updated_at=now()`;
  return n;
}
