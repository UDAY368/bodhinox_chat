// ============================================================
// Reconciling campaign recipients whose send outcome is uncertain
// (audit 2026-11-10, finding 12).
//
// A send that timed out, lost its connection or got a 5xx from Meta leaves
// its outbound intent 'unknown' (or 'dispatching' when the worker died
// mid-send) and the recipient failed with outcome_uncertain_at set. Such a
// row is never resent automatically; staff check Meta (WhatsApp Manager or
// the customer) and resolve it here:
//   - 'sent': the message did go out. The row becomes sent and its open
//     intents accepted, so nothing resends it.
//   - 'not_sent': it did not. The row stays failed (no longer uncertain) and
//     its open intents become failed, so the next "Retry failed" re-claims
//     them and sends. A wrong 'not_sent' sends the customer a duplicate.
// Each call is one transaction in the member's tenant scope, writes one
// audit_logs row, and never touches a row that is not flagged uncertain.
// Intent keys are `${account}:broadcast:${broadcast}:${recipientRow}:...`
// (broadcastIntentKey); the prefix scan uses outbound_intents_key_prefix_idx.
// ============================================================

import { Prisma } from '@prisma/client';
import type { TenantTransaction } from '@/lib/db/tenant';
import { likePrefix } from '@/lib/flows/replay';
import { UNCERTAIN_SEND_MESSAGE } from '@/lib/whatsapp/broadcast-core';

export type ReconcileResolution = 'sent' | 'not_sent';
export const RECONCILE_RESOLUTIONS: readonly ReconcileResolution[] = ['sent', 'not_sent'];
/** Recipients resolved per request, and listed per page load. */
export const MAX_RECONCILE_BATCH = 200;
/** Stored on a row reconciled as not sent, until "Retry failed" sends it. */
export const RECONCILED_NOT_SENT_MESSAGE = 'Marked not sent after review; use Retry failed to send it';

export class ReconcileError extends Error {
  constructor(public readonly reason: 'not_found') {
    super(reason);
    this.name = 'ReconcileError';
  }
}

/** A row counts as uncertain when flagged, or (rows written before the flag existed) by its error text. */
const uncertainRow = Prisma.sql`r.status='failed' AND (r.outcome_uncertain_at IS NOT NULL OR r.error_message=${UNCERTAIN_SEND_MESSAGE})`;

export interface UncertainRecipient {
  id: string;
  contact_name: string | null;
  contact_phone: string | null;
  error_message: string | null;
  flagged_at: string | null;
}

async function assertBroadcast(tx: TenantTransaction, accountId: string, broadcastId: string, lock: boolean): Promise<void> {
  const found = await tx.$queryRaw<{ id: string }[]>(Prisma.sql`SELECT id::text FROM broadcasts
    WHERE account_id=${accountId}::uuid AND id=${broadcastId}::uuid ${lock ? Prisma.sql`FOR UPDATE` : Prisma.empty}`);
  if (!found.length) throw new ReconcileError('not_found');
}

/** The campaign's uncertain recipients (oldest first, at most MAX_RECONCILE_BATCH) and their total. */
export async function listUncertainRecipients(tx: TenantTransaction, accountId: string, broadcastId: string):
  Promise<{ total: number; recipients: UncertainRecipient[] }> {
  await assertBroadcast(tx, accountId, broadcastId, false);
  const counted = await tx.$queryRaw<{ total: number }[]>(Prisma.sql`SELECT count(*)::int AS total FROM broadcast_recipients r
    WHERE r.account_id=${accountId}::uuid AND r.broadcast_id=${broadcastId}::uuid AND ${uncertainRow}`);
  const rows = await tx.$queryRaw<Array<Omit<UncertainRecipient, 'flagged_at'> & { flagged_at: Date | null }>>(Prisma.sql`
    SELECT r.id::text, c.name AS contact_name, c.phone AS contact_phone, r.error_message, r.outcome_uncertain_at AS flagged_at
    FROM broadcast_recipients r
    LEFT JOIN contacts c ON c.account_id=r.account_id AND c.id=r.contact_id
    WHERE r.account_id=${accountId}::uuid AND r.broadcast_id=${broadcastId}::uuid AND ${uncertainRow}
    ORDER BY r.created_at ASC, r.id ASC LIMIT ${MAX_RECONCILE_BATCH}`);
  return {
    total: counted[0]?.total ?? 0,
    recipients: rows.map((row) => ({ ...row, flagged_at: row.flagged_at ? new Date(row.flagged_at).toISOString() : null })),
  };
}

