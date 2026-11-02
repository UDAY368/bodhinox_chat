// ============================================================
// Scheduled campaigns. A scheduled broadcast's initial dispatch job
// waits in the queue until `scheduled_at` (jobs.run_at). Starting,
// cancelling and rescheduling are single conditional updates, so a
// schedule fires at most once and a cancelled one never sends.
// ============================================================

import { AuthError } from '@/lib/auth/errors';
import { getWorkerPrisma } from '@/lib/db/prisma';
import { withTenant, type TenantContext } from '@/lib/db/tenant';
import { parseSchedule } from './create-campaign';

const initialJob = (id: string) => `broadcast:${id}:initial`;

/** Read-only gate: false for a cancelled campaign, one scheduled for later, or a suspended workspace. */
export async function broadcastDispatchable(accountId: string, broadcastId: string): Promise<boolean> {
  const rows = await withTenant({ accountId, role: 'owner' }, (tx) => tx.$queryRaw<{ ok: boolean }[]>`
    SELECT (status<>'cancelled' AND (status<>'scheduled' OR scheduled_at<=now())
      -- A suspended workspace (unpaid after grace) holds its campaigns; Resume after paying.
      AND NOT EXISTS (SELECT 1 FROM account_subscriptions s WHERE s.account_id=broadcasts.account_id AND s.status='suspended')) AS ok
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
 * Move a campaign into `sending` for a dispatch pass. False when it was
 * cancelled, or is scheduled for later; the caller then sends nothing.
 */
export async function claimBroadcastStart(accountId: string, broadcastId: string): Promise<boolean> {
  const rows = await withTenant({ accountId, role: 'owner' }, (tx) => tx.$queryRaw<{ id: string }[]>`
    UPDATE broadcasts SET status='sending', updated_at=now()
    WHERE account_id=${accountId}::uuid AND id=${broadcastId}::uuid AND status<>'cancelled'
      AND (status<>'scheduled' OR scheduled_at<=now())
    RETURNING id`, getWorkerPrisma());
  return rows.length > 0;
}

/** Cancel a campaign that has not started. False when it is not (or no longer) scheduled. */
export async function cancelScheduledBroadcast(scope: TenantContext, broadcastId: string): Promise<boolean> {
  return withTenant(scope, async (tx) => {
    const rows = await tx.$queryRaw<{ id: string }[]>`
      UPDATE broadcasts SET status='cancelled', updated_at=now()
      WHERE account_id=${scope.accountId}::uuid AND id=${broadcastId}::uuid AND status='scheduled' RETURNING id`;
    if (!rows.length) return false;
    // Tidy the waiting job; the dispatcher would also skip a cancelled campaign.
    await tx.$executeRaw`UPDATE jobs SET status='done', updated_at=now()
      WHERE tenant_id=${scope.accountId}::uuid AND dedupe_key=${initialJob(broadcastId)} AND status='pending'`;
    return true;
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
    if (!rows.length) throw new AuthError('Only scheduled campaigns can be rescheduled', 409, 'conflict');
    const moved = await tx.$executeRaw`UPDATE jobs SET run_at=${at}, updated_at=now()
      WHERE tenant_id=${scope.accountId}::uuid AND dedupe_key=${initialJob(broadcastId)} AND status='pending'`;
    // The job is already running: the campaign is starting and can no longer move.
    if (!moved) throw new AuthError('This campaign is already starting', 409, 'conflict');
  }, getWorkerPrisma());
}
