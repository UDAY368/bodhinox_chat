// analytics.rollup: the daily summary job (src/lib/analytics/daily.ts).
// The worker's scheduler checks at most hourly and queues one job per workspace
// per workspace-local day (the dedupe key carries that day), so a workspace is
// rolled within about an hour of its own midnight. The job rolls yesterday and
// the two days before it (late messages, payments and resolves land in the
// re-roll). It runs on the bulk lane (BULK_JOB_TYPES in src/lib/jobs/queue.ts).

import { getWorkerPrisma } from '@/lib/db/prisma';
import { isValidTimezone, localDay } from './range';
import { rollupDays, rollupWindow } from './daily';

export const ANALYTICS_ROLLUP_JOB = 'analytics.rollup';
const SCHEDULE_INTERVAL_MS = 60 * 60_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
let lastSchedule = Number.NEGATIVE_INFINITY;

export const analyticsRollupDedupeKey = (accountId: string, localToday: string): string =>
  `analytics-rollup:${accountId}:${localToday}`;

const zoneOf = (timezone: string | null) => (timezone && isValidTimezone(timezone) ? timezone : 'UTC');

/** Queues at most one analytics.rollup job per workspace per local day. Returns how many were queued. */
export async function scheduleAnalyticsRollups(now: number = Date.now(), force = false): Promise<number> {
  if (!force && now - lastSchedule < SCHEDULE_INTERVAL_MS) return 0;
  lastSchedule = now;
  const accounts = await getWorkerPrisma().$queryRaw<{ account_id: string; timezone: string | null }[]>`
    SELECT account_id::text AS account_id, timezone FROM crm_accounts_for_analytics_rollup()`;
  let queued = 0;
  for (const { account_id, timezone } of accounts) {
    if (!UUID.test(account_id)) continue;
    const today = localDay(new Date(now), zoneOf(timezone));
    queued += await getWorkerPrisma().$executeRaw`INSERT INTO jobs(type,tenant_id,payload,dedupe_key,max_attempts)
      VALUES(${ANALYTICS_ROLLUP_JOB},${account_id}::uuid,'{}'::jsonb,${analyticsRollupDedupeKey(account_id, today)},3)
      ON CONFLICT(dedupe_key) DO NOTHING`;
  }
  return queued;
}

/** Test hook. */
export function resetAnalyticsRollupScheduleForTests(): void {
  lastSchedule = Number.NEGATIVE_INFINITY;
}

/** The job: rolls the workspace's window (yesterday and the two days before). Idempotent. */
export async function runAnalyticsRollup(accountId: string, now: Date = new Date()): Promise<number> {
  if (!UUID.test(accountId)) throw new Error('Invalid analytics rollup job');
  const rows = await getWorkerPrisma().$queryRaw<{ timezone: string | null }[]>`
    SELECT timezone FROM crm_accounts_for_analytics_rollup() WHERE account_id=${accountId}::uuid`;
  const { fromDay, toDay } = rollupWindow(zoneOf(rows[0]?.timezone ?? null), now);
  return rollupDays(accountId, fromDay, toDay);
}
