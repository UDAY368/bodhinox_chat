// Sequence subscriptions (Stage 5, 5H): how a contact enters and leaves a
// sequence. Called by the flow engine's Actions step (subscribe_sequence,
// unsubscribe_sequence) and its `sequence` condition (5B), by Instagram
// opt-out (5D: endSequencesForContact) and by members on the Sequences page.
//
// Every function takes a tenant transaction of `accountId` (an app session or
// the worker); RLS keeps it to the workspace, and the composite foreign keys
// refuse another workspace's contact or sequence. Subscribing is idempotent:
// an active subscription is left as it is; an ended one starts again from the
// first message. Unsubscribing ends it at once: the worker never sends to an
// ended subscription, and a send already claimed does not reopen it.
import { Prisma } from '@prisma/client';
import { getWorkerPrisma } from '@/lib/db/prisma';
import { withTenant, type TenantTransaction } from '@/lib/db/tenant';
import type { SequenceDelayUnit } from '@/types';
import { dueAt } from './schedule';

export type SubscribeResult = 'subscribed' | 'already_subscribed' | 'unavailable';

/**
 * Subscribes the contact. 'unavailable' when the sequence is archived, not an
 * Instagram sequence or not in this workspace, or the contact is not.
 */
export async function subscribeInTx(tx: TenantTransaction, accountId: string, contactId: string, sequenceId: string,
  now: Date = new Date()): Promise<SubscribeResult> {
  const [target] = await tx.$queryRaw<{ ok: boolean }[]>`
    SELECT true AS ok FROM sequences q
    JOIN contacts c ON c.account_id = q.account_id AND c.id = ${contactId}::uuid
    WHERE q.account_id = ${accountId}::uuid AND q.id = ${sequenceId}::uuid AND q.channel = 'instagram' AND q.status <> 'archived'`;
  if (!target) return 'unavailable';
  // The first message (lowest position) is due its delay after now; no message yet: waits until one is added.
  const [first] = await tx.$queryRaw<{ delay_amount: number; delay_unit: SequenceDelayUnit; position: number }[]>`
    SELECT delay_amount, delay_unit, position FROM sequence_messages
    WHERE account_id = ${accountId}::uuid AND sequence_id = ${sequenceId}::uuid ORDER BY position LIMIT 1`;
  const due = first ? dueAt(now, { amount: first.delay_amount, unit: first.delay_unit }) : null;
  // No row back: a running subscription was left as it is.
  const rows = await tx.$queryRaw<{ ok: number }[]>(Prisma.sql`
    INSERT INTO sequence_subscriptions(account_id, sequence_id, contact_id, subscribed_at, next_position, next_due_at, status)
    VALUES(${accountId}::uuid, ${sequenceId}::uuid, ${contactId}::uuid, ${now}, 0, ${due}, 'active')
    ON CONFLICT (account_id, sequence_id, contact_id) DO UPDATE SET
      status = 'active', subscribed_at = EXCLUDED.subscribed_at, next_position = 0, next_due_at = EXCLUDED.next_due_at,
      claimed_at = NULL, ended_at = NULL
    WHERE sequence_subscriptions.status IN ('completed','unsubscribed')
    RETURNING 1 AS ok`);
  return rows.length ? 'subscribed' : 'already_subscribed';
}

/** Ends the contact's subscription. True when one was running. */
export async function unsubscribeInTx(tx: TenantTransaction, accountId: string, contactId: string, sequenceId: string): Promise<boolean> {
  const ended = await tx.$executeRaw`UPDATE sequence_subscriptions
    SET status = 'unsubscribed', ended_at = now(), next_due_at = NULL, claimed_at = NULL
    WHERE account_id = ${accountId}::uuid AND sequence_id = ${sequenceId}::uuid AND contact_id = ${contactId}::uuid
      AND status IN ('active','sending')`;
  return ended > 0;
}

/** Ends every running subscription of the contact (Instagram opt-out, block). Returns how many ended. */
export async function endSequencesForContact(tx: TenantTransaction, accountId: string, contactId: string): Promise<number> {
  return tx.$executeRaw`UPDATE sequence_subscriptions
    SET status = 'unsubscribed', ended_at = now(), next_due_at = NULL, claimed_at = NULL
    WHERE account_id = ${accountId}::uuid AND contact_id = ${contactId}::uuid AND status IN ('active','sending')`;
}

/** The `sequence` condition: whether the contact has a running subscription to the sequence. */
export async function contactInSequence(tx: TenantTransaction, accountId: string, contactId: string, sequenceId: string): Promise<boolean> {
  const rows = await tx.$queryRaw<{ ok: boolean }[]>`
    SELECT true AS ok FROM sequence_subscriptions
    WHERE account_id = ${accountId}::uuid AND sequence_id = ${sequenceId}::uuid AND contact_id = ${contactId}::uuid
      AND status IN ('active','sending')`;
  return rows.length > 0;
}

/** The same calls from server code that has no transaction (the flow engine): the worker connection, owner scope. */
export const sequenceSubscriptions = {
  subscribe: (accountId: string, contactId: string, sequenceId: string) =>
    withTenant({ accountId, role: 'owner' }, (tx) => subscribeInTx(tx, accountId, contactId, sequenceId), getWorkerPrisma()),
  unsubscribe: (accountId: string, contactId: string, sequenceId: string) =>
    withTenant({ accountId, role: 'owner' }, (tx) => unsubscribeInTx(tx, accountId, contactId, sequenceId), getWorkerPrisma()),
  isSubscribed: (accountId: string, contactId: string, sequenceId: string) =>
    withTenant({ accountId, role: 'owner' }, (tx) => contactInSequence(tx, accountId, contactId, sequenceId), getWorkerPrisma()),
};
