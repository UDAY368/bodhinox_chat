// ============================================================
// Scheduled campaigns. A scheduled broadcast's initial dispatch job
// waits in the queue until `scheduled_at` (jobs.run_at). Starting,
// cancelling and rescheduling are single conditional updates, so a
// schedule fires at most once and a cancelled one never sends.
// ============================================================

import { AuthError } from '@/lib/auth/errors';
import { getWorkerPrisma } from '@/lib/db/prisma';
import { withTenant, type TenantContext, type TenantTransaction } from '@/lib/db/tenant';
import { parseSchedule } from './create-campaign';

const initialJob = (id: string) => `broadcast:${id}:initial`;

/** Read-only gate: false for a cancelled or paused campaign, one scheduled for later, or a suspended (billing or admin) or closing workspace. */
export async function broadcastDispatchable(accountId: string, broadcastId: string): Promise<boolean> {
  const rows = await withTenant({ accountId, role: 'owner' }, (tx) => tx.$queryRaw<{ ok: boolean }[]>`
    SELECT (status NOT IN ('cancelled','paused') AND (status<>'scheduled' OR scheduled_at<=now())
      -- A suspended workspace (unpaid after grace) holds its campaigns; Resume after paying.
      AND NOT EXISTS (SELECT 1 FROM account_subscriptions s WHERE s.account_id=broadcasts.account_id AND s.status='suspended')
      -- So does an admin-suspended or closing workspace (the same rule as suspensionReason); Resume after reactivation.
      AND NOT EXISTS (SELECT 1 FROM account_lifecycle l WHERE l.account_id=broadcasts.account_id AND l.status IN ('admin_suspended','closing'))) AS ok
    FROM broadcasts WHERE account_id=${accountId}::uuid AND id=${broadcastId}::uuid`, getWorkerPrisma());
  return rows[0]?.ok === true;
}

/**
 * One dispatch pass per campaign at a time, so a Resume during a throttle
 * backoff cannot run beside the waiting pass. A lock older than 30 minutes
 * is treated as left by a crashed worker.
 */
export async function lockBroadcastDelivery(accountId: string, broadcastId: string): Promise<boolean> {
  const rows = await withTenant({ accountId, role: 'owner' }, (tx) => tx.$queryRaw<{ id: string }[]>`
    UPDATE broadcasts SET delivery_locked_at=now()
    WHERE account_id=${accountId}::uuid AND id=${broadcastId}::uuid
      AND (delivery_locked_at IS NULL OR delivery_locked_at < now() - interval '30 minutes')
    RETURNING id`, getWorkerPrisma());
  return rows.length > 0;
}

export async function unlockBroadcastDelivery(accountId: string, broadcastId: string): Promise<void> {
  await withTenant({ accountId, role: 'owner' }, (tx) => tx.$executeRaw`
    UPDATE broadcasts SET delivery_locked_at=NULL WHERE account_id=${accountId}::uuid AND id=${broadcastId}::uuid`, getWorkerPrisma());
}

/**
 * Start one "Retry failed" request (its retryId), under the delivery lock and
 * before the pass is planned. Rows Meta accepted and a status webhook later
 * failed (status 'failed' with a message id) get the next retry generation and
 * lose the old message id, so the pass sends them again under a new intent key
 * instead of replaying the old accepted one. The retryId is recorded on the
 * campaign in the same transaction, so a requeued or retried pass of the same
 * request never bumps (and so never resends) twice. Uncertain rows are left to
 * staff reconciliation. Returns the number of rows set up for a new send.
 */
export async function prepareFailedRetry(accountId: string, broadcastId: string, retryId: string): Promise<number> {
  return withTenant({ accountId, role: 'owner' }, async (tx) => {
    const claimed = await tx.$queryRaw<{ id: string }[]>`
      UPDATE broadcasts SET retry_request_id=${retryId}::uuid
      WHERE account_id=${accountId}::uuid AND id=${broadcastId}::uuid
        AND retry_request_id IS DISTINCT FROM ${retryId}::uuid
      RETURNING id`;
    if (!claimed.length) return 0;
    return tx.$executeRaw`
      UPDATE broadcast_recipients SET retry_generation=retry_generation+1, whatsapp_message_id=NULL
      WHERE account_id=${accountId}::uuid AND broadcast_id=${broadcastId}::uuid
        AND status='failed' AND whatsapp_message_id IS NOT NULL AND outcome_uncertain_at IS NULL`;
  }, getWorkerPrisma());
}

