// Sequence worker (Stage 5, 5H): sends due sequence messages, one at a time.
//
// A sequence message is an automated send, so Meta's 24-hour rule applies
// when it falls due, not when it was scheduled:
//   1. claim, one transaction, no network call: lock the due subscription
//      (SKIP LOCKED), re-check the contact (blocked or opted out ends the
//      subscription at once), the message (Active switch, a live automation)
//      and the Instagram window. A message that cannot go out is logged
//      'skipped' with its reason (window_closed, ...) and the subscription
//      moves on: nothing is sent. Otherwise the delivery row is written as
//      'starting' and the subscription becomes 'sending' (claimed_at is the
//      lease) in the same transaction.
//   2. start the message's automation for the contact (startFlowById). Every
//      message the automation sends goes through the flow sender, which
//      re-checks the window and sends through an outbound intent.
//   3. settle: the run that started is recorded on the delivery row and the
//      subscription is scheduled for the next message.
// The delivery row is what stops a second start: a claim that a crashed
// worker left behind is taken again after the lease, finds the row and looks
// for the run it started (any run of that automation for the contact since
// the row was written) before it starts anything. Unsubscribing, opting out
// and pausing or archiving the sequence stop it at once.
// Logs carry machine codes only, never message text or contact data.
import { Prisma } from '@prisma/client';
import { instagramAutomatedWindowOpen } from '@/lib/channels/sender';
import { instagramAutomationAllowed } from '@/lib/contacts/channel-consent';
import { getWorkerPrisma } from '@/lib/db/prisma';
import { withTenant, type TenantTransaction } from '@/lib/db/tenant';
import { startFlowById } from '@/lib/flows/engine';
import { instagramConfig } from '@/lib/instagram/config';
import type { SequenceDelayUnit } from '@/types';
import { dueAt } from './schedule';

/** A claim whose worker vanished is taken again after this long (crm_due_sequence_accounts uses the same 10 minutes). */
export const SEQUENCE_CLAIM_LEASE_MS = 10 * 60_000;
/** Another automation is running in the conversation: try this message again later. */
export const SEQUENCE_BUSY_RETRY_MS = 10 * 60_000;
/** Starts tried this many times without a run end as failed (no run exists, so nothing was sent). */
export const SEQUENCE_MAX_ATTEMPTS = 5;
/** Messages handled per job run; the next run continues. */
const RUN_BATCH = 25;

export type SequenceSkipReason =
  | 'window_closed' | 'flow_not_live' | 'inactive' | 'no_conversation' | 'unavailable' | 'channel_off' | 'start_failed';

const workerTenant = <T>(accountId: string, work: (tx: TenantTransaction) => Promise<T>) =>
  withTenant({ accountId, role: 'owner' }, work, getWorkerPrisma());

interface DueRow {
  id: string; sequence_id: string; contact_id: string; status: 'active' | 'sending'; next_position: number;
  subscribed_at: Date; channel: string; blocked_at: Date | null; opted_out_at: Date | null; instagram_opted_out_at: Date | null;
}
interface MessageRow {
  id: string; position: number; active: boolean; flow_id: string | null; flow_status: string | null; flow_user_id: string | null;
  flow_scope: string | null;
}
interface SendRow { id: string; status: string; attempts: number; created_at: Date; conversation_id: string | null; flow_id: string | null }

interface StartJob {
  accountId: string; subscriptionId: string; sequenceId: string; sendId: string; sendCreatedAt: Date; position: number;
  contactId: string; conversationId: string; flowId: string; flowUserId: string;
}
type Claim = { kind: 'none' } | { kind: 'ended' } | { kind: 'start'; job: StartJob };

/**
 * Schedules the next message after `position`, counted from `now`. With no
 * further message the subscription waits (next_due_at NULL) and a message added
 * later reaches it. An ended subscription is never reopened.
 */
