import { createHash, randomUUID } from 'node:crypto';
import { getWorkerPrisma } from '@/lib/db/prisma';
import { retryDecision } from './retry';

export interface Job { id: string; type: string; tenant_id: string | null; payload: Record<string, unknown>; attempts: number; max_attempts: number; lease_token: string }
export interface JobOptions { tenantId?: string; runAt?: Date; dedupeKey?: string; maxAttempts?: number; requeueCompleted?: boolean }
const types = new Set(['whatsapp.webhook', 'inbound.actions', 'automation.trigger', 'broadcast.dispatch', 'webhook.delivery', 'automation.resume', 'automation.schedule', 'flow.sweep', 'flow.timer', 'whatsapp.health_sync', 'inbox.notification_digest', 'whatsapp.status_retry',
  'instagram.token_sweep', 'instagram.profile_fetch', 'instagram.private_reply']);
export async function enqueueJob(type: string, payload: Record<string, unknown>, options: JobOptions = {}): Promise<string> {
  if (!types.has(type) || JSON.stringify(payload).length > 2 * 1024 * 1024) throw new Error('Invalid job contract');
  const rows = await getWorkerPrisma().$queryRaw<{ id: string }[]>`
    INSERT INTO jobs(type,tenant_id,payload,dedupe_key,run_at,max_attempts)
    VALUES(${type},${options.tenantId ?? null}::uuid,${JSON.stringify(payload)}::jsonb,${options.dedupeKey ?? null},${options.runAt ?? new Date()},${options.maxAttempts ?? 5})
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
/** Receipt and its processing job commit atomically before the HTTP acknowledgment. */
export async function persistWebhook(rawBody: string, payload: Record<string, unknown>): Promise<string> {
  if (Buffer.byteLength(rawBody) > 2 * 1024 * 1024) throw new Error('Webhook exceeds size limit');
  const dedupeKey = createHash('sha256').update(rawBody).digest('hex');
  return getWorkerPrisma().$transaction(async tx => {
    const receipt = await tx.$queryRaw<{ id: string }[]>`
      INSERT INTO webhook_receipts(provider,dedupe_key,payload) VALUES('meta',${dedupeKey},${JSON.stringify(payload)}::jsonb)
      ON CONFLICT(dedupe_key) DO UPDATE SET dedupe_key=EXCLUDED.dedupe_key RETURNING id`;
    await tx.$executeRaw`INSERT INTO jobs(type,payload,dedupe_key) VALUES('whatsapp.webhook',${JSON.stringify({ receiptId: receipt[0].id })}::jsonb,${'webhook:' + receipt[0].id}) ON CONFLICT(dedupe_key) DO NOTHING`;
    return receipt[0].id;
  });
}
export async function claimJob(): Promise<Job | null> {
  const lease = randomUUID();
  const rows = await getWorkerPrisma().$queryRaw<Job[]>`
    WITH exhausted AS (
      UPDATE jobs SET status='failed',lease_until=NULL,lease_token=NULL,
        last_error='Job attempt limit reached after an expired lease',updated_at=NOW()
      WHERE attempts>=max_attempts AND (status='pending' OR (status='running' AND lease_until<NOW()))
      RETURNING id
    ), candidate AS (
      SELECT id FROM jobs WHERE attempts<max_attempts AND
        ((status='pending' AND run_at<=NOW()) OR (status='running' AND lease_until<NOW()))
      ORDER BY run_at,id FOR UPDATE SKIP LOCKED LIMIT 1
    ) UPDATE jobs j SET status='running',attempts=j.attempts+1,lease_token=${lease}::uuid,lease_until=NOW()+INTERVAL '90 seconds',updated_at=NOW()
      FROM candidate WHERE j.id=candidate.id RETURNING j.*`;
  return rows[0] ?? null;
}
export async function heartbeat(job: Job) {
  return getWorkerPrisma().$executeRaw`UPDATE jobs SET lease_until=NOW()+INTERVAL '90 seconds' WHERE id=${job.id}::uuid AND lease_token=${job.lease_token}::uuid AND status='running'`;
}
export async function finishJob(job: Job, error?: unknown) {
  if (!error) {
    await getWorkerPrisma().$executeRaw`UPDATE jobs SET status='done',lease_until=NULL,updated_at=NOW() WHERE id=${job.id}::uuid AND lease_token=${job.lease_token}::uuid AND status='running'`;
    return;
  }
  const uncertain = error instanceof Error && error.name === 'UncertainDispatchError';
  const decision = retryDecision({ attempts: job.attempts, maxAttempts: job.max_attempts, uncertain });
  // Persist a sanitized category, never provider URLs, tokens or customer content.
  await getWorkerPrisma().$executeRaw`UPDATE jobs SET status=${decision.status},run_at=${new Date(Date.now() + decision.delayMs)},lease_until=NULL,last_error=${uncertain ? 'Provider send outcome requires reconciliation' : 'Job execution failed; inspect correlated server logs'},updated_at=NOW()
    WHERE id=${job.id}::uuid AND lease_token=${job.lease_token}::uuid AND status='running'`;
}
