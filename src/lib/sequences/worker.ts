// Sequence worker (Stage 5, 5H; WhatsApp and "Exit when" in batch 7): sends
// due sequence messages, one at a time.
//
// A sequence message is an automated send, so Meta's 24-hour rule applies
// when it falls due, not when it was scheduled:
//   1. claim, one transaction, no network call: lock the due subscription
//      (SKIP LOCKED), re-check the contact (blocked or opted out ends the
//      subscription at once, with its exit_reason), resolve a send an earlier
//      claim left behind, check "Exit when" (replied, tagged, bought since
//      joining: the subscription completes with its exit_reason), then the
//      message and the window. A message that cannot go out is logged
//      'skipped' with its reason and the subscription moves on: nothing is
//      sent. Otherwise the delivery row is written as 'starting' and the
//      subscription becomes 'sending' (claimed_at is the lease) in the same
//      transaction.
//   2. Instagram: start the message's automation for the contact
//      (startFlowById); every message it sends goes through the flow sender,
//      which re-checks the window and sends through an outbound intent.
//      WhatsApp: send the step (text or media inside the window, else its
//      approved template) through dispatchOnce, keyed by the delivery row.
//   3. settle: the run (Instagram) or the WhatsApp message id is recorded on
//      the delivery row and the subscription is scheduled for the next message.
// The delivery row is what stops a second send: a claim that a crashed worker
// left behind is taken again after the lease and finds the row. Instagram looks
// for the run it started; WhatsApp reads the row's outbound intent: accepted is
// sent, rejected is failed, and an uncertain one is recorded outcome_unknown and
// never sent again (staff reconcile it). Unsubscribing, opting out and pausing
// or archiving the sequence stop it at once.
// Logs carry machine codes only, never message text or contact data.
import { Prisma } from '@prisma/client';
import { resolveAuditUserId } from '@/lib/api/v1/contacts';
import { engineSendTemplate, engineSendText } from '@/lib/automations/meta-send';
import { isSuspended } from '@/lib/billing/suspension';
import { instagramAutomatedWindowOpen } from '@/lib/channels/sender';
import { pickConversation, rejectedByProvider, windowOpen } from '@/lib/commerce/cart-followup-jobs';
import { instagramAutomationAllowed } from '@/lib/contacts/channel-consent';
import { marketingSuppression } from '@/lib/contacts/consent';
import { createAdminClient } from '@/lib/data/admin';
import { getWorkerPrisma } from '@/lib/db/prisma';
import { withTenant, type TenantTransaction } from '@/lib/db/tenant';
import { startFlowById } from '@/lib/flows/engine';
import { engineSendMedia } from '@/lib/flows/meta-send';
import { customPlaceholderIds, fillPlaceholders, type PlaceholderContact } from '@/lib/flows/placeholders';
import { instagramConfig } from '@/lib/instagram/config';
import { dispatchOnce, UncertainDispatchError } from '@/lib/jobs/dispatch';
import { assertWhatsAppConversation, getNumberConfig, isNumberDisconnected, NoNumberError } from '@/lib/whatsapp/numbers';
import { assertTemplateOnNumber } from '@/lib/whatsapp/sender-config';
import { extractVariableIndices } from '@/lib/whatsapp/template-validators';
import type { SequenceDelayUnit } from '@/types';
import { dueAt } from './schedule';
import { loadStepTemplate, stepTemplateRefusal } from './templates';
import {
  chooseWhatsAppSend,
  exitReason,
  fillTemplateParams,
  type ExitFacts,
  type SequenceExitReason,
  type WaMediaType,
} from './whatsapp';

/** A claim whose worker vanished is taken again after this long (crm_due_sequence_accounts uses the same 10 minutes). */
export const SEQUENCE_CLAIM_LEASE_MS = 10 * 60_000;
/** Another automation is running in the conversation (or WhatsApp cannot send right now): try this message again later. */
export const SEQUENCE_BUSY_RETRY_MS = 10 * 60_000;
/** Starts tried this many times without a run end as failed (no run exists, so nothing was sent). */
export const SEQUENCE_MAX_ATTEMPTS = 5;
/** Messages handled per job run; the next run continues. */
const RUN_BATCH = 25;

