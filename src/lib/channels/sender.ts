// Instagram channel sender (Phase 11). WhatsApp sending stays where it is; this
// module is the one place an Instagram send is prepared and made, for the
// composer (T3), flows (T4) and shared services (T5). Stage 2 adds cards and
// galleries (generic template), button templates and the automated-window
// check flows run before each customer-facing step.
//
// Use:
//   1. inside a WORKER tenant transaction (the app role cannot read the token):
//      const target = await loadInstagramTarget(tx, accountId, conversationId);
//   2. before any outbound intent: checkInstagramText / checkInstagramMedia /
//      checkInstagramChoices(target, ..., ctx). These throw InstagramError
//      (instagram_not_enabled, instagram_window_closed, invalid_request) or
//      ChannelUnavailableError, so a refusal never leaves an intent behind.
//   3. inside dispatchOnce, with the SAME ctx (same `now`): sendInstagramText /
//      sendInstagramMedia / sendInstagramChoices. They repeat the checks (so the
//      outcome is identical) and then call graph.ts; a provider failure throws a
//      sanitized MetaApiError, which dispatchOnce classifies.
// The target always comes from the conversation row, never from a client.
import { Prisma } from '@prisma/client';
import type { TenantTransaction } from '@/lib/db/tenant';
import { decrypt } from '@/lib/whatsapp/encryption';
import { instagramConfig, missingScopes } from '@/lib/instagram/config';
import { InstagramError } from '@/lib/instagram/errors';
import {
  buttonTemplateFits,
  genericTemplateFits,
  quickRepliesFit,
  sendAttachment,
  sendButtonTemplate,
  sendGenericTemplate,
  sendQuickReplies,
  sendText,
  validInstagramText,
  type IgGenericCard,
  type IgTemplateButton,
  type InstagramAttachmentType,
  type QuickReply,
  type SentMessage,
} from '@/lib/instagram/graph';
import { instagramWindow, type InstagramSender } from '@/lib/instagram/window';
import type { ChannelCapability } from './capabilities';

/** A capability Instagram does not have in Phase 11 (template, form, catalog, location request, long list, reaction, ...). */
export class ChannelUnavailableError extends Error {
  readonly code = 'channel_not_supported';
  constructor(readonly capability: ChannelCapability) {
    super(`Not available on Instagram: ${capability}`);
    this.name = 'ChannelUnavailableError';
  }
}

export interface InstagramTarget {
  accountId: string;
  conversationId: string;
  contactId: string;
  instagramAccountId: string;
  /** The professional account id (sender). */
  igUserId: string;
  /** The customer's IGSID (recipient). */
  igsid: string;
  /** Encrypted token; decrypted only at send time and never returned or logged. */
  accessTokenEnc: string;
  scopes: string[];
  /** The customer's last message; echoes are 'agent' and never count. */
  lastCustomerAt: Date | null;
}

