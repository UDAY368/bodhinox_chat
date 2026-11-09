// Gates for plan limits at the write paths. Server only.
//
//   Count limits:   gateLimit(tx, accountId, key, count, adding) in the SAME transaction as the
//                   write (requireRoomFor: unlimited returns at once; else lock, count, check).
//                   requireSeatRoom, requireActiveAutomationRoom, requireContactRoom,
//                   requireWhatsAppNumberRoom and requireIntegrationRoom are the named gates;
//                   gateWithinLimit for a count the caller already took (active_flows).
//   Campaign sends: requireCampaignSendRoom(tx, accountId, recipients) where a campaign or a
//                   scheduled automation commits its recipients (messages_monthly and
//                   monthly_active_contacts; manual replies and inbound are never gated).
//   AI generation:  reserveAi / settleAi / releaseAi (src/lib/ai/budget.ts, usage_events ledger).
//   Media upload:   reserveStorage(tx, ...) before the object-store put (checks and records the bytes),
//                   releaseStorage(tx, accountId, reservation) when the put fails
//
// Refusals are PlanLimitError (HTTP 402) whose message names the limit and
// says to upgrade; a refusal also records the 100% usage notice. A workspace
// without a subscription is unlimited. Inbound (customers writing in) is never gated.

import type { PrismaClient } from '@prisma/client';
import { withTenant, type TenantTransaction } from '@/lib/db/tenant';
import { PlanLimitError, requireRoomFor, requireWithinLimit } from './entitlements';
import type { LimitKey } from './entitlements-catalogue';
import { countIntegrations } from './integration-count';
import { BILLING_TIME_ZONE, incrementUsage, monthlyActiveContacts, usagePeriod } from './usage';
import { notifyLimitRefused } from './usage-notices';

/**
 * requireRoomFor plus the 100% usage notice when it refuses. The check and the
 * caller's write must be in one transaction (`tx`).
 */
export async function gateLimit(tx: TenantTransaction, accountId: string, key: LimitKey, count: () => Promise<number>, adding = 1): Promise<void> {
  try {
    await requireRoomFor(tx, accountId, key, count, adding);
  } catch (error) {
    if (error instanceof PlanLimitError) await notifyLimitRefused(accountId, key);
    throw error;
  }
}

/**
 * requireWithinLimit plus the 100% usage notice when it refuses, for count keys
 * checked against a count the caller already took (active_flows, storage_bytes).
 * Not for campaign_recipients, which is a per-campaign size, not a usage level.
 */
export async function gateWithinLimit(tx: TenantTransaction, accountId: string, key: LimitKey, wanted: number): Promise<void> {
  try {
    await requireWithinLimit(tx, accountId, key, wanted);
  } catch (error) {
    if (error instanceof PlanLimitError) await notifyLimitRefused(accountId, key);
    throw error;
  }
}

/**
 * Before this workspace adds ANOTHER WhatsApp number (a new whatsapp_config
 * row): connected numbers and ones mid-setup count; a number an admin removed
 * (disconnected, token cleared) frees its slot. Reconnecting or updating a row
 * the workspace already has never calls this, so existing numbers are never
 * blocked. Serialised per workspace for the rest of the transaction.
 */
export async function requireWhatsAppNumberRoom(tx: TenantTransaction, accountId: string): Promise<void> {
  await gateLimit(tx, accountId, 'whatsapp_numbers', async () => {
    const [row] = await tx.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM whatsapp_config
      WHERE account_id=${accountId}::uuid AND NOT (status='disconnected' AND access_token='')`;
    return row?.n ?? 0;
  });
}

/** Members plus open (unaccepted, unexpired) invitations: what 'seats' counts. */
export async function countSeats(tx: TenantTransaction, accountId: string): Promise<number> {
  const [row] = await tx.$queryRaw<{ n: number }[]>`SELECT (
      (SELECT count(*) FROM account_memberships m WHERE m.account_id=${accountId}::uuid)
    + (SELECT count(*) FROM account_invitations i WHERE i.account_id=${accountId}::uuid AND i.accepted_at IS NULL AND i.expires_at > now())
    )::int AS n`;
  return row?.n ?? 0;
}

/** Before creating an invitation, in the transaction that inserts it. */
export async function requireSeatRoom(tx: TenantTransaction, accountId: string): Promise<void> {
  await gateLimit(tx, accountId, 'seats', () => countSeats(tx, accountId));
}

/**
 * Before turning an automation on, in the transaction that sets is_active.
 * `automationId` is the one being activated (it never counts twice).
 */
export async function requireActiveAutomationRoom(tx: TenantTransaction, accountId: string, automationId: string): Promise<void> {
  await gateLimit(tx, accountId, 'active_automations', async () => {
    const [row] = await tx.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM automations
      WHERE account_id=${accountId}::uuid AND is_active AND id<>${automationId}::uuid`;
    return row?.n ?? 0;
  });
}