export type SequenceSkipReason =
  | 'window_closed' | 'flow_not_live' | 'inactive' | 'no_conversation' | 'unavailable' | 'channel_off' | 'start_failed'
  | 'outside_window_no_template' | 'template_unavailable' | 'no_content' | 'bot_paused' | 'provider_rejected' | 'outcome_unknown';

/** The outbound intent of one WhatsApp sequence delivery row (dispatchOnce prefixes the workspace). */
export const sequenceSendIntentKey = (sendId: string) => `sequence_send:${sendId}`;

const workerTenant = <T>(accountId: string, work: (tx: TenantTransaction) => Promise<T>) =>
  withTenant({ accountId, role: 'owner' }, work, getWorkerPrisma());

interface DueRow {
  id: string; sequence_id: string; contact_id: string; status: 'active' | 'sending'; next_position: number;
  subscribed_at: Date; channel: 'instagram' | 'whatsapp'; blocked_at: Date | null; opted_out_at: Date | null;
  instagram_opted_out_at: Date | null; exit_on_reply: boolean; exit_on_tag_id: string | null; exit_on_purchase: boolean;
}
interface MessageRow {
  id: string; position: number; active: boolean; flow_id: string | null; flow_status: string | null; flow_user_id: string | null;
  flow_scope: string | null; wa_text: string | null; wa_media_type: WaMediaType | null; wa_media_url: string | null;
  wa_media_filename: string | null; template_name: string | null; template_language: string | null; template_params: unknown;
}
interface SendRow {
  id: string; status: string; attempts: number; created_at: Date; conversation_id: string | null; flow_id: string | null;
  sent_as: 'message' | 'template' | null;
}

interface StartJob {
  accountId: string; subscriptionId: string; sequenceId: string; sendId: string; sendCreatedAt: Date; position: number;
  contactId: string; conversationId: string; flowId: string; flowUserId: string;
}
interface WhatsAppJob {
  accountId: string; subscriptionId: string; sequenceId: string; sendId: string; position: number; contactId: string;
  conversationId: string;
  send:
    | { kind: 'text'; text: string }
    | { kind: 'media'; type: WaMediaType; url: string; caption: string | null; filename: string | null }
    | { kind: 'template'; name: string; language: string | null; values: string[] };
}
type Claim = { kind: 'none' } | { kind: 'ended' } | { kind: 'start'; job: StartJob } | { kind: 'whatsapp'; job: WhatsAppJob };

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

/** Try the same message again later (nothing was written for it). */
async function deferSubscription(tx: TenantTransaction, accountId: string, subscriptionId: string, now: Date): Promise<void> {
  await tx.$executeRaw`UPDATE sequence_subscriptions SET status = 'active', claimed_at = NULL,
      next_due_at = ${new Date(now.getTime() + SEQUENCE_BUSY_RETRY_MS)}
    WHERE account_id = ${accountId}::uuid AND id = ${subscriptionId}::uuid AND status IN ('active','sending')`;
}