export interface InstagramSendContext {
  sender: InstagramSender;
  /** Pass the same instant to the check and to the send. */
  now: Date;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface TargetRow {
  channel: string;
  contact_id: string;
  instagram_account_id: string | null;
  ig_user_id: string | null;
  status: string | null;
  scopes: string[] | null;
  access_token_enc: string | null;
  igsid: string | null;
  blocked_at: Date | null;
  last_customer_at: Date | null;
}

/**
 * The Instagram send target of a conversation. Refuses: not found (not_found),
 * not an Instagram conversation (channel_not_supported), a blocked contact
 * (contact_blocked), a disconnected account (instagram_account_disconnected), a
 * token Meta rejected (instagram_token_invalid), or a grant without the DM
 * scopes (instagram_permission_missing). `tx` must be a worker tenant
 * transaction of `accountId`.
 */
export async function loadInstagramTarget(tx: TenantTransaction, accountId: string, conversationId: string): Promise<InstagramTarget> {
  if (!UUID.test(accountId) || !UUID.test(conversationId)) throw new InstagramError('not_found');
  const [row] = await tx.$queryRaw<TargetRow[]>(Prisma.sql`
    SELECT c.channel, c.contact_id::text AS contact_id, c.instagram_account_id::text AS instagram_account_id,
      a.ig_user_id, a.status, a.scopes, a.access_token_enc, ct.blocked_at,
      (SELECT i.external_id FROM contact_channel_identities i
        WHERE i.account_id=c.account_id AND i.contact_id=c.contact_id AND i.instagram_account_id=c.instagram_account_id
        ORDER BY i.created_at, i.id LIMIT 1) AS igsid,
      (SELECT max(m.created_at) FROM messages m WHERE m.account_id=c.account_id AND m.conversation_id=c.id
        AND m.sender_type='customer') AS last_customer_at
    FROM conversations c
    JOIN contacts ct ON ct.account_id=c.account_id AND ct.id=c.contact_id
    LEFT JOIN instagram_accounts a ON a.account_id=c.account_id AND a.id=c.instagram_account_id
    WHERE c.account_id=${accountId}::uuid AND c.id=${conversationId}::uuid`);
  if (!row) throw new InstagramError('not_found');
  if (row.channel !== 'instagram' || !row.instagram_account_id || !row.ig_user_id) throw new InstagramError('channel_not_supported');
  if (row.blocked_at) throw new InstagramError('contact_blocked');
  if (row.status === 'disconnected' || !row.access_token_enc) throw new InstagramError('instagram_account_disconnected');
  if (row.status === 'token_invalid') throw new InstagramError('instagram_token_invalid');
  // A token that cannot be decrypted (rotated key, corrupt ciphertext) is refused here, before any
  // intent exists; inside dispatchOnce it would read as an ambiguous outcome although nothing was sent.
  try { decrypt(row.access_token_enc); } catch { throw new InstagramError('instagram_token_invalid'); }
  const scopes = row.scopes ?? [];
  if (row.status === 'permission_missing' || missingScopes(scopes, 'dm').length) throw new InstagramError('instagram_permission_missing');
  if (!row.igsid) throw new InstagramError('not_found');
  return {
    accountId,
    conversationId,
    contactId: row.contact_id,
    instagramAccountId: row.instagram_account_id,
    igUserId: row.ig_user_id,
    igsid: row.igsid,
    accessTokenEnc: row.access_token_enc,
    scopes,
    lastCustomerAt: row.last_customer_at ? new Date(row.last_customer_at) : null,
  };
}

/** Config and window; returns whether the send carries the Human Agent tag. */
function checkWindow(target: InstagramTarget, ctx: InstagramSendContext): { humanAgentTag: boolean } {
  const config = instagramConfig();
  if (!config) throw new InstagramError('instagram_not_enabled');
  const decision = instagramWindow({
    lastCustomerAt: target.lastCustomerAt,
    sender: ctx.sender,
    humanAgentEnabled: config.humanAgentEnabled,
    now: ctx.now,
  });
  if (!decision.allowed) throw new InstagramError('instagram_window_closed');
  return { humanAgentTag: decision.humanAgentTag };
}

export function checkInstagramText(target: InstagramTarget, text: string, ctx: InstagramSendContext): { humanAgentTag: boolean } {
  const window = checkWindow(target, ctx);
  if (!validInstagramText(text)) throw new InstagramError('invalid_request');
  return window;
}

export interface InstagramMedia { type: InstagramAttachmentType; url: string }

/** The same rule graph.ts sendAttachment applies, so a URL that passes here never throws inside dispatchOnce. */
function validAttachmentUrl(url: unknown): boolean {
  if (typeof url !== 'string' || url.length > 2048) return false;
  try { return new URL(url).protocol === 'https:'; } catch { return false; }
}

export function checkInstagramMedia(target: InstagramTarget, media: InstagramMedia, ctx: InstagramSendContext): { humanAgentTag: boolean } {
  const window = checkWindow(target, ctx);
  if (!['image', 'audio', 'video', 'file'].includes(media.type)) throw new ChannelUnavailableError('media_type');
  if (!validAttachmentUrl(media.url)) throw new InstagramError('invalid_request');
  return window;
}

export function checkInstagramChoices(target: InstagramTarget, text: string, choices: readonly QuickReply[],
  ctx: InstagramSendContext): { humanAgentTag: boolean } {
  const window = checkInstagramText(target, text, ctx);
  if (!quickRepliesFit(choices)) throw new ChannelUnavailableError('list');
  return window;
}

export async function sendInstagramText(target: InstagramTarget, text: string, ctx: InstagramSendContext): Promise<SentMessage> {
  const { humanAgentTag } = checkInstagramText(target, text, ctx);
  return sendText(target.igUserId, decrypt(target.accessTokenEnc), target.igsid, text, { humanAgentTag });
}

export async function sendInstagramMedia(target: InstagramTarget, media: InstagramMedia, ctx: InstagramSendContext): Promise<SentMessage> {
  const { humanAgentTag } = checkInstagramMedia(target, media, ctx);
  return sendAttachment(target.igUserId, decrypt(target.accessTokenEnc), target.igsid, media, { humanAgentTag });
}

/** Buttons, or list rows that fit, as Instagram quick replies. */
export async function sendInstagramChoices(target: InstagramTarget, text: string, choices: readonly QuickReply[],
  ctx: InstagramSendContext): Promise<SentMessage> {
  const { humanAgentTag } = checkInstagramChoices(target, text, choices, ctx);
  return sendQuickReplies(target.igUserId, decrypt(target.accessTokenEnc), target.igsid, text, choices, { humanAgentTag });
}

/** A card or a gallery (generic template, 1–10 cards) within the limits graph.ts enforces. */
export function checkInstagramCards(target: InstagramTarget, cards: readonly IgGenericCard[],
  ctx: InstagramSendContext): { humanAgentTag: boolean } {
  const window = checkWindow(target, ctx);
  if (!genericTemplateFits(cards)) throw new InstagramError('invalid_request');
  return window;
}

export async function sendInstagramCards(target: InstagramTarget, cards: readonly IgGenericCard[],
  ctx: InstagramSendContext): Promise<SentMessage> {
  const { humanAgentTag } = checkInstagramCards(target, cards, ctx);
  return sendGenericTemplate(target.igUserId, decrypt(target.accessTokenEnc), target.igsid, cards, { humanAgentTag });
}

/** Text with 1–3 real buttons (links or postbacks): a button template. */
export function checkInstagramButtonTemplate(target: InstagramTarget, text: string, buttons: readonly IgTemplateButton[],
  ctx: InstagramSendContext): { humanAgentTag: boolean } {
  const window = checkWindow(target, ctx);
  if (!buttonTemplateFits(text, buttons)) throw new InstagramError('invalid_request');
  return window;
}

export async function sendInstagramButtonTemplate(target: InstagramTarget, text: string, buttons: readonly IgTemplateButton[],
  ctx: InstagramSendContext): Promise<SentMessage> {
  const { humanAgentTag } = checkInstagramButtonTemplate(target, text, buttons, ctx);
  return sendButtonTemplate(target.igUserId, decrypt(target.accessTokenEnc), target.igsid, text, buttons, { humanAgentTag });
}

/**
 * Whether an automated message may go to this Instagram conversation now: the
 * customer wrote (or tapped a reply or postback) within 24 hours. Flows check it
 * before every customer-facing step, so a run that resumes past the window ends
 * with `window_closed` instead of failing a send. `tx` must be a tenant
 * transaction of `accountId`.
 */
export async function instagramAutomatedWindowOpen(tx: TenantTransaction, accountId: string, conversationId: string,
  now: Date = new Date()): Promise<boolean> {
  const [row] = await tx.$queryRaw<{ last_customer_at: Date | null }[]>(Prisma.sql`
    SELECT max(m.created_at) AS last_customer_at FROM messages m
    WHERE m.account_id=${accountId}::uuid AND m.conversation_id=${conversationId}::uuid AND m.sender_type='customer'`);
  const last = row?.last_customer_at ? new Date(row.last_customer_at) : null;
  return instagramWindow({ lastCustomerAt: last, sender: 'automated', humanAgentEnabled: false, now }).allowed;
}

export interface InstagramSentRow {
  accountId: string;
  conversationId: string;
  senderType: 'agent' | 'bot';
  /** The member for an agent send; null for a bot send. */
  senderId: string | null;
  contentType: string;
  contentText: string | null;
  mediaUrl?: string | null;
  interactivePayload?: Record<string, unknown> | null;
  /** Meta's mid. */
  messageId: string;
}

/**
 * Store the row of an Instagram message this app sent. Meta also delivers an
 * is_echo webhook for it, and that echo may be stored first (process-webhook
 * storeEcho: an 'agent' row with ig.external_echo=true and the same mid). That
 * echo row is replaced by this sender's own row, keeping the echo's media URL
 * when the sender has none. Any other row with the same mid is left alone and
 * nothing is inserted. Returns the stored row id, or null in that case. `tx`
 * must be a worker tenant transaction of `row.accountId`.
 */
export async function storeInstagramSentMessage(tx: TenantTransaction, row: InstagramSentRow): Promise<string | null> {
  const payload = row.interactivePayload ? JSON.stringify(row.interactivePayload) : null;
  const [stored] = await tx.$queryRaw<{ id: string }[]>(Prisma.sql`
    INSERT INTO messages(account_id,conversation_id,sender_type,sender_id,content_type,content_text,media_url,
      interactive_payload,message_id,status)
    VALUES(${row.accountId}::uuid,${row.conversationId}::uuid,${row.senderType},${row.senderId}::uuid,${row.contentType},
      ${row.contentText},${row.mediaUrl ?? null},${payload}::jsonb,${row.messageId},'sent')
    ON CONFLICT(conversation_id,message_id) DO UPDATE SET sender_type=EXCLUDED.sender_type, sender_id=EXCLUDED.sender_id,
      content_type=EXCLUDED.content_type, content_text=EXCLUDED.content_text,
      media_url=COALESCE(EXCLUDED.media_url, messages.media_url), interactive_payload=EXCLUDED.interactive_payload, status='sent'
    WHERE messages.account_id=EXCLUDED.account_id AND messages.sender_type='agent' AND messages.sender_id IS NULL
      AND messages.interactive_payload->'ig'->>'external_echo'='true'
    RETURNING id::text AS id`);
  return stored?.id ?? null;
}
