// The AI agent's text reply on an Instagram conversation (Stage 2): the inbox
// auto-reply and the flow AI step both send through here, never through the
// WhatsApp sender.
//
//   prepareInstagramAiReply  loads the conversation's Instagram target (worker
//                            role: the app role cannot read the token) and
//                            checks the account, the 24-hour window (AI is
//                            automated: never the Human Agent tag) and the text
//                            limit. It throws InstagramError with a fixed code
//                            BEFORE any outbound intent or send exists, so a
//                            refusal is a certain "not sent".
//   sendInstagramAiReply     re-checks the pause and the caller's ownership
//                            (beforeSend), sends (the sender repeats the
//                            checks with the same instant), then stores the
//                            bot row marked ai_generated and bumps the
//                            conversation preview in one tenant transaction.
//
// The target always comes from the conversation row. Nothing here logs
// customer content, the reply or the token.
import { getWorkerPrisma } from '@/lib/db/prisma';
import { withTenant } from '@/lib/db/tenant';
import {
  checkInstagramText,
  loadInstagramTarget,
  sendInstagramText,
  storeInstagramSentMessage,
  type InstagramSendContext,
  type InstagramTarget,
} from '@/lib/channels/sender';
import { instagramConfig } from '@/lib/instagram/config';
import { InstagramError, type InstagramErrorCode } from '@/lib/instagram/errors';
import { instagramWindow } from '@/lib/instagram/window';
import { assertBotRepliesEnabled } from '@/lib/whatsapp/bot-pause';

export interface PreparedInstagramAiReply {
  target: InstagramTarget;
  ctx: InstagramSendContext;
  text: string;
}

/** Throws InstagramError (fixed code) when the reply cannot go; nothing is claimed or sent. */
export async function prepareInstagramAiReply(accountId: string, conversationId: string, text: string,
  now: Date = new Date()): Promise<PreparedInstagramAiReply> {
  const target = await withTenant({ accountId, role: 'owner' },
    (tx) => loadInstagramTarget(tx, accountId, conversationId), getWorkerPrisma());
  const ctx: InstagramSendContext = { sender: 'automated', now };
  checkInstagramText(target, text, ctx);
  return { target, ctx, text };
}

/**
 * Send a prepared reply. Same contract as engineSendText: `beforeSend` may
 * throw to stand down, `onSent` runs once Meta accepted the message (a later
 * throw means sent but not stored). Returns the Meta mid under the engine's
 * historical field name.
 */
export async function sendInstagramAiReply(prepared: PreparedInstagramAiReply, options: {
  beforeSend?: () => Promise<void>;
  onSent?: () => void;
} = {}): Promise<{ whatsapp_message_id: string }> {
  const { target, ctx, text } = prepared;
  await assertBotRepliesEnabled(target.accountId, target.conversationId);
  await options.beforeSend?.();
  const sent = await sendInstagramText(target, text, ctx);
  options.onSent?.();
  await withTenant({ accountId: target.accountId, role: 'owner' }, async (tx) => {
    const id = await storeInstagramSentMessage(tx, {
      accountId: target.accountId,
      conversationId: target.conversationId,
      senderType: 'bot',
      senderId: null,
      contentType: 'text',
      contentText: text,
      messageId: sent.messageId,
    });
    // The inbox badges AI replies and analytics credits them from this flag.
    if (id) await tx.$executeRaw`UPDATE messages SET ai_generated=true
      WHERE account_id=${target.accountId}::uuid AND id=${id}::uuid`;
    await tx.$executeRaw`UPDATE conversations SET last_message_text=${text}, last_message_at=now(), updated_at=now()
      WHERE account_id=${target.accountId}::uuid AND id=${target.conversationId}::uuid`;
  }, getWorkerPrisma());
  return { whatsapp_message_id: sent.messageId };
}

/**
 * Before any model call: the conversation's Instagram account can send (not
 * disconnected, token and DM permission present, Instagram on) and the 24-hour
 * window is open for an automated sender. Throws InstagramError otherwise.
 */
export async function assertInstagramAiReady(accountId: string, conversationId: string, now: Date = new Date()): Promise<void> {
  const target = await withTenant({ accountId, role: 'owner' },
    (tx) => loadInstagramTarget(tx, accountId, conversationId), getWorkerPrisma());
  if (!instagramConfig()) throw new InstagramError('instagram_not_enabled');
  const decision = instagramWindow({ lastCustomerAt: target.lastCustomerAt, sender: 'automated', humanAgentEnabled: false, now });
  if (!decision.allowed) throw new InstagramError('instagram_window_closed');
}

/** A refusal decided before sending (fixed code), or null for any other error. */
export function instagramRefusalCode(error: unknown): InstagramErrorCode | null {
  return error instanceof InstagramError ? error.code : null;
}