/**
 * Resolve uncertain recipients of one campaign, in the caller's (member's)
 * transaction. Rows not uncertain (already resolved, or never uncertain) are
 * skipped, so a repeated request changes nothing. Returns the rows resolved.
 */
export async function reconcileBroadcastRecipients(tx: TenantTransaction, args: {
  accountId: string; userId: string; broadcastId: string; recipientIds: string[]; resolution: ReconcileResolution;
}): Promise<{ resolved: number }> {
  const { accountId, userId, broadcastId, resolution } = args;
  // Serialises with another reconcile of the same campaign.
  await assertBroadcast(tx, accountId, broadcastId, true);
  const ids = [...new Set(args.recipientIds)].slice(0, MAX_RECONCILE_BATCH);
  if (!ids.length) return { resolved: 0 };
  const rows = await tx.$queryRaw<{ id: string }[]>(Prisma.sql`SELECT r.id::text FROM broadcast_recipients r
    WHERE r.account_id=${accountId}::uuid AND r.broadcast_id=${broadcastId}::uuid
      AND r.id IN (${Prisma.join(ids.map((id) => Prisma.sql`${id}::uuid`))}) AND ${uncertainRow}
    FOR UPDATE`);
  if (!rows.length) return { resolved: 0 };
  const resolvedIds = rows.map((row) => row.id);

  // Only open intents (never one Meta accepted or refused) of exactly these rows.
  const intentStatus = resolution === 'sent' ? 'accepted' : 'failed';
  const note = resolution === 'sent' ? 'Reconciled as sent by staff' : 'Reconciled as not sent by staff';
  for (const id of resolvedIds) {
    await tx.$executeRaw(Prisma.sql`UPDATE outbound_intents SET status=${intentStatus}, last_error=${note}, updated_at=now()
      WHERE account_id=${accountId}::uuid AND status IN ('pending','dispatching','unknown')
        AND idempotency_key LIKE ${likePrefix(`${accountId}:broadcast:${broadcastId}:${id}:`)}`);
  }

  const idList = Prisma.join(resolvedIds.map((id) => Prisma.sql`${id}::uuid`));
  if (resolution === 'sent') {
    await tx.$executeRaw(Prisma.sql`UPDATE broadcast_recipients
      SET status='sent', sent_at=COALESCE(sent_at, now()), error_message=NULL, outcome_uncertain_at=NULL
      WHERE account_id=${accountId}::uuid AND broadcast_id=${broadcastId}::uuid AND id IN (${idList})`);
    // A campaign every recipient of which had failed now has a sent one. No completion
    // event: the campaign already finished; only its terminal status was wrong.
    await tx.$executeRaw(Prisma.sql`UPDATE broadcasts SET status='sent', updated_at=now()
      WHERE account_id=${accountId}::uuid AND id=${broadcastId}::uuid AND status='failed'`);
  } else {
    await tx.$executeRaw(Prisma.sql`UPDATE broadcast_recipients
      SET error_message=${RECONCILED_NOT_SENT_MESSAGE}, outcome_uncertain_at=NULL
      WHERE account_id=${accountId}::uuid AND broadcast_id=${broadcastId}::uuid AND id IN (${idList})`);
  }

  await tx.$executeRaw(Prisma.sql`INSERT INTO audit_logs(account_id,user_id,action,resource_id,metadata)
    VALUES(${accountId}::uuid,${userId}::uuid,'campaigns.recipients_reconciled',${broadcastId},
      ${JSON.stringify({ broadcast_id: broadcastId, resolution, count: resolvedIds.length, recipient_ids: resolvedIds })}::jsonb)`);
  return { resolved: resolvedIds.length };
}