/** Writes (or finishes) the delivery row; a row already finished is left as it is. Returns the row. */
async function writeSend(tx: TenantTransaction, accountId: string, due: DueRow, message: MessageRow,
  values: { status: 'starting' | 'skipped' | 'failed'; reason: SequenceSkipReason | null; conversationId: string | null; attempt: boolean;
    sentAs?: 'message' | 'template' }):
  Promise<SendRow | null> {
  const [row] = await tx.$queryRaw<SendRow[]>(Prisma.sql`
    INSERT INTO sequence_message_sends(account_id, subscription_id, round_started_at, sequence_id, sequence_message_id, contact_id,
      conversation_id, flow_id, status, reason, attempts, sent_as)
    VALUES(${accountId}::uuid, ${due.id}::uuid, ${due.subscribed_at}, ${due.sequence_id}::uuid, ${message.id}::uuid,
      ${due.contact_id}::uuid, ${values.conversationId}::uuid, ${message.flow_id}::uuid, ${values.status}, ${values.reason},
      ${values.attempt ? 1 : 0}, ${values.sentAs ?? null})
    ON CONFLICT (account_id, subscription_id, round_started_at, sequence_message_id) DO UPDATE SET
      status = EXCLUDED.status, reason = EXCLUDED.reason,
      attempts = sequence_message_sends.attempts + EXCLUDED.attempts,
      conversation_id = COALESCE(EXCLUDED.conversation_id, sequence_message_sends.conversation_id),
      flow_id = COALESCE(EXCLUDED.flow_id, sequence_message_sends.flow_id),
      sent_as = COALESCE(EXCLUDED.sent_as, sequence_message_sends.sent_as)
    WHERE sequence_message_sends.status = 'starting'
    RETURNING id::text AS id, status, attempts, created_at, conversation_id::text AS conversation_id, flow_id::text AS flow_id, sent_as`);
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

/** Finishes a WhatsApp delivery row: sent with its message id, or failed with a reason. */
async function finishWhatsAppSend(tx: TenantTransaction, accountId: string, sendId: string,
  outcome: { messageId: string } | { reason: 'provider_rejected' | 'outcome_unknown' }): Promise<void> {
  if ('messageId' in outcome)
    await tx.$executeRaw`UPDATE sequence_message_sends SET status = 'sent', reason = NULL, channel_message_id = ${outcome.messageId}
      WHERE account_id = ${accountId}::uuid AND id = ${sendId}::uuid AND status = 'starting'`;
  else
    await tx.$executeRaw`UPDATE sequence_message_sends SET status = 'failed', reason = ${outcome.reason}
      WHERE account_id = ${accountId}::uuid AND id = ${sendId}::uuid AND status = 'starting'`;
}

/**
 * What a WhatsApp delivery row's outbound intent says: 'none' when no send was
 * ever attempted (safe to plan again), else its outcome. An intent still
 * 'dispatching' after the lease, or 'unknown', may have reached Meta.
 */
async function intentOutcome(tx: TenantTransaction, accountId: string, sendId: string):
  Promise<'none' | { messageId: string } | { reason: 'provider_rejected' | 'outcome_unknown' }> {
  const [intent] = await tx.$queryRaw<{ status: string; message_id: string | null }[]>`
    SELECT status, result->>'whatsapp_message_id' AS message_id FROM outbound_intents
    WHERE account_id = ${accountId}::uuid AND idempotency_key = ${`${accountId}:${sequenceSendIntentKey(sendId)}`}`;
  if (!intent) return 'none';
  if (intent.status === 'accepted') return intent.message_id ? { messageId: intent.message_id } : { reason: 'outcome_unknown' };
  if (intent.status === 'failed') return { reason: 'provider_rejected' };
  return { reason: 'outcome_unknown' };
}

/**
 * "Exit when", read at send time with indexed lookups: a customer message in
 * any of the contact's conversations after joining, the chosen tag, or a paid
 * order created after joining. A setting that is off is not read.
 */
async function exitFacts(tx: TenantTransaction, accountId: string, due: DueRow): Promise<ExitFacts> {
  if (!due.exit_on_reply && !due.exit_on_tag_id && !due.exit_on_purchase) return { replied: false, tagged: false, purchased: false };
  const [row] = await tx.$queryRaw<ExitFacts[]>`
    SELECT
      (${due.exit_on_reply} AND EXISTS (SELECT 1 FROM conversations c
        JOIN messages m ON m.account_id = c.account_id AND m.conversation_id = c.id
        WHERE c.account_id = ${accountId}::uuid AND c.contact_id = ${due.contact_id}::uuid
          AND m.sender_type = 'customer' AND m.created_at > ${due.subscribed_at})) AS replied,
      (${due.exit_on_tag_id}::uuid IS NOT NULL AND EXISTS (SELECT 1 FROM contact_tags t
        WHERE t.account_id = ${accountId}::uuid AND t.contact_id = ${due.contact_id}::uuid AND t.tag_id = ${due.exit_on_tag_id}::uuid)) AS tagged,
      (${due.exit_on_purchase} AND EXISTS (SELECT 1 FROM orders o
        WHERE o.account_id = ${accountId}::uuid AND o.contact_id = ${due.contact_id}::uuid
          AND o.paid_at IS NOT NULL AND o.created_at >= ${due.subscribed_at})) AS purchased`;
  return row;
}

async function endSubscription(tx: TenantTransaction, accountId: string, subscriptionId: string,
  status: 'completed' | 'unsubscribed', reason: SequenceExitReason | 'opted_out' | 'blocked'): Promise<void> {
  await tx.$executeRaw`UPDATE sequence_subscriptions SET status = ${status}, ended_at = now(), next_due_at = NULL, claimed_at = NULL,
      exit_reason = ${reason}
    WHERE account_id = ${accountId}::uuid AND id = ${subscriptionId}::uuid`;
}

/** The contact values a WhatsApp step may fill in ({{contact.name}}, {{custom.<id>}}). */
async function placeholderContact(tx: TenantTransaction, accountId: string, contactId: string, texts: string[]): Promise<PlaceholderContact> {
  const [contact] = await tx.$queryRaw<{ name: string | null; email: string | null; phone: string | null; company: string | null }[]>`
    SELECT name, email, phone, company FROM contacts WHERE account_id = ${accountId}::uuid AND id = ${contactId}::uuid`;
  const ids = [...new Set(texts.flatMap((text) => customPlaceholderIds(text)))];
  const custom: Record<string, string | null> = {};
  if (ids.length) {
    const rows = await tx.$queryRaw<{ id: string; value: string | null }[]>`
      SELECT custom_field_id::text AS id, value FROM contact_custom_values
      WHERE account_id = ${accountId}::uuid AND contact_id = ${contactId}::uuid AND custom_field_id = ANY(${ids}::uuid[])`;
    for (const row of rows) custom[row.id.toLowerCase()] = row.value;
  }
  return { fields: { name: contact?.name, email: contact?.email, phone: contact?.phone, company: contact?.company }, custom };
}

type ClaimTools = {
  skip: (reason: SequenceSkipReason, conversationId?: string | null) => Promise<Claim>;
};

/** Step 1 for a WhatsApp step, after the shared checks. */
async function planWhatsApp(tx: TenantTransaction, accountId: string, due: DueRow, message: MessageRow, now: Date,
  { skip }: ClaimTools): Promise<Claim> {
  if (!message.active) return skip('inactive');
  const conversation = await pickConversation(tx, accountId, due.contact_id, null);
  if (!conversation || conversation.channel !== 'whatsapp') return skip('no_conversation');
  // Not a service message: an agent's takeover of the chat holds the step back (it is logged, not sent late).
  if (conversation.bot_paused) return skip('bot_paused', conversation.id);
  // A suspended workspace or a number that cannot send: nothing is claimed; try again later.
  if (await isSuspended(tx, accountId)) {
    await deferSubscription(tx, accountId, due.id, now);
    return { kind: 'ended' };
  }
  let config;
  try {
    assertWhatsAppConversation(conversation);
    config = await getNumberConfig(tx, accountId, conversation.whatsapp_config_id);
  } catch (error) {
    if (!(error instanceof NoNumberError)) throw error;
    config = null;
  }
  if (!config || isNumberDisconnected(config)) {
    await deferSubscription(tx, accountId, due.id, now);
    return { kind: 'ended' };
  }

  const params = Array.isArray(message.template_params) ? message.template_params.filter((p): p is string => typeof p === 'string') : [];
  const plan = chooseWhatsAppSend({
    text: message.wa_text,
    media: message.wa_media_type && message.wa_media_url ? { type: message.wa_media_type, url: message.wa_media_url, filename: message.wa_media_filename } : null,
    template: message.template_name ? { name: message.template_name, language: message.template_language, params } : null,
  }, windowOpen(conversation, now));
  if (plan.kind === 'skip') return skip(plan.reason, conversation.id);

  let send: WhatsAppJob['send'];
  if (plan.kind === 'template') {
    const template = await loadStepTemplate(tx, accountId, message.template_name!, message.template_language);
    let refused = stepTemplateRefusal(template) !== null;
    if (!refused) {
      try {
        assertTemplateOnNumber(template, config);
      } catch {
        refused = true;
      }
    }
    if (refused || !template) return skip('template_unavailable', conversation.id);
    const indices = extractVariableIndices(template.body_text ?? '');
    const count = indices.length ? Math.max(...indices) : 0;
    const contact = await placeholderContact(tx, accountId, due.contact_id, params);
    send = { kind: 'template', name: template.name, language: template.language, values: fillTemplateParams(params, count, contact) };
  } else {
    const raw = message.wa_text ?? '';
    const text = raw ? fillPlaceholders(raw, {}, {}, await placeholderContact(tx, accountId, due.contact_id, [raw])).trim() : '';
    if (message.wa_media_type && message.wa_media_url)
      send = { kind: 'media', type: message.wa_media_type, url: message.wa_media_url, caption: text || null, filename: message.wa_media_filename };
    else if (text) send = { kind: 'text', text };
    else return skip('no_content', conversation.id);
  }

  const row = await writeSend(tx, accountId, due, message, {
    status: 'starting', reason: null, conversationId: conversation.id, attempt: true, sentAs: plan.kind,
  });
  if (!row) return { kind: 'ended' };
  await tx.$executeRaw`UPDATE sequence_subscriptions SET status = 'sending', claimed_at = ${now}
    WHERE account_id = ${accountId}::uuid AND id = ${due.id}::uuid`;
  return {
    kind: 'whatsapp',
    job: {
      accountId, subscriptionId: due.id, sequenceId: due.sequence_id, sendId: row.id, position: message.position, contactId: due.contact_id,
      conversationId: conversation.id, send,
    },
  };
}

/** Step 1 of the header. */
async function claimNext(accountId: string, now: Date, instagramOn: boolean): Promise<Claim> {
  const lease = new Date(now.getTime() - SEQUENCE_CLAIM_LEASE_MS);
  return workerTenant(accountId, async (tx) => {
    const [due] = await tx.$queryRaw<DueRow[]>(Prisma.sql`
      SELECT s.id::text AS id, s.sequence_id::text AS sequence_id, s.contact_id::text AS contact_id, s.status, s.next_position,
        s.subscribed_at, q.channel, c.blocked_at, c.opted_out_at, c.instagram_opted_out_at,
        q.exit_on_reply, q.exit_on_tag_id::text AS exit_on_tag_id, q.exit_on_purchase
      FROM sequence_subscriptions s
      JOIN sequences q ON q.account_id = s.account_id AND q.id = s.sequence_id
      JOIN contacts c ON c.account_id = s.account_id AND c.id = s.contact_id
      WHERE s.account_id = ${accountId}::uuid AND q.status = 'active' AND (q.channel = 'whatsapp' OR ${instagramOn})
        AND ((s.status = 'active' AND s.next_due_at <= ${now}) OR (s.status = 'sending' AND s.claimed_at < ${lease}))
      ORDER BY s.next_due_at, s.id LIMIT 1 FOR UPDATE OF s SKIP LOCKED`);
    if (!due) return { kind: 'none' };
    const whatsapp = due.channel === 'whatsapp';

    // Consent ends the subscription at once. WhatsApp: the same rule as campaigns (blocked or opted out).
    // Instagram: WhatsApp STOP covers every channel, plus Instagram's own opt-out.
    if (whatsapp) {
      const refusal = marketingSuppression({
        blocked_at: due.blocked_at?.toISOString() ?? null, opted_out_at: due.opted_out_at?.toISOString() ?? null,
      });
      if (refusal) {
        await endSubscription(tx, accountId, due.id, 'unsubscribed', due.blocked_at ? 'blocked' : 'opted_out');
        return { kind: 'ended' };
      }
    } else if (due.blocked_at || due.opted_out_at || due.instagram_opted_out_at || !(await instagramAutomationAllowed(accountId, due.contact_id))) {
      await endSubscription(tx, accountId, due.id, 'unsubscribed', due.blocked_at ? 'blocked' : 'opted_out');
      return { kind: 'ended' };
    }

    const [message] = await tx.$queryRaw<MessageRow[]>`
      SELECT m.id::text AS id, m.position, m.active, m.flow_id::text AS flow_id, f.status AS flow_status,
        f.user_id::text AS flow_user_id, f.channel_scope AS flow_scope, m.wa_text, m.wa_media_type, m.wa_media_url,
        m.wa_media_filename, m.template_name, m.template_language, m.template_params
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
      SELECT id::text AS id, status, attempts, created_at, conversation_id::text AS conversation_id, flow_id::text AS flow_id, sent_as
      FROM sequence_message_sends
      WHERE account_id = ${accountId}::uuid AND subscription_id = ${due.id}::uuid AND round_started_at = ${due.subscribed_at}
        AND sequence_message_id = ${message.id}::uuid`;
    // Already delivered or skipped in this round (a reorder brought it round again): never twice.
    if (existing && existing.status !== 'starting') {
      await advance(tx, accountId, due.id, due.sequence_id, message.position, now);
      return { kind: 'ended' };
    }
    if (existing) {
      if (whatsapp) {
        // An earlier claim may have sent it: its outbound intent decides, and nothing is sent twice.
        const outcome = await intentOutcome(tx, accountId, existing.id);
        if (outcome !== 'none') {
          await finishWhatsAppSend(tx, accountId, existing.id, outcome);
          await advance(tx, accountId, due.id, due.sequence_id, message.position, now);
          return { kind: 'ended' };
        }
      } else {
        // An earlier start may have reached the engine: its run decides, and no second run is started.
        const runId = await startedRun(tx, accountId, existing, due.contact_id);
        if (runId) {
          await markSent(tx, accountId, existing.id, runId);
          await advance(tx, accountId, due.id, due.sequence_id, message.position, now);
          return { kind: 'ended' };
        }
      }
      if (existing.attempts >= SEQUENCE_MAX_ATTEMPTS) {
        await writeSend(tx, accountId, due, message, { status: 'failed', reason: 'start_failed', conversationId: null, attempt: false });
        await advance(tx, accountId, due.id, due.sequence_id, message.position, now);
        return { kind: 'ended' };
      }
    }

    // "Exit when": checked before every step, so it works without an event feed.
    const exit = exitReason(await exitFacts(tx, accountId, due));
    if (exit) {
      if (existing) await writeSend(tx, accountId, due, message, { status: 'skipped', reason: 'unavailable', conversationId: null, attempt: false });
      await endSubscription(tx, accountId, due.id, 'completed', exit);
      return { kind: 'ended' };
    }

    const skip = async (reason: SequenceSkipReason, conversationId: string | null = null): Promise<Claim> => {
      await writeSend(tx, accountId, due, message, { status: 'skipped', reason, conversationId, attempt: false });
      await advance(tx, accountId, due.id, due.sequence_id, message.position, now);
      return { kind: 'ended' };
    };
    if (whatsapp) return planWhatsApp(tx, accountId, due, message, now, { skip });

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
 * Step 2 and 3 for WhatsApp: one send through the delivery row's outbound
 * intent. A send that fails before dispatchOnce claims the intent leaves the
 * claim to its lease (the next claim plans it again).
 */
async function sendWhatsApp(job: WhatsAppJob, now: Date): Promise<void> {
  const { accountId } = job;
  let outcome: { messageId: string } | { reason: 'provider_rejected' | 'outcome_unknown' };
  try {
    const userId = await resolveAuditUserId(createAdminClient({ accountId, role: 'owner' }), accountId);
    const base = { accountId, userId, conversationId: job.conversationId, contactId: job.contactId };
    const send = job.send;
    const result = await dispatchOnce(accountId, sequenceSendIntentKey(job.sendId), () => {
      if (send.kind === 'template')
        return engineSendTemplate({
          ...base, templateName: send.name, language: send.language ?? undefined, params: send.values, bodyValuesOnly: true,
          messageParams: { body: send.values },
        });
      if (send.kind === 'media')
        return engineSendMedia({ ...base, kind: send.type, link: send.url, caption: send.caption ?? undefined, filename: send.filename ?? undefined });
      return engineSendText({ ...base, text: send.text });
    });
    outcome = { messageId: result.whatsapp_message_id };
  } catch (error) {
    if (error instanceof UncertainDispatchError) outcome = { reason: 'outcome_unknown' };
    else if (rejectedByProvider(error) || error instanceof NoNumberError) outcome = { reason: 'provider_rejected' };
    else {
      console.error('[sequences] whatsapp send failed', { error: error instanceof Error ? error.name : 'unknown' });
      return;
    }
  }
  await workerTenant(accountId, async (tx) => {
    await finishWhatsAppSend(tx, accountId, job.sendId, outcome);
    await advance(tx, accountId, job.subscriptionId, job.sequenceId, job.position, now);
  });
}

/**
 * Worker: sends this workspace's due sequence messages, at most RUN_BATCH per
 * run. Returns how many subscriptions it handled. Instagram sequences wait
 * while Instagram is off; WhatsApp sequences run.
 */
export async function runDueSequences(accountId: string, now: Date = new Date()): Promise<number> {
  const instagramOn = !!instagramConfig();
  let handled = 0;
  for (let i = 0; i < RUN_BATCH; i += 1) {
    const claim = await claimNext(accountId, now, instagramOn);
    if (claim.kind === 'none') break;
    handled += 1;
    if (claim.kind === 'ended') continue;
    if (claim.kind === 'whatsapp') {
      await sendWhatsApp(claim.job, now);
      continue;
    }
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
