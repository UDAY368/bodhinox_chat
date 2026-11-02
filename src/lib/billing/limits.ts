// Gates for the metered limits: AI messages and media storage. Server only.
//
//   AI generation:  await requireAiMessageRoom(accountId)   before the provider call
//                   await recordAiMessage(accountId)        after it returned
//   Media upload:   reserveStorage(tx, ...) before the object-store put (checks and records the bytes),
//                   releaseStorage(tx, accountId, reservation) when the put fails
//
// Refusals are PlanLimitError (HTTP 402) whose message names the limit and
// says to upgrade. A workspace without a subscription is unlimited.

import type { PrismaClient } from '@prisma/client';
import { withTenant, type TenantTransaction } from '@/lib/db/tenant';
import { requireWithinLimit } from './entitlements';
import { incrementUsage, usagePeriod } from './usage';

/** AI messages counted this period (IST month). */
export async function aiMessagesUsed(tx: TenantTransaction, accountId: string, at: Date = new Date()): Promise<number> {
  const [row] = await tx.$queryRaw<{ value: bigint }[]>`SELECT COALESCE(max(value), 0)::bigint AS value FROM usage_counters
    WHERE account_id=${accountId}::uuid AND metric='ai_messages' AND period=${usagePeriod(at)}`;
  return Number(row?.value ?? 0);
}

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
  await requireWithinLimit(tx, accountId, 'storage_bytes', (await storageBytesUsed(tx, accountId)) + addedBytes);
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
