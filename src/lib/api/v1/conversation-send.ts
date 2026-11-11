// Stage 5 (5G): POST /api/v1/conversations/{id}/messages sends text to an
// existing conversation on its own channel (WhatsApp or Instagram).
//
// Every send runs under one outbound intent (`api_msg:<request>`): with an
// Idempotency-Key the request id is derived from the key id and the header,
// so a repeated request returns the stored outcome and never sends twice; a
// request whose first attempt is still running or ended ambiguously is
// refused as `delivery_uncertain` for a person to check, never re-sent. The
// stored outcome carries a fingerprint of the conversation and text, so a key
// reused for another message is refused (idempotency_mismatch).
//
// Instagram: an API send is an automated message, so the 24-hour window is
// checked before anything is stored (409 window_closed) and again at send
// time with the same instant; a contact who unsubscribed from Instagram
// automation is refused. The message row is stored as 'sending' first and
// settles to sent, failed or unknown (never cleared automatically).
// WhatsApp: the existing send core (window, number, opt-out rules unchanged).
// Message text is never logged.

import { randomUUID } from 'node:crypto';
import type { DataClient } from '@/lib/data/types';
import { getWorkerPrisma } from '@/lib/db/prisma';
import { withTenant, type TenantTransaction } from '@/lib/db/tenant';
import { dispatchOnce, UncertainDispatchError } from '@/lib/jobs/dispatch';
import { MetaApiError } from '@/lib/whatsapp/meta-api';
import { sendMessageToConversation, SendMessageError } from '@/lib/whatsapp/send-message';
import { checkInstagramText, loadInstagramTarget, sendInstagramText, type InstagramSendContext, type InstagramTarget } from '@/lib/channels/sender';
import { InstagramError } from '@/lib/instagram/errors';
import { instagramAutomationAllowed } from '@/lib/contacts/channel-consent';
import { digest } from './start-flow';

/** Longest text accepted (WhatsApp's text limit; Instagram's own 1000-byte limit is checked by its sender). */
export const API_TEXT_MAX = 4096;

export interface ApiSent {
  message_id: string;
  provider_message_id: string;
  conversation_id: string;
  channel: 'whatsapp' | 'instagram';
}

export type ApiSendOutcome =
  | { ok: true; sent: ApiSent; replayed: boolean }
  | { ok: false; code: string; status: number; message: string };

/** What the intent stores: the sent ids or a refusal before the provider, plus the request fingerprint. Never the text. */
type Stored =
  | { fingerprint: string; sent: ApiSent }
  | { fingerprint: string; refused: { code: string; status: number; message: string } };

const refuse = (code: string, status: number, message: string): ApiSendOutcome => ({ ok: false, code, status, message });

/** The refusal of an Instagram check, as the public API answers it. */
export function instagramRefusal(error: InstagramError): ApiSendOutcome {
  if (error.code === 'instagram_window_closed') return refuse('window_closed', 409, 'The Instagram messaging window for this conversation is closed.');
  if (error.code === 'not_found') return refuse('not_found', 404, 'Conversation not found');
  if (error.code === 'invalid_request') return refuse('bad_request', 400, 'The text is too long or empty for Instagram');
  return refuse(error.code, error.status >= 500 ? 503 : error.status, 'Instagram cannot take this message now');
}

/** The validated text, or null. */
export function apiText(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  return text && text.length <= API_TEXT_MAX ? text : null;
}

const worker = <T>(accountId: string, work: (tx: TenantTransaction) => Promise<T>) =>
  withTenant({ accountId, role: 'owner' }, work, getWorkerPrisma());

