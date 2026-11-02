import { getWorkerPrisma } from '@/lib/db/prisma';
import { withTenant, type TenantContext, type TenantTransaction } from '@/lib/db/tenant';
import { readInboxSettings } from './inbox-settings';
import { pickRoutingRule, queueReassign } from './routing';
import { isWithinWorkingHours } from './working-hours';

/**
 * Conversation lifecycle (conversations.lifecycle_state) beyond what the
 * conversation_lifecycle trigger derives on its own:
 *
 *  - inbound: after the bots had their turn, a conversation an active flow
 *    run or the AI auto-reply owns moves to 'bot' (no first-reply SLA while it
 *    does; a one-off automation or order confirmation does not count); any
 *    other unassigned one is 'requesting' and the routing rules may assign it.
 *    Re-opening a resolved conversation (reopened_count + 1) and stamping the
 *    SLA due time happen in the trigger when ingest re-opens it.
 *  - agent reply: an unassigned conversation is claimed by the member who
 *    replied ('requesting' -> 'assigned'); the first reply itself is stamped by
 *    the messages_first_response trigger.
 *  - auto-resolve: open conversations idle longer than the workspace's
 *    auto_resolve_after_hours, where the business spoke last, are resolved.
 *    Once a person is needed ('requesting'/'assigned') only a member's reply
 *    answers the customer; a bot message (away text, automation, order
 *    confirmation) does not.
 */

export type LifecycleState = 'bot' | 'requesting' | 'assigned' | 'resolved';
export const AUTO_RESOLVE_JOB = 'inbox.auto_resolve';
/** Conversations resolved per sweep; the next sweep continues. */
export const AUTO_RESOLVE_BATCH = 500;

export interface InboundLifecycleInput {
  accountId: string;
  conversationId: string;
  contactId: string;
  /** messages.id of the inbound message. */
  messageId: string;
  /** The customer's text (keywords for routing); never stored or logged here. */
  text: string;
}

export interface InboundLifecycleResult {
  state: LifecycleState;
  /** A flow run is active or the AI auto-reply answered: the bot owns the conversation. */
  botOwned: boolean;
  /** Any automatic reply (flow, AI, automation, quick-reply action, order confirmation) went out after this message. */
  botReplied: boolean;
  /** Set when a routing rule assigned the conversation just now. */
  routedTo: string | null;
  ruleId: string | null;
}

type ConversationRow = {
  status: string; lifecycle_state: LifecycleState; assigned_agent_id: string | null; bot_paused: boolean;
  whatsapp_config_id: string | null; reopened_count: number;
};

/**
 * Worker side, from the inbound.actions job. Local and transactional: a retry
 * after a failure repeats it safely (an assigned conversation is left alone,
 * and the round-robin position only moves with the assignment it made).
 */
