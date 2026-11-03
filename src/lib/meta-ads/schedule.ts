// Periodic Meta ads syncs. Nothing is queued while the feature is off or not
// configured. For each active connection: insights hourly, and a lead backfill
// (for missed Page webhooks) every 15 minutes. Jobs are raw transactional
// INSERTs deduplicated per time bucket, so overlapping workers queue one each.
import { getWorkerPrisma } from '@/lib/db/prisma';
import { metaAdsConfig } from './config';

export const INSIGHTS_SYNC_JOB = 'meta.insights_sync';
export const LEADS_SYNC_JOB = 'meta.leads_sync';
const HOUR_MS = 3_600_000;
const LEADS_BUCKET_MS = 15 * 60_000;
/** scheduleWork runs often; the connection list is read at most once a minute per process. */
const SCHEDULE_INTERVAL_MS = 60_000;
let lastSchedule = Number.NEGATIVE_INFINITY;

export function insightsSyncDedupeKey(accountId: string, now: number): string {
  return `meta-insights:${accountId}:${Math.floor(now / HOUR_MS)}`;
}

export function leadsSyncDedupeKey(accountId: string, now: number): string {
  return `meta-leads:${accountId}:${Math.floor(now / LEADS_BUCKET_MS)}`;
}

/** Queues the due syncs; returns the number of active connections seen. */
export async function scheduleMetaAds(now: number = Date.now(), force = false): Promise<number> {
  if (!metaAdsConfig()) return 0;
  if (!force && now - lastSchedule < SCHEDULE_INTERVAL_MS) return 0;
  lastSchedule = now;
  const prisma = getWorkerPrisma();
  const connections = await prisma.$queryRaw<{ account_id: string }[]>`
    SELECT account_id::text AS account_id FROM crm_meta_ad_connections_due()`;
  for (const { account_id } of connections) {
    await prisma.$executeRaw`INSERT INTO jobs(type,tenant_id,payload,dedupe_key,max_attempts)
      VALUES(${INSIGHTS_SYNC_JOB},${account_id}::uuid,'{}'::jsonb,${insightsSyncDedupeKey(account_id, now)},3)
      ON CONFLICT(dedupe_key) DO NOTHING`;
    await prisma.$executeRaw`INSERT INTO jobs(type,tenant_id,payload,dedupe_key,max_attempts)
      VALUES(${LEADS_SYNC_JOB},${account_id}::uuid,'{}'::jsonb,${leadsSyncDedupeKey(account_id, now)},3)
      ON CONFLICT(dedupe_key) DO NOTHING`;
  }
  return connections.length;
}

export function resetMetaAdsScheduleForTests(): void {
  lastSchedule = Number.NEGATIVE_INFINITY;
}
