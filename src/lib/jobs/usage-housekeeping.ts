// Usage ledger housekeeping: removes usage_events rows that are settled or
// released and older than 13 months, per workspace
// (crm_accounts_with_usage_housekeeping_due()). The monthly counters in
// usage_counters are kept; only the per-event ledger rows go, long after the
// period they belong to can be replayed. Scheduled independently of
// billingConfigured() (the billing sweep returns early without keys).
// Held reservations are never touched: they expire by time.

import { getWorkerPrisma } from '@/lib/db/prisma';
import { withTenant } from '@/lib/db/tenant';
import { istDay } from '@/lib/ai/retention';

export const USAGE_HOUSEKEEPING_JOB = 'usage.housekeeping';
/** Rows removed per statement, and statements per job (the rest is due again tomorrow). */
export const USAGE_HOUSEKEEPING = { batchSize: 5000, maxBatches: 20 } as const;

const SCHEDULE_INTERVAL_MS = 60 * 60_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
let lastSchedule = Number.NEGATIVE_INFINITY;
let lastScheduledDay: string | null = null;

export const usageHousekeepingDedupeKey = (accountId: string, now: number): string => `usage-housekeeping:${accountId}:${istDay(now)}`;

/** Queues at most one usage.housekeeping job per due workspace per IST day. Returns how many were queued. */
export async function scheduleUsageHousekeeping(now: number = Date.now(), force = false): Promise<number> {
  if (!force && (lastScheduledDay === istDay(now) || now - lastSchedule < SCHEDULE_INTERVAL_MS)) return 0;
  lastSchedule = now;
  const accounts = await getWorkerPrisma().$queryRaw<{ account_id: string }[]>`
    SELECT account_id::text AS account_id FROM crm_accounts_with_usage_housekeeping_due()`;
  let queued = 0;
  for (const { account_id } of accounts) {
    if (!UUID.test(account_id)) continue;
    queued += await getWorkerPrisma().$executeRaw`INSERT INTO jobs(type,tenant_id,payload,dedupe_key,max_attempts)
      VALUES(${USAGE_HOUSEKEEPING_JOB},${account_id}::uuid,'{}'::jsonb,${usageHousekeepingDedupeKey(account_id, now)},2)
      ON CONFLICT(dedupe_key) DO NOTHING`;
  }
  lastScheduledDay = istDay(now);
  return queued;
}

/** Test hook. */
export function resetUsageHousekeepingScheduleForTests(): void {
  lastSchedule = Number.NEGATIVE_INFINITY;
  lastScheduledDay = null;
}

/** Removes the workspace's settled/released ledger rows older than 13 months, in short batches. Returns rows removed. */
export async function runUsageHousekeeping(accountId: string): Promise<number> {
  if (!UUID.test(accountId)) throw new Error('Invalid usage housekeeping job');
  let removed = 0;
  for (let i = 0; i < USAGE_HOUSEKEEPING.maxBatches; i++) {
    const n = await withTenant({ accountId, role: 'owner' }, (tx) => tx.$executeRaw`DELETE FROM usage_events WHERE id IN (
        SELECT id FROM usage_events WHERE account_id=${accountId}::uuid AND state IN ('settled','released')
          AND reserved_at < now() - interval '13 months' LIMIT ${USAGE_HOUSEKEEPING.batchSize})`, getWorkerPrisma());
    removed += n;
    if (n < USAGE_HOUSEKEEPING.batchSize) break;
  }
  return removed;
}
