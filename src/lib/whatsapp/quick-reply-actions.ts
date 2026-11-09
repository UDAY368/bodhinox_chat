import type { DataClient } from '@/lib/data/types';
import { runAutomationById } from '@/lib/automations/engine';
import { startFlowById } from '@/lib/flows/engine';
import { NotDispatchedError } from '@/lib/jobs/dispatch';

interface QuickReplyInput {
  accountId: string; conversationId: string; contactId: string; userId: string;
  messageId: string; metaMessageId: string; interactiveReplyId: string | null;
}
export type QuickReplyActionResult = { handled: false } | {
  handled: true; outcome: 'started' | 'unavailable' | 'conflict';
};

/** Route only an opaque button on the exact persisted prompt this customer answered. */
export async function dispatchQuickReplyAction(db: DataClient, input: QuickReplyInput): Promise<QuickReplyActionResult> {
  if (!input.interactiveReplyId || !/^qr_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(input.interactiveReplyId)) return { handled: false };
  const inbound = await db.from('messages').select('reply_to_message_id,interactive_reply_id,content_text')
    .eq('account_id', input.accountId).eq('conversation_id', input.conversationId)
    .eq('id', input.messageId).eq('sender_type', 'customer').maybeSingle();
  if (inbound.error) throw new NotDispatchedError('Quick reply inbound lookup failed');
  if (!inbound.data?.reply_to_message_id || inbound.data.interactive_reply_id !== input.interactiveReplyId) return { handled: false };
  const parent = await db.from('messages').select('sender_type,interactive_payload')
    .eq('account_id', input.accountId).eq('conversation_id', input.conversationId)
    .eq('id', inbound.data.reply_to_message_id).maybeSingle();
  if (parent.error) throw new NotDispatchedError('Quick reply prompt lookup failed');
  if (!parent.data || !['agent', 'bot'].includes(String(parent.data.sender_type))) return { handled: false };
  const payload = parent.data.interactive_payload as { kind?: string; buttons?: Array<{ id?: string; action?: { type?: string; targetId?: string } }> } | null;
  if (payload?.kind !== 'buttons' || !Array.isArray(payload.buttons)) return { handled: false };
  const matches = payload.buttons.filter(button => button.id === input.interactiveReplyId);
  if (matches.length !== 1) return { handled: false };
  const action = matches[0].action;
  if (!action || !['automation', 'flow'].includes(String(action.type))) return { handled: false };
  if (typeof action.targetId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(action.targetId)) return { handled: true, outcome: 'unavailable' };

  // Check availability before changing a human handoff. The engine checks again at execution.
  const targetQuery = db.from(action.type === 'automation' ? 'automations' : 'flows').select('id')
    .eq('account_id', input.accountId).eq('id', action.targetId);
  const target = await (action.type === 'automation' ? targetQuery.eq('is_active', true) : targetQuery.eq('status', 'active')).maybeSingle();
  if (target.error) throw new NotDispatchedError('Quick reply target availability lookup failed');
  if (!target.data) return { handled: true, outcome: 'unavailable' };
  if (action.type === 'flow') {
    // A run belongs to one conversation (one per WhatsApp number). Only a run on this
    // conversation conflicts; a run waiting on the contact's other number does not.
    const active = await db.from('flow_runs').select('id').eq('account_id', input.accountId)
      .eq('contact_id', input.contactId).eq('conversation_id', input.conversationId).eq('status', 'active').limit(1);
    if (active.error) throw new NotDispatchedError('Quick reply active flow lookup failed');
    if (active.data?.length) return { handled: true, outcome: 'conflict' };
  }

  // A manually sent quick reply pauses bot replies. This explicit, bound tap hands control back.
  const conversation = await db.from('conversations').select('id,bot_paused,updated_at')
    .eq('account_id', input.accountId).eq('id', input.conversationId).eq('contact_id', input.contactId).maybeSingle();
  if (conversation.error) throw new NotDispatchedError('Quick reply conversation lookup failed');
  if (!conversation.data) return { handled: true, outcome: 'unavailable' };
  let handoffAt: string | null = null;
  if (conversation.data.bot_paused === true) {
    if (typeof conversation.data.updated_at !== 'string') return { handled: true, outcome: 'unavailable' };
    const resumed = await db.from('conversations').update({ bot_paused: false })
      .eq('account_id', input.accountId).eq('id', input.conversationId).eq('contact_id', input.contactId)
      .eq('bot_paused', true).eq('updated_at', conversation.data.updated_at).select('id,updated_at').maybeSingle();
    if (resumed.error) throw new Error('Quick reply conversation resume failed');
    if (!resumed.data) return { handled: true, outcome: 'unavailable' };
    // The repository and DB trigger own mutation timestamps. Keep the returned JSON
    // timestamp intact: converting through Date would truncate PostgreSQL microseconds.
    if (typeof resumed.data.updated_at !== 'string') throw new Error('Quick reply conversation handoff timestamp unavailable');
    handoffAt = resumed.data.updated_at;
  }
  const context = { conversation_id: input.conversationId, message_text: String(inbound.data.content_text ?? ''), interactive_reply_id: input.interactiveReplyId };
  let started = false;
  try {
    const result = action.type === 'automation'
      ? await runAutomationById({ accountId: input.accountId, automationId: action.targetId, contactId: input.contactId, context })
      : await startFlowById({ accountId: input.accountId, flowId: action.targetId, userId: input.userId, contactId: input.contactId, conversationId: input.conversationId,
        message: { kind: 'interactive_reply', reply_id: input.interactiveReplyId, reply_title: context.message_text, meta_message_id: input.metaMessageId } });
    started = result.outcome === 'started';
    return { handled: true, outcome: result.outcome };
  } finally {
    if (!started && handoffAt) {
      // A target/run may change after preflight. Restore only our own untouched handoff;
      // a newer agent update or engine send owns the conversation state from then on.
      const restored = await db.from('conversations').update({ bot_paused: true })
        .eq('account_id', input.accountId).eq('id', input.conversationId).eq('contact_id', input.contactId)
        .eq('bot_paused', false).eq('updated_at', handoffAt);
      if (restored.error) throw new Error('Quick reply conversation handoff restore failed');
    }
  }
}
