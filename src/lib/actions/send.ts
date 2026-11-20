// Customer sends shared by rules and flows. Every send runs under the caller's outbound intent
// key (dispatchOnce), so a retried step returns the recorded outcome instead of sending again and
// an ambiguous outcome is left for reconciliation. The keys stay each engine's own
// (`automation:<log>:<step>`, `flow:<run>:<node>:<seq>:<reprompt>`).
import type { DataClient } from '@/lib/data/types';
import type { Channel } from '@/types';
import { dispatchOnce } from '@/lib/jobs/dispatch';
import { marketingSuppression } from '@/lib/contacts/consent';
import { engineSendTemplate } from '@/lib/automations/meta-send';
import type { FlowSend, FlowSendResult } from '@/lib/flows/channel-send';

/**
 * The consent gate for business-initiated messages (templates): why the contact must not get
 * one (opted out or blocked), or null. Read fresh each time: a STOP can arrive while a run waits.
 */
export async function templateConsentRefusal(db: DataClient, accountId: string, contactId: string | null): Promise<string | null> {
  if (!contactId) return null;
  const { data, error } = await db.from('contacts').select('opted_out_at,blocked_at')
    .eq('id', contactId).eq('account_id', accountId).maybeSingle();
  if (error) throw new Error('Contact consent lookup failed');
  return marketingSuppression(data as { opted_out_at?: string | null; blocked_at?: string | null } | null);
}

/** A WhatsApp template under the intent `key`. The caller checks consent first (templateConsentRefusal). */
export function sendTemplateOnce(key: string, args: Parameters<typeof engineSendTemplate>[0]): Promise<{ whatsapp_message_id: string }> {
  return dispatchOnce(args.accountId, key, () => engineSendTemplate(args));
}

/**
 * A customer message on the conversation's channel under the intent `key`. A rule passes its
 * channel and its own WhatsApp sender: WhatsApp goes through that sender, Instagram through the
 * channel sender. A flow passes neither: the channel sender reads the run's channel (cached per
 * run object) and refuses before any intent when the Instagram window is closed or the message
 * does not fit.
 */
export async function sendOnChannel(input: {
  ref: { account_id: string; conversation_id: string | null };
  key: string;
  send: FlowSend;
  channel?: Channel;
  whatsapp?: () => Promise<{ whatsapp_message_id: string }>;
}): Promise<FlowSendResult> {
  if (input.channel === 'whatsapp' && input.whatsapp) return dispatchOnce(input.ref.account_id, input.key, input.whatsapp);
  // Loaded on use, so a WhatsApp rule's module graph is unchanged.
  const { flowSend } = await import('@/lib/flows/channel-send');
  return flowSend(input.ref, input.key, input.send);
}
