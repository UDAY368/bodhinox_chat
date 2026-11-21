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
import { likePrefix } from '@/lib/flows/replay';
import { insideWindow, windowFromRow } from './send-window';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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

/**
 * Read by the dispatcher before each recipient: true once a member paused or
 * cancelled the campaign, or its send window (quiet hours) has closed. The
 * dispatcher then requeues the rest for when the window opens (lib/broadcasts/send-window).
 */
export async function broadcastHalted(accountId: string, broadcastId: string, now = new Date()): Promise<boolean> {
  const rows = await withTenant({ accountId, role: 'owner' }, (tx) => tx.$queryRaw<{
    status: string; send_window_start: number | null; send_window_end: number | null; send_window_time_zone: string | null;
  }[]>`
    SELECT status, send_window_start, send_window_end, send_window_time_zone
    FROM broadcasts WHERE account_id=${accountId}::uuid AND id=${broadcastId}::uuid`, getWorkerPrisma());
  if (!rows[0] || rows[0].status === 'paused' || rows[0].status === 'cancelled') return true;
  const window = windowFromRow(rows[0]);
  return window !== null && !insideWindow(now, window);
}

/** Unsent recipients become 'cancelled'; rows whose send intent is open stay for reconciliation. */
export interface CancelRemainingResult {
  cancelled: number;
  /** Pending rows left as they are because a send intent exists for them (outcome unknown). */
  heldForReview: number;
}

/**
 * "Cancel remaining": stop a sending or paused dashboard campaign for good.
 * One transaction: the campaign row is locked and moved to 'cancelled' (the
 * dispatcher reads that before every recipient and broadcastDispatchable
 * refuses it, so no later pass sends), then every pending recipient without an
 * open outbound intent becomes 'cancelled'. A pending row with an intent
 * (dispatching, unknown or accepted: Meta may have it) is left untouched for
 * reconciliation; nothing clears an intent here. Returns null when the
 * campaign is not sending or paused (or is an API campaign); a 404 AuthError
 * when it is not in this workspace.
 */
export async function cancelRemainingBroadcast(scope: TenantContext, broadcastId: string): Promise<CancelRemainingResult | null> {
  return withTenant(scope, async (tx) => {
    const rows = await tx.$queryRaw<{ id: string }[]>`
      UPDATE broadcasts SET status='cancelled', paused_at=NULL, updated_at=now()
      WHERE account_id=${scope.accountId}::uuid AND id=${broadcastId}::uuid AND status IN ('sending','paused') AND kind<>'api'
      RETURNING id`;
    if (!rows.length) {
      await assertInWorkspace(tx, scope.accountId, broadcastId);
      return null;
    }
    // Intent keys are `${account}:broadcast:${broadcast}:${recipientRow}:${variant}` (broadcastIntentKey);
    // the constant prefix uses outbound_intents_key_prefix_idx. A form-session key is not a send.
    const prefix = `${scope.accountId}:broadcast:${broadcastId}:`;
    const open = await tx.$queryRaw<{ recipient_id: string }[]>`
      SELECT DISTINCT split_part(substr(idempotency_key, ${prefix.length + 1}::int), ':', 1) AS recipient_id
      FROM outbound_intents
      WHERE account_id=${scope.accountId}::uuid AND idempotency_key LIKE ${likePrefix(prefix)}
        AND idempotency_key NOT LIKE '%:form-sessions'
        AND status IN ('pending','dispatching','unknown','accepted')`;
    const held = JSON.stringify(open.map((row) => row.recipient_id).filter((id) => UUID.test(id)));
    const cancelled = await tx.$executeRaw`
      UPDATE broadcast_recipients SET status='cancelled', error_message=NULL
      WHERE account_id=${scope.accountId}::uuid AND broadcast_id=${broadcastId}::uuid AND status='pending'
        AND id NOT IN (SELECT value::uuid FROM jsonb_array_elements_text(${held}::jsonb))`;
    const [{ n }] = await tx.$queryRaw<{ n: number }[]>`
      SELECT count(*)::int AS n FROM broadcast_recipients
      WHERE account_id=${scope.accountId}::uuid AND broadcast_id=${broadcastId}::uuid AND status='pending'`;
    // Tidy queued passes; the dispatcher would also skip a cancelled campaign.
    await tx.$executeRaw`UPDATE jobs SET status='done', updated_at=now()
      WHERE tenant_id=${scope.accountId}::uuid AND type='broadcast.dispatch' AND status='pending'
        AND payload->>'broadcastId'=${broadcastId}`;
    await tx.$executeRaw`INSERT INTO audit_logs(account_id,user_id,action,resource_id,metadata)
      VALUES(${scope.accountId}::uuid,${scope.userId ?? null}::uuid,'campaigns.cancelled_remaining',${broadcastId},
        ${JSON.stringify({ broadcast_id: broadcastId, cancelled, held_for_review: n })}::jsonb)`;
    return { cancelled, heldForReview: n };
  }, getWorkerPrisma());
}