async function advance(tx: TenantTransaction, accountId: string, subscriptionId: string, sequenceId: string, position: number,
  now: Date): Promise<void> {
  const [next] = await tx.$queryRaw<{ position: number; delay_amount: number; delay_unit: SequenceDelayUnit }[]>`
    SELECT position, delay_amount, delay_unit FROM sequence_messages
    WHERE account_id = ${accountId}::uuid AND sequence_id = ${sequenceId}::uuid AND position > ${position}
    ORDER BY position LIMIT 1`;
  const nextPosition = next ? next.position : Math.min(position + 1, 50);
  const due = next ? dueAt(now, { amount: next.delay_amount, unit: next.delay_unit }) : null;
  await tx.$executeRaw`UPDATE sequence_subscriptions SET status = 'active', next_position = ${nextPosition}, next_due_at = ${due},
      claimed_at = NULL
    WHERE account_id = ${accountId}::uuid AND id = ${subscriptionId}::uuid AND status IN ('active','sending')`;
}

/** Writes (or finishes) the delivery row; a row already finished is left as it is. Returns the row. */
async function writeSend(tx: TenantTransaction, accountId: string, due: DueRow, message: MessageRow,
  values: { status: 'starting' | 'skipped' | 'failed'; reason: SequenceSkipReason | null; conversationId: string | null; attempt: boolean }):
  Promise<SendRow | null> {
  const [row] = await tx.$queryRaw<SendRow[]>(Prisma.sql`
    INSERT INTO sequence_message_sends(account_id, subscription_id, round_started_at, sequence_id, sequence_message_id, contact_id,
      conversation_id, flow_id, status, reason, attempts)
    VALUES(${accountId}::uuid, ${due.id}::uuid, ${due.subscribed_at}, ${due.sequence_id}::uuid, ${message.id}::uuid,
      ${due.contact_id}::uuid, ${values.conversationId}::uuid, ${message.flow_id}::uuid, ${values.status}, ${values.reason},
      ${values.attempt ? 1 : 0})
    ON CONFLICT (account_id, subscription_id, round_started_at, sequence_message_id) DO UPDATE SET
      status = EXCLUDED.status, reason = EXCLUDED.reason,
      attempts = sequence_message_sends.attempts + EXCLUDED.attempts,
      conversation_id = COALESCE(EXCLUDED.conversation_id, sequence_message_sends.conversation_id),
      flow_id = COALESCE(EXCLUDED.flow_id, sequence_message_sends.flow_id)
    WHERE sequence_message_sends.status = 'starting'
    RETURNING id::text AS id, status, attempts, created_at, conversation_id::text AS conversation_id, flow_id::text AS flow_id`);
  return row ?? null;
}

/** The run a start made (any run of the automation for the contact in that conversation since the row was written). */
async function startedRun(tx: TenantTransaction, accountId: string, send: Pick<SendRow, 'flow_id' | 'conversation_id' | 'created_at'>,
  contactId: string): Promise<string | null> {
  if (!send.flow_id || !send.conversation_id) return null;
  const [run] = await tx.$queryRaw<{ id: string }[]>`
    SELECT id::text AS id FROM flow_runs
    WHERE account_id = ${accountId}::uuid AND flow_id = ${send.flow_id}::uuid AND contact_id = ${contactId}::uuid
      AND conversation_id = ${send.conversation_id}::uuid AND started_at >= ${send.created_at}
    ORDER BY started_at LIMIT 1`;
  return run?.id ?? null;
}

async function markSent(tx: TenantTransaction, accountId: string, sendId: string, runId: string): Promise<void> {
  await tx.$executeRaw`UPDATE sequence_message_sends SET status = 'sent', reason = NULL, flow_run_id = ${runId}::uuid
    WHERE account_id = ${accountId}::uuid AND id = ${sendId}::uuid AND status = 'starting'`;
}

