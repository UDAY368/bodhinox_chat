// Bounded retention for queue and webhook rows (audit finding 39). Once an hour the
// worker queues one data.retention_sweep job (no tenant), which deletes in short batches:
//   - done jobs older than 30 days and failed jobs older than 90 days (jobs_finished_updated_idx);
//   - processed webhook receipts older than 7 days (webhook_receipts_processed_idx); a processed
//     WhatsApp receipt already holds only ids and types (processedWebhookShell); unprocessed
//     receipts are never touched;
//   - done jobs of the recurring schedulers (SCHEDULE_JOB_TYPES: one row per workspace
//     every 30 s or so) after 2 days instead of 30;
//   - per workspace (worker role under withTenant, so RLS scopes each delete), realtime
//     outbox_events older than 7 days (outbox_cursor_idx); clients only read recent ones;
//     send records (outbound_intents) in a final state ('accepted', 'failed') older than
//     30 days, never 'pending', 'dispatching' or 'unknown' (uncertain sends wait for review);
//     event feed rows (domain_events) older than 400 days (domain_events_occurred_idx);
//   - on the auth role (the only one with those grants): expired sign-in sessions (their
//     refresh tokens cascade) and request rate-limit rows past their window.
// Pending and running jobs are never deleted. A job's dedupe key is freed with its row;
// every handler re-checks its own state rows, so a re-queued key is not a re-send.

import { getAuthPrisma, getWorkerPrisma } from '@/lib/db/prisma';
import { withTenant } from '@/lib/db/tenant';

export const DATA_RETENTION_JOB = 'data.retention_sweep';
export const DATA_RETENTION = {
  doneJobDays: 30,
  failedJobDays: 90,
  webhookReceiptDays: 7,
  outboxEventDays: 7,
  scheduleJobDays: 2,
  outboundIntentDays: 30,
  domainEventDays: 400,
  batchSize: 5000,
  maxBatches: 20,
} as const;

/** Recurring per-workspace scheduler jobs: their done rows are kept DATA_RETENTION.scheduleJobDays. */
export const SCHEDULE_JOB_TYPES = [
  'automation.schedule', 'flow.sweep', 'inbox.notification_push', 'inbox.notification_digest', 'inbox.sla_check',
  'inbox.auto_resolve', 'inbox.reminders_due', 'inbox.scheduled_replies_due', 'sequences.due',
  'payments.reconcile_sweep', 'analytics.report_schedules', 'whatsapp.health_sync', DATA_RETENTION_JOB,
];

const SCHEDULE_INTERVAL_MS = 60 * 60_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
let lastSchedule = Number.NEGATIVE_INFINITY;

/** Queues at most one sweep per clock hour. Returns how many were queued (0 or 1). */
export async function scheduleDataRetention(now: number = Date.now(), force = false): Promise<number> {
  if (!force && now - lastSchedule < SCHEDULE_INTERVAL_MS) return 0;
  lastSchedule = now;
  const hour = new Date(Math.floor(now / 3_600_000) * 3_600_000).toISOString();
  return getWorkerPrisma().$executeRaw`INSERT INTO jobs(type,payload,dedupe_key,max_attempts)
    VALUES(${DATA_RETENTION_JOB},'{}'::jsonb,${`data-retention:${hour}`},2) ON CONFLICT(dedupe_key) DO NOTHING`;
}

/** Test hook. */
export function resetDataRetentionScheduleForTests(): void {
  lastSchedule = Number.NEGATIVE_INFINITY;
}

/** Runs `step` until it removes less than a full batch or the per-run cap is reached. */
async function inBatches(step: () => Promise<number>): Promise<number> {
  let removed = 0;
  for (let i = 0; i < DATA_RETENTION.maxBatches; i++) {
    const n = await step();
    removed += n;
    if (n < DATA_RETENTION.batchSize) break;
  }
  return removed;
}

export interface RetentionResult {
  doneJobs: number; scheduleJobs: number; failedJobs: number; webhookReceipts: number; outboxEvents: number;
  outboundIntents: number; domainEvents: number; authSessions: number; rateLimits: number;
}