/**
 * Move a campaign into `sending` for a dispatch pass. False when it was
 * cancelled or paused, or is scheduled for later; the caller then sends nothing.
 */
export async function claimBroadcastStart(accountId: string, broadcastId: string): Promise<boolean> {
  const rows = await withTenant({ accountId, role: 'owner' }, (tx) => tx.$queryRaw<{ id: string }[]>`
    UPDATE broadcasts SET status='sending', updated_at=now()
    WHERE account_id=${accountId}::uuid AND id=${broadcastId}::uuid AND status NOT IN ('cancelled','paused')
      AND (status<>'scheduled' OR scheduled_at<=now())
    RETURNING id`, getWorkerPrisma());
  return rows.length > 0;
}

/** 404 when the campaign is not in this workspace, so a foreign id is answered like an unknown one. */
async function assertBroadcastInWorkspace(tx: TenantTransaction, accountId: string, broadcastId: string): Promise<void> {
  const found = await tx.$queryRaw<{ id: string }[]>`
    SELECT id FROM broadcasts WHERE account_id=${accountId}::uuid AND id=${broadcastId}::uuid`;
  if (!found.length) throw new AuthError('Broadcast unavailable', 404, 'not_found');
}

/**
 * Cancel a campaign that has not started. False when it is not (or no longer)
 * scheduled; throws a 404 AuthError when it is not in this workspace.
 */
export async function cancelScheduledBroadcast(scope: TenantContext, broadcastId: string): Promise<boolean> {
  return withTenant(scope, async (tx) => {
    const rows = await tx.$queryRaw<{ id: string }[]>`
      UPDATE broadcasts SET status='cancelled', updated_at=now()
      WHERE account_id=${scope.accountId}::uuid AND id=${broadcastId}::uuid AND status='scheduled' RETURNING id`;
    if (!rows.length) {
      await assertBroadcastInWorkspace(tx, scope.accountId, broadcastId);
      return false;
    }
    // Tidy the waiting job; the dispatcher would also skip a cancelled campaign.
    await tx.$executeRaw`UPDATE jobs SET status='done', updated_at=now()
      WHERE tenant_id=${scope.accountId}::uuid AND dedupe_key=${initialJob(broadcastId)} AND status='pending'`;
    return true;
  }, getWorkerPrisma());
}

/** What Send now does with a scheduled campaign, from its initial job and its workspace (pure; unit-tested). */
export type SendNowPlan =
  | { kind: 'move' }
  | { kind: 'requeue' }
  | { kind: 'insert' }
  | { kind: 'refuse'; code: 'already_starting' | 'workspace_held' | 'job_missing'; message: string };

export function planSendNow(input: {
  /** The initial job's status, or null when the row is gone (data retention removes finished jobs). */
  jobStatus: string | null;
  /** The workspace is suspended (billing), admin-suspended or closing: the dispatcher would hold it again. */
  held: boolean;
  /** A new job can be written without losing anything the old one carried (no header media to restore). */
  canRebuildJob: boolean;
}): SendNowPlan {
  if (input.held) {
    return { kind: 'refuse', code: 'workspace_held', message: 'Campaigns are on hold while this workspace is suspended; it sends once the workspace is active again' };
  }
  if (input.jobStatus === 'pending') return { kind: 'move' };
  // The job finished without starting the campaign (it was held then), so it is queued again: still one job.
  if (input.jobStatus === 'done' || input.jobStatus === 'failed') return { kind: 'requeue' };
  if (input.jobStatus !== null) return { kind: 'refuse', code: 'already_starting', message: 'This campaign is already starting' };
  if (input.canRebuildJob) return { kind: 'insert' };
  return {
    kind: 'refuse', code: 'job_missing',
    message: 'This campaign can no longer be started from its schedule; duplicate it to send it now',
  };
}

/**
 * Start a scheduled campaign now: its time and its initial job move to now, in
 * one transaction, so the same single job sends it (never a second one). A
 * campaign whose job already ran without starting it (held while the workspace
 * was suspended) gets that job queued again; one whose job row is gone gets a
 * new one under the same dedupe key when nothing the old job carried would be
 * lost (Instagram, or a template without header media). Refused while the job
 * is running, while the workspace is held, or when it is not scheduled.
 */
