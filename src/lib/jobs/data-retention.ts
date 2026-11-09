// Bounded retention for queue and webhook rows (audit finding 39). Once an hour the
// worker queues one data.retention_sweep job (no tenant), which deletes in short batches:
//   - done jobs older than 30 days and failed jobs older than 90 days (jobs_finished_updated_idx);
//   - processed webhook receipts (raw provider bodies) older than 30 days
//     (webhook_receipts_processed_idx); unprocessed receipts are never touched;
//   - per workspace (worker role under withTenant, so RLS scopes each delete), realtime
//     outbox_events older than 7 days (outbox_cursor_idx); clients only read recent ones.
// Pending and running jobs are never deleted. A job's dedupe key is freed with its row;
// every handler re-checks its own state rows, so a re-queued key is not a re-send.

import { getWorkerPrisma } from '@/lib/db/prisma';
import { withTenant } from '@/lib/db/tenant';

export const DATA_RETENTION_JOB = 'data.retention_sweep';
export const DATA_RETENTION = {
  doneJobDays: 30,
  failedJobDays: 90,
  webhookReceiptDays: 30,
  outboxEventDays: 7,
  batchSize: 5000,
  maxBatches: 20,
} as const;

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

export interface RetentionResult { doneJobs: number; failedJobs: number; webhookReceipts: number; outboxEvents: number }

/** The data.retention_sweep job. Returns rows removed (counts only are logged). */
export async function runDataRetentionSweep(): Promise<RetentionResult> {
  const db = getWorkerPrisma();
  const { batchSize } = DATA_RETENTION;
  const doneJobs = await inBatches(() => db.$executeRaw`DELETE FROM jobs WHERE id IN (
    SELECT id FROM jobs WHERE status='done' AND updated_at < now() - make_interval(days => ${DATA_RETENTION.doneJobDays}::int) LIMIT ${batchSize})`);
  const failedJobs = await inBatches(() => db.$executeRaw`DELETE FROM jobs WHERE id IN (
    SELECT id FROM jobs WHERE status='failed' AND updated_at < now() - make_interval(days => ${DATA_RETENTION.failedJobDays}::int) LIMIT ${batchSize})`);
  const webhookReceipts = await inBatches(() => db.$executeRaw`DELETE FROM webhook_receipts WHERE id IN (
    SELECT id FROM webhook_receipts WHERE status='processed' AND created_at < now() - make_interval(days => ${DATA_RETENTION.webhookReceiptDays}::int) LIMIT ${batchSize})`);
  let outboxEvents = 0;
  const accounts = await db.$queryRaw<{ account_id: string }[]>`SELECT account_id::text AS account_id FROM crm_accounts_for_retention()`;
  for (const { account_id: accountId } of accounts) {
    if (!UUID.test(accountId)) continue;
    outboxEvents += await inBatches(() => withTenant({ accountId, role: 'owner' }, (tx) => tx.$executeRaw`DELETE FROM outbox_events WHERE id IN (
      SELECT id FROM outbox_events WHERE account_id=${accountId}::uuid
        AND created_at < now() - make_interval(days => ${DATA_RETENTION.outboxEventDays}::int) LIMIT ${batchSize})`, db));
  }
  const result = { doneJobs, failedJobs, webhookReceipts, outboxEvents };
  console.info('[data-retention] sweep', JSON.stringify(result));
  return result;
}
