import { checkInstagramText, loadInstagramTarget } from '@/lib/channels/sender';
import { getWorkerPrisma } from '@/lib/db/prisma';
import { withTenant } from '@/lib/db/tenant';
import { flowSend } from '@/lib/flows/channel-send';
import { engineSendText } from '@/lib/flows/meta-send';
import { InstagramError } from '@/lib/instagram/errors';
import { dispatchOnce } from '@/lib/jobs/dispatch';
import { botRepliesPaused } from '@/lib/whatsapp/bot-pause';
import { MetaApiError } from '@/lib/whatsapp/meta-api';
import { assertWhatsAppConversation, getNumberConfig, isNumberDisconnected, NoNumberError } from '@/lib/whatsapp/numbers';
import { readInboxSettings } from './inbox-settings';
import { nextWindowKey } from './working-hours';

/**
 * The workspace away message: one free-form text per conversation per
 * off-hours window, sent when a customer writes outside working hours and no
 * bot or flow answered. Runs in the inbound.actions job inside the
 * "away_message" stage checkpoint, right after the customer's message, so
 * WhatsApp's 24-hour service window is open.
 *
 * Once per window: an away_message_sends row is claimed (unique per
 * conversation and window) before the send, and the send goes through an
 * outbound intent keyed by the same window. An ambiguous provider outcome is
 * left for reconciliation and never sent again. Refusals Meta would never see
 * (off, inside hours, bot paused by an agent, disconnected number) are decided
 * before anything is claimed. It goes out from the conversation's own number.
 *
 * Instagram (Stage 2): the same away text and working hours, behind the
 * separate instagram_away_message_enabled switch (off by default). It goes out
 * from the conversation's Instagram account through the Instagram sender, only
 * inside the 24-hour window (automated sends never carry the Human Agent tag);
 * a closed window, an unusable account or text over Instagram's limit is a
 * skip with its reason, decided before anything is claimed.
 */

export type AwayMessageOutcome =
  | 'off' | 'within_hours' | 'window_closed' | 'bot_paused' | 'number_unavailable' | 'already_sent' | 'sent' | 'provider_rejected'
  /** Instagram: the account is disconnected, its token or permission is missing, or Instagram is off. */
  | 'account_unavailable'
  /** Instagram: the away text is over Instagram's 1000-byte limit. */
  | 'invalid_for_channel';

export interface AwayMessageInput {
  accountId: string;
  /** Audit identity for the persisted bot message (the job's user). */
  userId: string;
  conversationId: string;
  contactId: string;
  /** messages.id of the customer's message; the service window runs 24 hours from it. */
  messageId: string;
}

const SERVICE_WINDOW_MS = 24 * 60 * 60 * 1000;

export const awayMessageKey = (conversationId: string, windowKey: string) => `away:${conversationId}:${windowKey}`;

export async function sendAwayMessage(input: AwayMessageInput, now: Date = new Date()): Promise<AwayMessageOutcome> {
  const { accountId, conversationId } = input;
  const plan = await withTenant({ accountId, role: 'owner' }, async (tx) => {
    const inbound = await tx.$queryRaw<{ created_at: Date }[]>`SELECT created_at FROM messages
      WHERE account_id=${accountId}::uuid AND conversation_id=${conversationId}::uuid AND id=${input.messageId}::uuid AND sender_type='customer'`;
    const receivedAt = inbound[0]?.created_at;
    if (!receivedAt || now.getTime() - receivedAt.getTime() >= SERVICE_WINDOW_MS) return { outcome: 'window_closed' as const };
    const settings = await readInboxSettings(tx, accountId);
    const conversation = await tx.conversations.findFirst({
      where: { account_id: accountId, id: conversationId }, select: { whatsapp_config_id: true, channel: true },
    });
    const instagram = conversation?.channel === 'instagram';
    const text = settings.away_message?.trim().slice(0, 4096) ?? '';
    // Each channel has its own switch over the one away text; Instagram's defaults to off.
    if (!(instagram ? settings.instagram_away_message_enabled : settings.away_message_enabled) || !text) return { outcome: 'off' as const };
    // The window the customer wrote in, not when this job happens to run.
    const windowKey = nextWindowKey(settings, receivedAt);
    if (!windowKey) return { outcome: 'within_hours' as const };
    if (instagram) {
      // The Instagram account, the 24-hour window and Instagram's text limit,
      // checked before anything is claimed (the send repeats the checks).
      try {
        checkInstagramText(await loadInstagramTarget(tx, accountId, conversationId), text, { sender: 'automated', now });
      } catch (error) {
        const refused = instagramRefusal(error);
        if (refused) return { outcome: refused };
        throw error;
      }
      return { outcome: null, text, windowKey, instagram };
    }
    try {
      if (conversation) assertWhatsAppConversation(conversation);
      const config = await getNumberConfig(tx, accountId, conversation?.whatsapp_config_id ?? null);
      if (isNumberDisconnected(config)) return { outcome: 'number_unavailable' as const };
    } catch (error) {
      if (error instanceof NoNumberError) return { outcome: 'number_unavailable' as const };
      throw error;
    }
    return { outcome: null, text, windowKey, instagram };
  }, getWorkerPrisma());
  if (plan.outcome) return plan.outcome;
  if (await botRepliesPaused(accountId, conversationId)) return 'bot_paused';

  const claimed = await withTenant({ accountId, role: 'owner' }, (tx) => tx.$executeRaw`INSERT INTO away_message_sends(account_id,conversation_id,window_key)
    VALUES(${accountId}::uuid,${conversationId}::uuid,${plan.windowKey}) ON CONFLICT DO NOTHING`, getWorkerPrisma());
  if (!claimed) return 'already_sent';

  const key = awayMessageKey(conversationId, plan.windowKey);
  const args = { accountId, userId: input.userId, conversationId, contactId: input.contactId, text: plan.text };
  try {
    // Instagram: channel-send repeats the window and account checks before its
    // outbound intent, so a refusal there was never sent.
    if (plan.instagram) await flowSend({ account_id: accountId, conversation_id: conversationId }, key, { kind: 'text', args });
    else await dispatchOnce(accountId, key, () => engineSendText(args));
  } catch (error) {
    // UncertainDispatchError propagates: the stage checkpoint records it for reconciliation.
    if (error instanceof MetaApiError && error.httpStatus >= 400 && error.httpStatus < 500) return 'provider_rejected';
    const refused = plan.instagram ? instagramRefusal(error) : null;
    if (refused) return refused;
    throw error;
  }
  return 'sent';
}

/** The outcome of an Instagram check that refused the send (fixed codes only), or null for any other error. */
function instagramRefusal(error: unknown): AwayMessageOutcome | null {
  if (!(error instanceof InstagramError)) return null;
  if (error.code === 'instagram_window_closed') return 'window_closed';
  // Over Instagram's 1000-byte text limit: the shared away text does not fit this channel.
  if (error.code === 'invalid_request') return 'invalid_for_channel';
  // Disconnected, token or permission problems, Instagram off on the deployment, no recipient.
  return 'account_unavailable';
}