/** Step 1 of the header. */
async function claimNext(accountId: string, now: Date): Promise<Claim> {
  const lease = new Date(now.getTime() - SEQUENCE_CLAIM_LEASE_MS);
  return workerTenant(accountId, async (tx) => {
    const [due] = await tx.$queryRaw<DueRow[]>(Prisma.sql`
      SELECT s.id::text AS id, s.sequence_id::text AS sequence_id, s.contact_id::text AS contact_id, s.status, s.next_position,
        s.subscribed_at, q.channel, c.blocked_at, c.opted_out_at, c.instagram_opted_out_at
      FROM sequence_subscriptions s
      JOIN sequences q ON q.account_id = s.account_id AND q.id = s.sequence_id
      JOIN contacts c ON c.account_id = s.account_id AND c.id = s.contact_id
      WHERE s.account_id = ${accountId}::uuid AND q.status = 'active'
        AND ((s.status = 'active' AND s.next_due_at <= ${now}) OR (s.status = 'sending' AND s.claimed_at < ${lease}))
      ORDER BY s.next_due_at, s.id LIMIT 1 FOR UPDATE OF s SKIP LOCKED`);
    if (!due) return { kind: 'none' };

    // Blocked or opted out (WhatsApp STOP covers every channel; Instagram's own opt-out): ends at once.
    if (due.blocked_at || due.opted_out_at || due.instagram_opted_out_at || !(await instagramAutomationAllowed(accountId, due.contact_id))) {
      await tx.$executeRaw`UPDATE sequence_subscriptions SET status = 'unsubscribed', ended_at = now(), next_due_at = NULL, claimed_at = NULL
        WHERE account_id = ${accountId}::uuid AND id = ${due.id}::uuid`;
      return { kind: 'ended' };
    }

    const [message] = await tx.$queryRaw<MessageRow[]>`
      SELECT m.id::text AS id, m.position, m.active, m.flow_id::text AS flow_id, f.status AS flow_status,
        f.user_id::text AS flow_user_id, f.channel_scope AS flow_scope
      FROM sequence_messages m
      LEFT JOIN flows f ON f.account_id = m.account_id AND f.id = m.flow_id
      WHERE m.account_id = ${accountId}::uuid AND m.sequence_id = ${due.sequence_id}::uuid AND m.position >= ${due.next_position}
      ORDER BY m.position LIMIT 1`;
    if (!message) {
      // Past the last message: wait for one to be added.
      await tx.$executeRaw`UPDATE sequence_subscriptions SET status = 'active', next_due_at = NULL, claimed_at = NULL
        WHERE account_id = ${accountId}::uuid AND id = ${due.id}::uuid`;
      return { kind: 'ended' };
    }

    const [existing] = await tx.$queryRaw<SendRow[]>`
      SELECT id::text AS id, status, attempts, created_at, conversation_id::text AS conversation_id, flow_id::text AS flow_id
      FROM sequence_message_sends
      WHERE account_id = ${accountId}::uuid AND subscription_id = ${due.id}::uuid AND round_started_at = ${due.subscribed_at}
        AND sequence_message_id = ${message.id}::uuid`;
    // Already delivered or skipped in this round (a reorder brought it round again): never twice.
    if (existing && existing.status !== 'starting') {
      await advance(tx, accountId, due.id, due.sequence_id, message.position, now);
      return { kind: 'ended' };
    }
    if (existing) {
      // An earlier start may have reached the engine: its run decides, and no second run is started.
      const runId = await startedRun(tx, accountId, existing, due.contact_id);
      if (runId) {
        await markSent(tx, accountId, existing.id, runId);
        await advance(tx, accountId, due.id, due.sequence_id, message.position, now);
        return { kind: 'ended' };
      }
      if (existing.attempts >= SEQUENCE_MAX_ATTEMPTS) {
        await writeSend(tx, accountId, due, message, { status: 'failed', reason: 'start_failed', conversationId: null, attempt: false });
        await advance(tx, accountId, due.id, due.sequence_id, message.position, now);
        return { kind: 'ended' };
      }
    }

    const skip = async (reason: SequenceSkipReason, conversationId: string | null = null): Promise<Claim> => {
      await writeSend(tx, accountId, due, message, { status: 'skipped', reason, conversationId, attempt: false });
      await advance(tx, accountId, due.id, due.sequence_id, message.position, now);
      return { kind: 'ended' };
    };
    if (due.channel !== 'instagram') return skip('channel_off');
    if (!message.active) return skip('inactive');
    if (!message.flow_id || message.flow_status !== 'active' || !message.flow_user_id
      || (message.flow_scope !== 'instagram' && message.flow_scope !== 'any')) return skip('flow_not_live');
    const [conversation] = await tx.$queryRaw<{ id: string }[]>`
      SELECT id::text AS id FROM conversations
      WHERE account_id = ${accountId}::uuid AND contact_id = ${due.contact_id}::uuid AND channel = 'instagram'
      ORDER BY last_message_at DESC NULLS LAST, created_at DESC LIMIT 1`;
    if (!conversation) return skip('no_conversation');
    // Meta's rule, checked when the message falls due: outside the 24-hour window nothing is sent.
    if (!(await instagramAutomatedWindowOpen(tx, accountId, conversation.id, now))) return skip('window_closed', conversation.id);

    const send = await writeSend(tx, accountId, due, message, { status: 'starting', reason: null, conversationId: conversation.id, attempt: true });
    if (!send) return { kind: 'ended' };
    await tx.$executeRaw`UPDATE sequence_subscriptions SET status = 'sending', claimed_at = ${now}
      WHERE account_id = ${accountId}::uuid AND id = ${due.id}::uuid`;
    return {
      kind: 'start',
      job: {
        accountId, subscriptionId: due.id, sequenceId: due.sequence_id, sendId: send.id, sendCreatedAt: send.created_at, position: message.position,
        contactId: due.contact_id, conversationId: conversation.id, flowId: message.flow_id, flowUserId: message.flow_user_id,
      },
    };
  });
}