export async function applyInboundLifecycle(input: InboundLifecycleInput, now: Date = new Date()): Promise<InboundLifecycleResult> {
  const { accountId, conversationId } = input;
  return withTenant({ accountId, role: 'owner' }, async (tx) => {
    const rows = await tx.$queryRaw<ConversationRow[]>`SELECT status,lifecycle_state,assigned_agent_id::text AS assigned_agent_id,bot_paused,
        whatsapp_config_id::text AS whatsapp_config_id,reopened_count
      FROM conversations WHERE account_id=${accountId}::uuid AND id=${conversationId}::uuid FOR UPDATE`;
    const row = rows[0];
    const result: InboundLifecycleResult = {
      state: row?.lifecycle_state ?? 'requesting', botOwned: false, botReplied: false, routedTo: null, ruleId: null,
    };
    if (!row || row.status === 'closed') return result;

    const handled = await tx.$queryRaw<{ flow: boolean; ai: boolean; replied: boolean; received_at: Date | null }[]>`WITH inbound AS (
        SELECT i.created_at FROM messages i WHERE i.account_id=${accountId}::uuid AND i.id=${input.messageId}::uuid
      ), replies AS (
        SELECT b.ai_generated FROM messages b, inbound WHERE b.account_id=${accountId}::uuid
          AND b.conversation_id=${conversationId}::uuid AND b.sender_type='bot' AND b.created_at >= inbound.created_at
      ) SELECT
        EXISTS(SELECT 1 FROM flow_runs r WHERE r.account_id=${accountId}::uuid AND r.conversation_id=${conversationId}::uuid AND r.status='active') AS flow,
        EXISTS(SELECT 1 FROM replies WHERE ai_generated) AS ai,
        EXISTS(SELECT 1 FROM replies) AS replied,
        (SELECT created_at FROM inbound) AS received_at`;
    result.botOwned = handled[0]?.flow === true || handled[0]?.ai === true;
    result.botReplied = handled[0]?.replied === true;
    if (row.assigned_agent_id) return { ...result, state: 'assigned' };

    if (result.botOwned && !row.bot_paused) {
      // No first-reply clock while a bot owns it; the trigger restarts it on hand-off.
      if (row.lifecycle_state !== 'bot')
        await tx.$executeRaw`UPDATE conversations SET lifecycle_state='bot',
            first_response_due_at=CASE WHEN first_responded_at IS NULL THEN NULL ELSE first_response_due_at END
          WHERE account_id=${accountId}::uuid AND id=${conversationId}::uuid`;
      return { ...result, state: 'bot' };
    }
    if (row.lifecycle_state === 'bot')
      await tx.$executeRaw`UPDATE conversations SET lifecycle_state='requesting'
        WHERE account_id=${accountId}::uuid AND id=${conversationId}::uuid`;

    const settings = await readInboxSettings(tx, accountId);
    const tags = await tx.$queryRaw<{ tag_id: string }[]>`SELECT tag_id::text AS tag_id FROM contact_tags
      WHERE account_id=${accountId}::uuid AND contact_id=${input.contactId}::uuid`;
    const route = await pickRoutingRule(tx, accountId, {
      tagIds: new Set(tags.map((tag) => tag.tag_id.toLowerCase())),
      text: input.text,
      whatsappConfigId: row.whatsapp_config_id,
      // The receipt time, like the away message: a delayed or retried job routes by when the customer wrote.
      withinWorkingHours: isWithinWorkingHours(settings, handled[0]?.received_at ?? now),
    });
    if (!route) return { ...result, state: 'requesting' };
    // The assignment trigger moves it to 'assigned' and notifies the member.
    // Database clock, the same one that stamps messages.created_at, for the reassign check.
    const assigned = await tx.$queryRaw<{ at: Date }[]>`UPDATE conversations SET assigned_agent_id=${route.assignee}::uuid
      WHERE account_id=${accountId}::uuid AND id=${conversationId}::uuid AND assigned_agent_id IS NULL RETURNING now() AS at`;
    if (route.reassignAfterMinutes && assigned.length)
      await queueReassign(tx, {
        accountId, conversationId, ruleId: route.ruleId, assignee: route.assignee, cycle: row.reopened_count, attempt: 0,
        assignedAt: assigned[0].at.toISOString(), runAt: new Date(now.getTime() + route.reassignAfterMinutes * 60_000),
      });
    return { ...result, state: 'assigned', routedTo: route.assignee, ruleId: route.ruleId };
  }, getWorkerPrisma());
}

/**
 * The replying member claims an unassigned open conversation. Runs as that
 * member (app role, agent+) right after their send. Returns true when it
 * assigned. The assignment notification skips the member's own action.
 */
export async function claimOnAgentReply(tenant: TenantContext, conversationId: string): Promise<boolean> {
  if (!tenant.userId || !tenant.role || tenant.role === 'viewer') return false;
  const updated = await withTenant(tenant, (tx) => tx.$executeRaw`UPDATE conversations SET assigned_agent_id=${tenant.userId}::uuid
    WHERE account_id=${tenant.accountId}::uuid AND id=${conversationId}::uuid AND assigned_agent_id IS NULL
      AND status<>'closed' AND lifecycle_state IN ('requesting','bot')`);
  return updated > 0;
}

/** Resolve one batch of idle conversations. Worker only. Returns how many it resolved. */
export async function autoResolveIdle(tx: TenantTransaction, accountId: string, now: Date = new Date()): Promise<number> {
  const settings = await readInboxSettings(tx, accountId);
  if (!settings.auto_resolve_after_hours) return 0;
  const cutoff = new Date(now.getTime() - settings.auto_resolve_after_hours * 3_600_000);
  // A customer waiting on a reply is never resolved, nor is a running flow. While a
  // bot owns the conversation its reply counts as the last word; once a person is
  // needed, bot messages (the away text, automations) are skipped, so a customer
  // answered only by a bot still counts as the last speaker.
  return tx.$executeRaw`UPDATE conversations c SET lifecycle_state='resolved'
    WHERE c.account_id=${accountId}::uuid AND c.status<>'closed' AND c.last_message_at < ${cutoff}
      AND c.id IN (
        SELECT o.id FROM conversations o
        WHERE o.account_id=${accountId}::uuid AND o.lifecycle_state IN ('bot','requesting','assigned')
          AND o.last_message_at < ${cutoff}
          AND (SELECT m.sender_type FROM messages m WHERE m.account_id=o.account_id AND m.conversation_id=o.id
            AND (o.lifecycle_state='bot' OR m.sender_type<>'bot')
            ORDER BY m.created_at DESC LIMIT 1) IS DISTINCT FROM 'customer'
          AND NOT EXISTS(SELECT 1 FROM flow_runs r WHERE r.account_id=o.account_id AND r.conversation_id=o.id AND r.status='active')
        ORDER BY o.last_message_at LIMIT ${AUTO_RESOLVE_BATCH})`;
}

export async function runAutoResolve(accountId: string, now: Date = new Date()): Promise<number> {
  return withTenant({ accountId, role: 'owner' }, (tx) => autoResolveIdle(tx, accountId, now), getWorkerPrisma());
}
