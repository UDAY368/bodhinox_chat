import { createHash, randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { getWorkerPrisma } from '@/lib/db/prisma';
import { defaultMaxAttempts, LONG_RETRY_ATTEMPTS, retryDecision } from './retry';
import { assertLiveEffects } from '@/lib/runtime/dry-run-guard';
import { BULK_JOB_TYPES, TIMER_JOB_TYPES, webhookLaneKey, type JobLane } from './lanes';

export { BULK_JOB_TYPES, TIMER_JOB_TYPES, type JobLane };
/** lane_key: jobs sharing one (one conversation or chat) run one at a time, oldest first. Null for most jobs. */
export interface Job { id: string; type: string; tenant_id: string | null; payload: Record<string, unknown>; attempts: number; max_attempts: number; lease_token: string; lane_key?: string | null }
export interface JobOptions { tenantId?: string; runAt?: Date; dedupeKey?: string; maxAttempts?: number; requeueCompleted?: boolean }
const types = new Set(['whatsapp.webhook', 'inbound.actions', 'automation.trigger', 'broadcast.dispatch', 'webhook.delivery', 'automation.resume', 'automation.schedule', 'flow.sweep', 'flow.timer', 'whatsapp.health_sync', 'inbox.notification_digest', 'inbox.notification_push', 'whatsapp.status_retry',
  'instagram.token_sweep', 'instagram.profile_fetch', 'instagram.private_reply', 'instagram.resubscribe',
  // Phase 12: replay of a failed flow run, and due scheduled reports per workspace.
  'flow.replay', 'analytics.report_schedules',
  // Phase 13: AI assessment (debounced per conversation), insight runs and daily AI data retention.
  'ai.assess_conversation', 'ai.insight_run', 'ai.retention_sweep',
  // An inbound AI auto-reply deferred by the account-wide rate limit.
  'ai.auto_reply_retry',
  // Auto-labelling of a new conversation (one job per conversation).
  'ai.auto_label',
  // Stage 5: public API flow starts and due sequence messages (both also inserted directly with their own dedupe keys).
  'api.start_flow', 'sequences.due',
  // Store plan Phase 4: a queued product CSV import.
  'commerce.product_import', 'commerce.platform_import',
  // Store plan Phase 4: an admin's "Sync now" of the full Meta catalogue sync (changes queue it from database triggers).
  'commerce.meta_catalogue_sync']);
export async function enqueueJob(type: string, payload: Record<string, unknown>, options: JobOptions = {}): Promise<string> {
  assertLiveEffects('job');
  if (!types.has(type) || JSON.stringify(payload).length > 2 * 1024 * 1024) throw new Error('Invalid job contract');
  const rows = await getWorkerPrisma().$queryRaw<{ id: string }[]>`
    INSERT INTO jobs(type,tenant_id,payload,dedupe_key,run_at,max_attempts)
    VALUES(${type},${options.tenantId ?? null}::uuid,${JSON.stringify(payload)}::jsonb,${options.dedupeKey ?? null},${options.runAt ?? new Date()},${options.maxAttempts ?? defaultMaxAttempts(type)})
    ON CONFLICT(dedupe_key) DO UPDATE SET
      status=CASE WHEN ${options.requeueCompleted===true} AND jobs.status IN ('done','failed') THEN 'pending' ELSE jobs.status END,
      attempts=CASE WHEN ${options.requeueCompleted===true} AND jobs.status IN ('done','failed') THEN 0 ELSE jobs.attempts END,
      run_at=CASE WHEN ${options.requeueCompleted===true} AND jobs.status IN ('done','failed') THEN EXCLUDED.run_at ELSE jobs.run_at END,
      payload=CASE WHEN ${options.requeueCompleted===true} AND jobs.status IN ('done','failed') THEN EXCLUDED.payload ELSE jobs.payload END,
      max_attempts=CASE WHEN ${options.requeueCompleted===true} AND jobs.status IN ('done','failed') THEN EXCLUDED.max_attempts ELSE jobs.max_attempts END,
      lease_until=CASE WHEN ${options.requeueCompleted===true} AND jobs.status IN ('done','failed') THEN NULL ELSE jobs.lease_until END,
      lease_token=CASE WHEN ${options.requeueCompleted===true} AND jobs.status IN ('done','failed') THEN NULL ELSE jobs.lease_token END,
      last_error=CASE WHEN ${options.requeueCompleted===true} AND jobs.status IN ('done','failed') THEN NULL ELSE jobs.last_error END
    WHERE jobs.type=EXCLUDED.type AND jobs.tenant_id IS NOT DISTINCT FROM EXCLUDED.tenant_id RETURNING id`;
  if(!rows.length) throw new Error('Job dedupe identity mismatch');
  return rows[0].id;
}
/**
 * One job per workspace in a single statement (the scheduler's per-workspace sweeps). Each entry
 * keeps the dedupe key a one-by-one insert would use; an existing key is left as it is. Returns how
 * many jobs were inserted.
 */
export async function enqueueTenantJobs(type: string, payload: Record<string, unknown>,
  entries: { tenantId: string; dedupeKey: string }[], maxAttempts = defaultMaxAttempts(type)): Promise<number> {
  assertLiveEffects('job');
  if (!/^[a-z_]+\.[a-z_]+$/.test(type)) throw new Error('Invalid job contract');
  if (!entries.length) return 0;
  return getWorkerPrisma().$executeRaw`
    INSERT INTO jobs(type,tenant_id,payload,dedupe_key,max_attempts)
    SELECT ${type},t.tenant_id,${JSON.stringify(payload)}::jsonb,t.dedupe_key,${maxAttempts}
    FROM unnest(${entries.map((e) => e.tenantId)}::uuid[],${entries.map((e) => e.dedupeKey)}::text[]) AS t(tenant_id,dedupe_key)
    ON CONFLICT(dedupe_key) DO NOTHING`;
}
/**
 * Receipt and its processing job commit atomically before the HTTP acknowledgment. A delivery for
 * one chat carries that chat's lane key, so one chat's deliveries are ingested in arrival order.
 */
export async function persistWebhook(rawBody: string, payload: Record<string, unknown>): Promise<string> {
  if (Buffer.byteLength(rawBody) > 2 * 1024 * 1024) throw new Error('Webhook exceeds size limit');
  const dedupeKey = createHash('sha256').update(rawBody).digest('hex');
  const laneKey = webhookLaneKey(payload);
  return getWorkerPrisma().$transaction(async tx => {
    const receipt = await tx.$queryRaw<{ id: string }[]>`
      INSERT INTO webhook_receipts(provider,dedupe_key,payload) VALUES('meta',${dedupeKey},${JSON.stringify(payload)}::jsonb)
      ON CONFLICT(dedupe_key) DO UPDATE SET dedupe_key=EXCLUDED.dedupe_key RETURNING id`;
    await tx.$executeRaw`INSERT INTO jobs(type,payload,dedupe_key,max_attempts,lane_key) VALUES('whatsapp.webhook',${JSON.stringify({ receiptId: receipt[0].id })}::jsonb,${'webhook:' + receipt[0].id},${LONG_RETRY_ATTEMPTS},${laneKey}) ON CONFLICT(dedupe_key) DO NOTHING`;
    return receipt[0].id;
  });
}

const bulkTypes: string[] = [...BULK_JOB_TYPES];
const timerTypes: string[] = [...TIMER_JOB_TYPES];
function laneFilter(lane: JobLane): Prisma.Sql {
  if (lane === 'bulk') return Prisma.sql`AND j.type = ANY(${bulkTypes}::text[])`;
  if (lane === 'timers') return Prisma.sql`AND j.type = ANY(${timerTypes}::text[])`;
  if (lane === 'inbound') return Prisma.sql`AND NOT (j.type = ANY(${bulkTypes}::text[]) OR j.type = ANY(${timerTypes}::text[]))`;
  return Prisma.empty;
}

/**
 * Claims the oldest due job of `lane` (run_at, id), with two rules on top of that order:
 * - A keyed job (lane_key: one conversation or chat) is taken only when no job of its key runs
 *   under a live lease and none older is still due. Several inbound slots therefore never run one
 *   conversation's jobs at once or out of order: a row another slot is claiming right now is still
 *   'pending' in this snapshot, so the newer job waits behind it.
 * - The bulk lane prefers workspaces with no bulk job running, so one workspace's campaigns or
 *   exports never hold every bulk slot while another workspace has bulk work due.
 */
export async function claimJob(lane: JobLane = 'all'): Promise<Job | null> {
  const lease = randomUUID();
  const fairness = lane === 'bulk'
    ? Prisma.sql`(j.tenant_id IS NOT NULL AND EXISTS(SELECT 1 FROM jobs r WHERE r.tenant_id=j.tenant_id AND r.status='running'
        AND r.lease_until>=NOW() AND r.type = ANY(${bulkTypes}::text[]))),`
    : Prisma.empty;
  const rows = await getWorkerPrisma().$queryRaw<Job[]>`
    WITH exhausted AS (
      UPDATE jobs SET status='failed',lease_until=NULL,lease_token=NULL,
        last_error='Job attempt limit reached after an expired lease',updated_at=NOW()
      WHERE attempts>=max_attempts AND (status='pending' OR (status='running' AND lease_until<NOW()))
      RETURNING id
    ), candidate AS (
      SELECT j.id FROM jobs j WHERE j.attempts<j.max_attempts AND
        ((j.status='pending' AND j.run_at<=NOW()) OR (j.status='running' AND j.lease_until<NOW()))
        ${laneFilter(lane)}
        AND (j.lane_key IS NULL OR NOT EXISTS(
          SELECT 1 FROM jobs o WHERE o.lane_key=j.lane_key AND o.id<>j.id AND o.status IN ('pending','running') AND (
            (o.status='running' AND o.lease_until>=NOW())
            OR (o.attempts<o.max_attempts AND (o.run_at,o.id)<(j.run_at,j.id) AND (o.status='pending' OR o.lease_until<NOW())))))
      ORDER BY ${fairness} j.run_at,j.id FOR UPDATE OF j SKIP LOCKED LIMIT 1
    ) UPDATE jobs j SET status='running',attempts=j.attempts+1,lease_token=${lease}::uuid,lease_until=NOW()+INTERVAL '90 seconds',updated_at=NOW()
      FROM candidate WHERE j.id=candidate.id RETURNING j.*`;
  return rows[0] ?? null;
}
export async function heartbeat(job: Job) {
  return getWorkerPrisma().$executeRaw`UPDATE jobs SET lease_until=NOW()+INTERVAL '90 seconds' WHERE id=${job.id}::uuid AND lease_token=${job.lease_token}::uuid AND status='running'`;
}

/** Another run of the same lane key still holds its lock (a run that outlived its lease). Nothing ran. */
export class LaneBusyError extends Error {
  constructor() { super('Lane key busy'); this.name = 'LaneBusyError'; }
}
/** Longer than any handler; a run past it loses the lock, never its job (the lease still fences it). */
const LANE_LOCK_TIMEOUT_MS = 15 * 60_000;

/**
 * Runs a keyed job under a transaction-level advisory lock on its lane key. Transaction-level, not
 * session-level: the pool gives each query any free connection, so a session lock could be taken on
 * one connection and released on another (or never). The lock transaction pins one connection for
 * the run and runs nothing else; PostgreSQL drops the lock when it ends or its connection dies, so
 * a crashed worker never leaves a conversation locked. The claim already keeps one running job per
 * key; the lock also covers a run that outlived its lease while the reclaimed job starts.
 */
export async function withLaneLock<T>(laneKey: string | null | undefined, work: () => Promise<T>): Promise<T> {
  if (!laneKey) return work();
  return getWorkerPrisma().$transaction(async (tx) => {
    const [row] = await tx.$queryRaw<{ locked: boolean }[]>`SELECT pg_try_advisory_xact_lock(hashtextextended(${`job-lane:${laneKey}`}, 0)) AS locked`;
    if (!row?.locked) throw new LaneBusyError();
    return work();
  }, { maxWait: 10_000, timeout: LANE_LOCK_TIMEOUT_MS });
}

export async function finishJob(job: Job, error?: unknown) {
  if (!error) {
    await getWorkerPrisma().$executeRaw`UPDATE jobs SET status='done',lease_until=NULL,updated_at=NOW() WHERE id=${job.id}::uuid AND lease_token=${job.lease_token}::uuid AND status='running'`;
    return;
  }
  if (error instanceof LaneBusyError) {
    // Nothing ran: back in the queue shortly, without spending an attempt.
    await getWorkerPrisma().$executeRaw`UPDATE jobs SET status='pending',attempts=GREATEST(attempts-1,0),run_at=NOW()+INTERVAL '2 seconds',lease_until=NULL,updated_at=NOW()
      WHERE id=${job.id}::uuid AND lease_token=${job.lease_token}::uuid AND status='running'`;
    return;
  }
  const uncertain = error instanceof Error && error.name === 'UncertainDispatchError';
  const decision = retryDecision({ attempts: job.attempts, maxAttempts: job.max_attempts, uncertain });
  // Persist a sanitized category, never provider URLs, tokens or customer content.
  await getWorkerPrisma().$executeRaw`UPDATE jobs SET status=${decision.status},run_at=${new Date(Date.now() + decision.delayMs)},lease_until=NULL,last_error=${uncertain ? 'Provider send outcome requires reconciliation' : 'Job execution failed; inspect correlated server logs'},updated_at=NOW()
    WHERE id=${job.id}::uuid AND lease_token=${job.lease_token}::uuid AND status='running'`;
}