/** Step 3: what the start did. */
async function settle(job: StartJob, outcome: 'started' | 'unavailable' | 'conflict', now: Date): Promise<void> {
  await workerTenant(job.accountId, async (tx) => {
    const runId = await startedRun(tx, job.accountId,
      { flow_id: job.flowId, conversation_id: job.conversationId, created_at: job.sendCreatedAt }, job.contactId);
    if (runId && outcome === 'started') {
      await markSent(tx, job.accountId, job.sendId, runId);
    } else if (runId || outcome === 'unavailable') {
      // The automation could not run (a person took over, it stopped being live, or its first step failed).
      await tx.$executeRaw`UPDATE sequence_message_sends SET status = 'skipped', reason = 'unavailable', flow_run_id = ${runId}::uuid
        WHERE account_id = ${job.accountId}::uuid AND id = ${job.sendId}::uuid AND status = 'starting'`;
    } else {
      // Another automation is running in the conversation: nothing started, so try again later (the window is re-checked).
      await tx.$executeRaw`UPDATE sequence_subscriptions SET status = 'active', claimed_at = NULL,
          next_due_at = ${new Date(now.getTime() + SEQUENCE_BUSY_RETRY_MS)}
        WHERE account_id = ${job.accountId}::uuid AND id = ${job.subscriptionId}::uuid AND status = 'sending'`;
      return;
    }
    await advance(tx, job.accountId, job.subscriptionId, job.sequenceId, job.position, now);
  });
}

/**
 * Worker: sends this workspace's due sequence messages, at most RUN_BATCH per
 * run. Returns how many subscriptions it handled. Nothing while Instagram is off
 * (the subscriptions wait).
 */
export async function runDueSequences(accountId: string, now: Date = new Date()): Promise<number> {
  if (!instagramConfig()) return 0;
  let handled = 0;
  for (let i = 0; i < RUN_BATCH; i += 1) {
    const claim = await claimNext(accountId, now);
    if (claim.kind === 'none') break;
    handled += 1;
    if (claim.kind === 'ended') continue;
    const { job } = claim;
    let outcome: 'started' | 'unavailable' | 'conflict';
    try {
      outcome = (await startFlowById({
        accountId, userId: job.flowUserId, contactId: job.contactId, conversationId: job.conversationId, flowId: job.flowId,
        message: { kind: 'text', text: '', meta_message_id: `sequence.${job.sendId}` },
      })).outcome;
    } catch (error) {
      // The claim stays until its lease ends; the next claim looks for the run before starting again.
      console.error('[sequences] start failed', { error: error instanceof Error ? error.name : 'unknown' });
      continue;
    }
    await settle(job, outcome, now);
  }
  return handled;
}