export async function sendApiConversationText(args: {
  db: DataClient; accountId: string; keyId: string; conversationId: string; text: string; idempotencyKey: string | null;
}): Promise<ApiSendOutcome> {
  const { db, accountId, conversationId, text } = args;
  const conversation = await db.from('conversations').select('id, channel, contact_id').eq('id', conversationId)
    .eq('account_id', accountId).maybeSingle();
  if (conversation.error) throw new Error('Conversation lookup failed');
  const row = conversation.data as { channel?: string | null; contact_id?: string } | null;
  if (!row) return refuse('not_found', 404, 'Conversation not found');
  const channel: ApiSent['channel'] = row.channel === 'instagram' ? 'instagram' : 'whatsapp';
  const fingerprint = digest(`${conversationId}:${text}`);
  const request = args.idempotencyKey ? digest(`${args.keyId}:${args.idempotencyKey}`) : randomUUID().replace(/-/g, '');
  const key = `api_msg:${request}`;

  // A repeated Idempotency-Key answers from its intent first: the stored result stays the
  // answer even after the Instagram window closed or the contact opted out since.
  if (args.idempotencyKey) {
    const prior = await priorIntent(accountId, key);
    if (prior) {
      if (prior.status !== 'accepted' || !prior.result)
        return refuse('delivery_uncertain', 409, 'An earlier attempt with this request may have been delivered; check the conversation before sending again');
      return settled(prior.result, fingerprint, true);
    }
  }

  let target: InstagramTarget | null = null;
  const ctx: InstagramSendContext = { sender: 'automated', now: new Date() };
  if (channel === 'instagram') {
    if (row.contact_id && !(await instagramAutomationAllowed(accountId, row.contact_id)))
      return refuse('instagram_opted_out', 409, 'The contact unsubscribed from automated Instagram messages');
    try {
      target = await worker(accountId, async (tx) => {
        const loaded = await loadInstagramTarget(tx, accountId, conversationId);
        checkInstagramText(loaded, text, ctx);
        return loaded;
      });
    } catch (error) {
      if (error instanceof InstagramError) return instagramRefusal(error);
      throw error;
    }
  }

  let stored: Stored;
  let replayed = true;
  try {
    stored = await dispatchOnce<Stored>(accountId, key, async () => {
      replayed = false;
      if (target) return { fingerprint, sent: await sendInstagram(accountId, target, text, ctx) };
      try {
        const result = await sendMessageToConversation(db, accountId, { conversationId, messageType: 'text', contentText: text });
        return { fingerprint, sent: { message_id: result.messageId, provider_message_id: result.whatsappMessageId, conversation_id: conversationId, channel } };
      } catch (error) {
        // Refused before Meta (window, number, contact): stored as the outcome. A Meta failure may have been delivered.
        if (error instanceof SendMessageError && error.code !== 'meta_error' && error.code !== 'internal' && error.status < 500)
          return { fingerprint, refused: { code: error.code, status: error.status, message: error.message } };
        throw error;
      }
    });
  } catch (error) {
    // This attempt's own provider fault is a 502; an earlier attempt still open or ambiguous is a 409.
    if (error instanceof UncertainDispatchError)
      return refuse('delivery_uncertain', replayed ? 409 : 502,'An earlier attempt with this request may have been delivered; check the conversation before sending again');
    if (error instanceof MetaApiError) return refuse('meta_error', 502, 'The provider refused the message');
    throw error;
  }
  return settled(stored, fingerprint, replayed);
}

function settled(stored: Stored, fingerprint: string, replayed: boolean): ApiSendOutcome {
  if (stored.fingerprint !== fingerprint)
    return refuse('idempotency_mismatch', 409, 'This Idempotency-Key was already used for a different request.');
  if ('refused' in stored) return refuse(stored.refused.code, stored.refused.status, stored.refused.message);
  return { ok: true, sent: stored.sent, replayed };
}

/** The intent an earlier request with this key left (same key format as dispatchOnce), or null. */
async function priorIntent(accountId: string, key: string): Promise<{ status: string; result: Stored | null } | null> {
  const rows = await worker(accountId, (tx) => tx.$queryRaw<{ status: string; result: Stored | null }[]>`
    SELECT status, result FROM outbound_intents WHERE account_id=${accountId}::uuid AND idempotency_key=${`${accountId}:${key}`}`);
  return rows[0]?.status ? rows[0] : null;
}

/** One Instagram text: the 'sending' row, Meta, then sent / failed / unknown. Runs inside the request's intent. */
async function sendInstagram(accountId: string, target: InstagramTarget, text: string, ctx: InstagramSendContext): Promise<ApiSent> {
  const messageId = await worker(accountId, async (tx) => {
    const [inserted] = await tx.$queryRaw<{ id: string }[]>`INSERT INTO messages(account_id,conversation_id,sender_type,
        content_type,content_text,status)
      VALUES(${accountId}::uuid,${target.conversationId}::uuid,'agent','text',${text},'sending') RETURNING id::text AS id`;
    return inserted.id;
  });
  const settle = (status: 'failed' | 'unknown') => worker(accountId, (tx) => tx.$executeRaw`UPDATE messages SET status=${status}
    WHERE account_id=${accountId}::uuid AND id=${messageId}::uuid AND status='sending'`);
  let mid: string;
  try {
    mid = (await sendInstagramText(target, text, ctx)).messageId;
  } catch (error) {
    await settle(error instanceof MetaApiError && error.httpStatus >= 400 && error.httpStatus < 500 ? 'failed' : 'unknown');
    throw error;
  }
  await worker(accountId, async (tx) => {
    // An echo of this send processed first holds the same mid; this row is the one kept.
    await tx.$executeRaw`DELETE FROM messages WHERE account_id=${accountId}::uuid AND conversation_id=${target.conversationId}::uuid
      AND message_id=${mid} AND id<>${messageId}::uuid AND sender_type='agent' AND interactive_payload->'ig'->>'external_echo'='true'`;
    await tx.$executeRaw`UPDATE messages SET status='sent', message_id=${mid}
      WHERE account_id=${accountId}::uuid AND id=${messageId}::uuid AND status='sending'`;
    await tx.$executeRaw`UPDATE conversations SET last_message_text=${text}, last_message_at=now(), updated_at=now()
      WHERE account_id=${accountId}::uuid AND id=${target.conversationId}::uuid`;
  });
  return { message_id: messageId, provider_message_id: mid, conversation_id: target.conversationId, channel: 'instagram' };
}

