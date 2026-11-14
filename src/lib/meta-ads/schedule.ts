// Periodic Meta ads syncs. Nothing is queued while the feature is off or not
// configured. For each active connection: insights (the last 7 days) and the
// campaign / ad set / ad list (ad management) hourly, a full 90-day insights
// refresh once a day, customer-list audiences every 6 hours, and a lead backfill
// (for missed Page webhooks) every 15 minutes. Jobs are raw transactional
// INSERTs deduplicated per time bucket, so overlapping workers queue one each.
import { getWorkerPrisma } from '@/lib/db/prisma';
import { metaAdsConfig, metaAdsManageEnabled } from './config';
import { AUDIENCE_SYNC_JOB, AUDIENCE_SYNC_MAX_ATTEMPTS, audienceAutoSyncDedupeKey } from './audiences';

export const INSIGHTS_SYNC_JOB = 'meta.insights_sync';
export const LEADS_SYNC_JOB = 'meta.leads_sync';
export const AD_OBJECTS_SYNC_JOB = 'meta.ad_objects_sync';
export const AD_RULES_JOB = 'meta.ad_rules';
const HOUR_MS = 3_600_000;
const LEADS_BUCKET_MS = 15 * 60_000;
/** scheduleWork runs often; the connection list is read at most once a minute per process. */
const SCHEDULE_INTERVAL_MS = 60_000;
let lastSchedule = Number.NEGATIVE_INFINITY;

export function insightsSyncDedupeKey(accountId: string, now: number): string {
  return `meta-insights:${accountId}:${Math.floor(now / HOUR_MS)}`;
}

/** One full (90-day) insights refresh per workspace per UTC day. */
export function fullInsightsSyncDedupeKey(accountId: string, now: number): string {
  return `meta-insights-full:${accountId}:${new Date(now).toISOString().slice(0, 10)}`;
}

export function adObjectsSyncDedupeKey(accountId: string, now: number): string {
  return `meta-ad-objects:${accountId}:${Math.floor(now / HOUR_MS)}`;
}

export function adRulesDedupeKey(accountId: string, now: number): string {
  return `meta-ad-rules:${accountId}:${Math.floor(now / HOUR_MS)}`;
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
      VALUES(${INSIGHTS_SYNC_JOB},${account_id}::uuid,'{"full":true}'::jsonb,${fullInsightsSyncDedupeKey(account_id, now)},3)
      ON CONFLICT(dedupe_key) DO NOTHING`;
    await prisma.$executeRaw`INSERT INTO jobs(type,tenant_id,payload,dedupe_key,max_attempts)
      VALUES(${AD_OBJECTS_SYNC_JOB},${account_id}::uuid,'{}'::jsonb,${adObjectsSyncDedupeKey(account_id, now)},3)
      ON CONFLICT(dedupe_key) DO NOTHING`;
    await prisma.$executeRaw`INSERT INTO jobs(type,tenant_id,payload,dedupe_key,max_attempts)
      VALUES(${LEADS_SYNC_JOB},${account_id}::uuid,'{}'::jsonb,${leadsSyncDedupeKey(account_id, now)},3)
      ON CONFLICT(dedupe_key) DO NOTHING`;
    // Customer-list audiences re-upload their segment every 6 hours (needs ad management).
    if (metaAdsManageEnabled()) {
      await prisma.$executeRaw`INSERT INTO jobs(type,tenant_id,payload,dedupe_key,max_attempts)
        VALUES(${AUDIENCE_SYNC_JOB},${account_id}::uuid,'{}'::jsonb,${audienceAutoSyncDedupeKey(account_id, now)},${AUDIENCE_SYNC_MAX_ATTEMPTS})
        ON CONFLICT(dedupe_key) DO NOTHING`;
    }
    // Ad rules are checked hourly against the stored insights (a rule that pauses also needs ad management).
    await prisma.$executeRaw`INSERT INTO jobs(type,tenant_id,payload,dedupe_key,max_attempts)
      VALUES(${AD_RULES_JOB},${account_id}::uuid,'{}'::jsonb,${adRulesDedupeKey(account_id, now)},3)
      ON CONFLICT(dedupe_key) DO NOTHING`;
  }
  return connections.length;
}

export function resetMetaAdsScheduleForTests(): void {
  lastSchedule = Number.NEGATIVE_INFINITY;
}
