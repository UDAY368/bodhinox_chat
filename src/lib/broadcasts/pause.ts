// ============================================================
// Pausing a sending campaign (Campaigns redesign).
//
// Pause is one conditional update: only a 'sending' dashboard campaign moves
// to 'paused'. The dispatcher checks the status between recipients
// (deliverBroadcast / deliverInstagramBroadcast `shouldStop`), so a pass in
// flight stops after the recipient it is sending, and every recipient not yet
// sent stays 'pending'. broadcastDispatchable and claimBroadcastStart refuse a
// paused campaign, so a queued follow-up pass sends nothing.
//
// Resume (the resume route) flips 'paused' back to 'sending' and queues the
// next pass for the pending recipients. Nothing already sent is sent again:
// each recipient keeps its outbound intent.
// ============================================================

import { AuthError } from '@/lib/auth/errors';
import { getWorkerPrisma } from '@/lib/db/prisma';
import { withTenant, type TenantContext, type TenantTransaction } from '@/lib/db/tenant';

async function assertInWorkspace(tx: TenantTransaction, accountId: string, broadcastId: string): Promise<void> {
  const found = await tx.$queryRaw<{ id: string }[]>`
    SELECT id FROM broadcasts WHERE account_id=${accountId}::uuid AND id=${broadcastId}::uuid`;
  if (!found.length) throw new AuthError('Broadcast unavailable', 404, 'not_found');
}

async function audit(tx: TenantTransaction, scope: TenantContext, action: string, broadcastId: string): Promise<void> {
  await tx.$executeRaw`INSERT INTO audit_logs(account_id,user_id,action,resource_id,metadata)
    VALUES(${scope.accountId}::uuid,${scope.userId ?? null}::uuid,${action},${broadcastId},
      ${JSON.stringify({ broadcast_id: broadcastId })}::jsonb)`;
}

/**
 * Pause a sending campaign. False when it is not (or no longer) sending, or is
 * an API campaign (those take recipients per request and have nothing queued
 * to hold back); a 404 AuthError when it is not in this workspace.
 */
export async function pauseBroadcast(scope: TenantContext, broadcastId: string): Promise<boolean> {
  return withTenant(scope, async (tx) => {
    const rows = await tx.$queryRaw<{ id: string }[]>`
      UPDATE broadcasts SET status='paused', paused_at=now(), updated_at=now()
      WHERE account_id=${scope.accountId}::uuid AND id=${broadcastId}::uuid AND status='sending' AND kind<>'api'
      RETURNING id`;
    if (!rows.length) {
      await assertInWorkspace(tx, scope.accountId, broadcastId);
      return false;
    }
    await audit(tx, scope, 'campaigns.paused', broadcastId);
    return true;
  }, getWorkerPrisma());
}

/**
 * Put a paused campaign back to 'sending' so the next dispatch pass may run.
 * False when it is not paused. The caller queues the pass.
 */
export async function unpauseBroadcast(scope: TenantContext, broadcastId: string): Promise<boolean> {
  return withTenant(scope, async (tx) => {
    const rows = await tx.$queryRaw<{ id: string }[]>`
      UPDATE broadcasts SET status='sending', paused_at=NULL, updated_at=now()
      WHERE account_id=${scope.accountId}::uuid AND id=${broadcastId}::uuid AND status='paused'
      RETURNING id`;
    if (!rows.length) return false;
    await audit(tx, scope, 'campaigns.resumed', broadcastId);
    return true;
  }, getWorkerPrisma());
}

/** Read by the dispatcher between recipients: true once a member paused (or cancelled) the campaign. */
export async function broadcastHalted(accountId: string, broadcastId: string): Promise<boolean> {
  const rows = await withTenant({ accountId, role: 'owner' }, (tx) => tx.$queryRaw<{ status: string }[]>`
    SELECT status FROM broadcasts WHERE account_id=${accountId}::uuid AND id=${broadcastId}::uuid`, getWorkerPrisma());
  return !rows[0] || rows[0].status === 'paused' || rows[0].status === 'cancelled';
}