export async function startScheduledNow(scope: TenantContext, broadcastId: string): Promise<void> {
  await withTenant(scope, async (tx) => {
    const rows = await tx.$queryRaw<{ id: string; channel: string; template_name: string; template_language: string | null }[]>`
      UPDATE broadcasts SET scheduled_at=now(), updated_at=now()
      WHERE account_id=${scope.accountId}::uuid AND id=${broadcastId}::uuid AND status='scheduled'
      RETURNING id, channel, template_name, template_language`;
    if (!rows.length) {
      await assertBroadcastInWorkspace(tx, scope.accountId, broadcastId);
      throw new AuthError('Only scheduled campaigns can be started now', 409, 'not_scheduled');
    }
    // Locked so a worker cannot claim the job between this read and the update below.
    const [job] = await tx.$queryRaw<{ status: string }[]>`
      SELECT status FROM jobs WHERE tenant_id=${scope.accountId}::uuid AND dedupe_key=${initialJob(broadcastId)} FOR UPDATE`;
    const [hold] = await tx.$queryRaw<{ held: boolean }[]>`
      SELECT (EXISTS (SELECT 1 FROM account_subscriptions s WHERE s.account_id=${scope.accountId}::uuid AND s.status='suspended')
        OR EXISTS (SELECT 1 FROM account_lifecycle l WHERE l.account_id=${scope.accountId}::uuid AND l.status IN ('admin_suspended','closing'))) AS held`;
    const jobStatus = job?.status ?? null;
    let canRebuildJob = false;
    if (jobStatus === null) {
      if (rows[0].channel === 'instagram') canRebuildJob = true;
      else {
        // The old job may have carried header media chosen at creation; only a template without media can be rebuilt.
        const [template] = await tx.$queryRaw<{ header_type: string | null }[]>`
          SELECT header_type FROM message_templates
          WHERE account_id=${scope.accountId}::uuid AND name=${rows[0].template_name}
            AND language IS NOT DISTINCT FROM ${rows[0].template_language}
          ORDER BY updated_at DESC NULLS LAST LIMIT 1`;
        canRebuildJob = Boolean(template) && !['IMAGE', 'VIDEO', 'DOCUMENT'].includes((template.header_type ?? '').toUpperCase());
      }
    }
    const plan = planSendNow({ jobStatus, held: hold?.held === true, canRebuildJob });
    if (plan.kind === 'refuse') throw new AuthError(plan.message, 409, plan.code);
    if (plan.kind === 'move') {
      await tx.$executeRaw`UPDATE jobs SET run_at=now(), updated_at=now()
        WHERE tenant_id=${scope.accountId}::uuid AND dedupe_key=${initialJob(broadcastId)} AND status='pending'`;
    } else if (plan.kind === 'requeue') {
      await tx.$executeRaw`UPDATE jobs SET status='pending', run_at=now(), attempts=0, lease_until=NULL, lease_token=NULL,
          last_error=NULL, updated_at=now()
        WHERE tenant_id=${scope.accountId}::uuid AND dedupe_key=${initialJob(broadcastId)} AND status IN ('done','failed')`;
    } else {
      await tx.$executeRaw`INSERT INTO jobs(type,tenant_id,payload,dedupe_key,run_at)
        VALUES('broadcast.dispatch',${scope.accountId}::uuid,${JSON.stringify({ broadcastId, scope: 'pending' })}::jsonb,${initialJob(broadcastId)},now())`;
    }
  }, getWorkerPrisma());
}

/** Move a scheduled campaign to a new time; refused once its job has started. */
export async function rescheduleBroadcast(scope: TenantContext, broadcastId: string, value: unknown, now = new Date()): Promise<void> {
  const at = parseSchedule(typeof value === 'string' ? value : undefined, now);
  if (!at) throw new AuthError('Choose a new time', 400, 'campaign_input');
  await withTenant(scope, async (tx) => {
    const rows = await tx.$queryRaw<{ id: string }[]>`
      UPDATE broadcasts SET scheduled_at=${at}, updated_at=now()
      WHERE account_id=${scope.accountId}::uuid AND id=${broadcastId}::uuid AND status='scheduled' RETURNING id`;
    if (!rows.length) {
      await assertBroadcastInWorkspace(tx, scope.accountId, broadcastId);
      throw new AuthError('Only scheduled campaigns can be rescheduled', 409, 'conflict');
    }
    const moved = await tx.$executeRaw`UPDATE jobs SET run_at=${at}, updated_at=now()
      WHERE tenant_id=${scope.accountId}::uuid AND dedupe_key=${initialJob(broadcastId)} AND status='pending'`;
    // The job is already running: the campaign is starting and can no longer move.
    if (!moved) throw new AuthError('This campaign is already starting', 409, 'conflict');
  }, getWorkerPrisma());
}