/**
 * Before a member, an import or the public API creates `adding` contacts, in
 * the transaction that inserts them. Inbound-created contacts (WhatsApp,
 * Instagram, storefront, booking, webhooks) never call this: customers who
 * write in are always added, even over the limit.
 */
export async function requireContactRoom(tx: TenantTransaction, accountId: string, adding = 1): Promise<void> {
  await gateLimit(tx, accountId, 'contacts', async () => {
    const [row] = await tx.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM contacts WHERE account_id=${accountId}::uuid`;
    return row?.n ?? 0;
  }, adding);
}

/**
 * Outbound messages this IST month for the messages_monthly gate: messages
 * already sent by an agent or a bot, plus campaign recipients still waiting to
 * be sent (queued campaigns use up the allowance before they go out, so two
 * campaigns created back to back cannot both pass). Uncached, unlike the meter.
 */
export async function outboundMessagesCommitted(tx: TenantTransaction, accountId: string): Promise<number> {
  const [row] = await tx.$queryRaw<{ n: bigint }[]>`
    WITH month AS (SELECT date_trunc('month', now() AT TIME ZONE ${BILLING_TIME_ZONE}) AT TIME ZONE ${BILLING_TIME_ZONE} AS start)
    SELECT ((SELECT count(*) FROM messages m, month
        WHERE m.account_id=${accountId}::uuid AND m.created_at >= month.start AND m.sender_type IN ('agent','bot'))
      + (SELECT count(*) FROM broadcast_recipients r, month
        WHERE r.account_id=${accountId}::uuid AND r.status='pending' AND r.created_at >= month.start))::bigint AS n`;
  return Number(row?.n ?? 0);
}

/**
 * Before a campaign (a broadcast, an API campaign batch, or a scheduled
 * automation's occurrence) commits `recipients` more outbound messages, in the
 * transaction that creates them. Two monthly limits apply:
 *   messages_monthly         sent + queued this month + `recipients` may not pass the limit;
 *   monthly_active_contacts  refused once the month's active contacts have reached the limit
 *                            (a campaign is how a workspace reaches new contacts).
 * Manual agent replies, bot replies to customers who wrote in, and inbound
 * messages never call this, so a customer conversation is never cut off.
 * Refusals are PlanLimitError (402 'plan_limit') naming the limit, and record
 * the 100% usage notice. Unlimited limits return at once with no lock or count.
 */
export async function requireCampaignSendRoom(tx: TenantTransaction, accountId: string, recipients: number): Promise<void> {
  if (!(recipients > 0)) return;
  await gateLimit(tx, accountId, 'messages_monthly', () => outboundMessagesCommitted(tx, accountId), recipients);
  await gateLimit(tx, accountId, 'monthly_active_contacts', () => monthlyActiveContacts(tx, accountId), 1);
}

/** AI messages counted this period (IST month). */
export async function aiMessagesUsed(tx: TenantTransaction, accountId: string, at: Date = new Date()): Promise<number> {
  const [row] = await tx.$queryRaw<{ value: bigint }[]>`SELECT COALESCE(max(value), 0)::bigint AS value FROM usage_counters
    WHERE account_id=${accountId}::uuid AND metric='ai_messages' AND period=${usagePeriod(at)}`;
  return Number(row?.value ?? 0);
}

/** AI tokens counted this period (IST month), across every AI feature (metric 'ai_tokens'). */
export async function aiTokensUsed(tx: TenantTransaction, accountId: string, at: Date = new Date()): Promise<number> {
  const [row] = await tx.$queryRaw<{ value: bigint }[]>`SELECT COALESCE(max(value), 0)::bigint AS value FROM usage_counters
    WHERE account_id=${accountId}::uuid AND metric='ai_tokens' AND period=${usagePeriod(at)}`;
  return Number(row?.value ?? 0);
}

/**
 * Before inserting a NEW integration connection row (payment provider, store,
 * meeting, courier, ads), in the same transaction as the insert. Reconnecting
 * or updating an existing row never calls this.
 */
export async function requireIntegrationRoom(tx: TenantTransaction, accountId: string): Promise<void> {
  await gateLimit(tx, accountId, 'integrations', () => countIntegrations(tx, accountId));
}

// AI generations are metered through reserveAi/settleAi (src/lib/ai/budget.ts), once per source
// event. These two remain for the read-only pre-check (requireAiBudget) and the downgrade test.
/** Throws PlanLimitError when one more AI generation would exceed the plan's monthly AI messages. */
export async function requireAiMessageRoom(accountId: string, db?: PrismaClient): Promise<void> {
  await withTenant({ accountId }, async (tx) => {
    await requireWithinLimit(tx, accountId, 'ai_messages', (await aiMessagesUsed(tx, accountId)) + 1);
  }, db);
}

/**
 * Counts one AI generation. Never throws: the generation already happened and
 * the reply must not fail on accounting. Only the error class is logged.
 */
export async function recordAiMessage(accountId: string, db?: PrismaClient): Promise<void> {
  try {
    await withTenant({ accountId }, (tx) => incrementUsage(tx, 'ai_messages'), db);
  } catch (error) {
    console.error('[billing] AI message count failed', error instanceof Error ? error.name : 'unknown');
  }
}

/**
 * Bytes of member-uploaded media the workspace stores (not deleted). Inbound
 * customer media the worker mirrors into chat-media under account-<id>/inbound/
 * is excluded: it is never refused, so it must not use up the room members
 * need for uploads and reply attachments. Keep in step with currentUsage.
 */
export async function storageBytesUsed(tx: TenantTransaction, accountId: string): Promise<number> {
  const [row] = await tx.$queryRaw<{ bytes: bigint }[]>`SELECT COALESCE(sum(byte_size), 0)::bigint AS bytes FROM media_objects
    WHERE account_id=${accountId}::uuid AND deleted_at IS NULL
      AND NOT (bucket='chat-media' AND object_key LIKE 'account-' || account_id::text || '/inbound/%')`;
  return Number(row?.bytes ?? 0);
}

/**
 * Throws PlanLimitError when storing `addedBytes` more would exceed the plan's
 * storage. A replacement passes only the growth; zero or less always passes.
 * Serialised per workspace only until this transaction ends, so the bytes must
 * be recorded in the same transaction (reserveStorage does both).
 */
export async function requireStorageRoom(tx: TenantTransaction, accountId: string, addedBytes: number): Promise<void> {
  if (!(addedBytes > 0)) return;
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`${accountId}:storage_bytes`}))`;
  await gateWithinLimit(tx, accountId, 'storage_bytes', (await storageBytesUsed(tx, accountId)) + addedBytes);
}

export interface StorageReservation {
  id: string;
  /** This upload created the media_objects row (released by removing it). */
  created: boolean;
  /** The row's size before the reservation (restored on release). */
  previousBytes: number;
  bytes: number;
}

/**
 * Checks the plan's storage (when `enforce`) and records the object's bytes in
 * the same locked transaction, BEFORE the object-store put. A concurrent upload
 * waits for the lock and then counts these bytes, so two uploads can never both
 * pass on the same total. A replacement keeps the larger of the old and new size
 * until the put is done. Throws 'Object already exists' for an existing key
 * without `upsert`. On a failed put call releaseStorage.
 */
export async function reserveStorage(tx: TenantTransaction, input: {
  accountId: string; uploadedBy: string | null; bucket: string; objectKey: string; contentType: string; bytes: number; upsert: boolean; enforce: boolean;
}): Promise<StorageReservation> {
  const { accountId, bucket, objectKey, bytes } = input;
  // One writer per key: a concurrent upload of the same key waits and then sees this row.
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`${accountId}:media:${bucket}:${objectKey}`}))`;
  const [row] = await tx.$queryRaw<{ id: string; byte_size: bigint; deleted: boolean }[]>`
    SELECT id::text, byte_size, deleted_at IS NOT NULL AS deleted FROM media_objects
    WHERE account_id=${accountId}::uuid AND bucket=${bucket} AND object_key=${objectKey}`;
  if (row && !input.upsert) throw new Error('Object already exists');
  const previousBytes = row ? Number(row.byte_size) : 0;
  if (input.enforce) await requireStorageRoom(tx, accountId, bytes - (row && !row.deleted ? previousBytes : 0));
  if (row) {
    await tx.$executeRaw`UPDATE media_objects SET byte_size=GREATEST(byte_size, ${bytes}) WHERE account_id=${accountId}::uuid AND id=${row.id}::uuid`;
    return { id: row.id, created: false, previousBytes, bytes };
  }
  const [created] = await tx.$queryRaw<{ id: string }[]>`
    INSERT INTO media_objects(account_id,uploaded_by,bucket,object_key,content_type,byte_size)
    VALUES(${accountId}::uuid,${input.uploadedBy}::uuid,${bucket},${objectKey},${input.contentType},${bytes}) RETURNING id::text`;
  return { id: created.id, created: true, previousBytes: 0, bytes };
}

/** Undoes a reservation whose object-store put failed, unless a later upload of the same key has changed the row since. */
export async function releaseStorage(tx: TenantTransaction, accountId: string, r: StorageReservation): Promise<void> {
  if (r.created)
    await tx.$executeRaw`DELETE FROM media_objects WHERE account_id=${accountId}::uuid AND id=${r.id}::uuid AND byte_size=${r.bytes}`;
  else
    await tx.$executeRaw`UPDATE media_objects SET byte_size=${r.previousBytes}
      WHERE account_id=${accountId}::uuid AND id=${r.id}::uuid AND byte_size=${Math.max(r.previousBytes, r.bytes)}`;
}