/** The data.retention_sweep job. Returns rows removed (counts only are logged). */
export async function runDataRetentionSweep(): Promise<RetentionResult> {
  const db = getWorkerPrisma();
  const { batchSize } = DATA_RETENTION;
  const scheduleJobs = await inBatches(() => db.$executeRaw`DELETE FROM jobs WHERE id IN (
    SELECT id FROM jobs WHERE status='done' AND type = ANY(${SCHEDULE_JOB_TYPES}::text[])
      AND updated_at < now() - make_interval(days => ${DATA_RETENTION.scheduleJobDays}::int) LIMIT ${batchSize})`);
  const doneJobs = await inBatches(() => db.$executeRaw`DELETE FROM jobs WHERE id IN (
    SELECT id FROM jobs WHERE status='done' AND updated_at < now() - make_interval(days => ${DATA_RETENTION.doneJobDays}::int) LIMIT ${batchSize})`);
  const failedJobs = await inBatches(() => db.$executeRaw`DELETE FROM jobs WHERE id IN (
    SELECT id FROM jobs WHERE status='failed' AND updated_at < now() - make_interval(days => ${DATA_RETENTION.failedJobDays}::int) LIMIT ${batchSize})`);
  const webhookReceipts = await inBatches(() => db.$executeRaw`DELETE FROM webhook_receipts WHERE id IN (
    SELECT id FROM webhook_receipts WHERE status='processed' AND created_at < now() - make_interval(days => ${DATA_RETENTION.webhookReceiptDays}::int) LIMIT ${batchSize})`);
  let outboxEvents = 0;
  let outboundIntents = 0;
  let domainEvents = 0;
  const accounts = await db.$queryRaw<{ account_id: string }[]>`SELECT account_id::text AS account_id FROM crm_accounts_for_retention()`;
  for (const { account_id: accountId } of accounts) {
    if (!UUID.test(accountId)) continue;
    const scope = { accountId, role: 'owner' } as const;
    outboxEvents += await inBatches(() => withTenant(scope, async (tx) => {
      // The shop's live-view counters (aggregate page hits per minute, no visitor data) are kept for two hours.
      await tx.$executeRaw`DELETE FROM shop_live_hits WHERE account_id=${accountId}::uuid AND minute < now() - interval '2 hours'`;
      return tx.$executeRaw`DELETE FROM outbox_events WHERE id IN (
        SELECT id FROM outbox_events WHERE account_id=${accountId}::uuid
          AND created_at < now() - make_interval(days => ${DATA_RETENTION.outboxEventDays}::int) LIMIT ${batchSize})`;
    }, db));
    // Final states only: 'dispatching' and 'unknown' are uncertain sends that wait for a person.
    outboundIntents += await inBatches(() => withTenant(scope, (tx) => tx.$executeRaw`DELETE FROM outbound_intents WHERE id IN (
      SELECT id FROM outbound_intents WHERE account_id=${accountId}::uuid AND status IN ('accepted','failed')
        AND updated_at < now() - make_interval(days => ${DATA_RETENTION.outboundIntentDays}::int) LIMIT ${batchSize})`, db));
    domainEvents += await inBatches(() => withTenant(scope, (tx) => tx.$executeRaw`DELETE FROM domain_events WHERE id IN (
      SELECT id FROM domain_events WHERE account_id=${accountId}::uuid
        AND occurred_at < now() - make_interval(days => ${DATA_RETENTION.domainEventDays}::int) LIMIT ${batchSize})`, db));
  }
  // Identity tables: the auth role. A session past expires_at can never be used or refreshed again.
  const auth = getAuthPrisma();
  const authSessions = await inBatches(() => auth.$executeRaw`DELETE FROM auth_sessions WHERE id IN (
    SELECT id FROM auth_sessions WHERE expires_at < now() LIMIT ${batchSize})`);
  // Login and request limit rows past their window (a new request starts a fresh window anyway).
  const rateLimits = await inBatches(() => auth.$executeRaw`DELETE FROM auth_rate_limits WHERE key IN (
    SELECT key FROM auth_rate_limits WHERE reset_at < now() LIMIT ${batchSize})`);
  const result = { doneJobs, scheduleJobs, failedJobs, webhookReceipts, outboxEvents, outboundIntents, domainEvents, authSessions, rateLimits };
  console.info('[data-retention] sweep', JSON.stringify(result));
  return result;
}
