// Instagram composer send (Phase 11, design section 6). The inbox send route
// calls this when the conversation row says channel='instagram'; the client
// never chooses the channel.
//
//   1. one worker tenant transaction, no network call: load the target from
//      the conversation row, check the window and the content (refusals throw
//      InstagramError / ChannelUnavailableError before anything is stored),
//      pause the bot, insert the message row with status 'sending';
//   2. dispatchOnce(accountId, 'ig_send:<messageRowId>') -> graph.ts;
//   3. the row becomes 'sent' (+ Meta's mid), 'failed' (Meta rejected it) or
//      'unknown' (ambiguous outcome). An 'unknown' row is never retried or
//      cleared automatically: staff check Instagram before resending.
// Text, image, audio, video and PDF only; everything else is
// channel_not_supported. Nothing from the message is logged.
import type { TenantTransaction } from '@/lib/db/tenant';
import { withTenant } from '@/lib/db/tenant';
import { getWorkerPrisma } from '@/lib/db/prisma';
import { dispatchOnce, UncertainDispatchError } from '@/lib/jobs/dispatch';
import { MetaApiError } from '@/lib/whatsapp/meta-api';
import { providerMediaUrl } from '@/lib/storage/server';
import {
  ChannelUnavailableError,
  checkInstagramMedia,
  checkInstagramText,
  loadInstagramTarget,
  sendInstagramMedia,
  sendInstagramText,
  type InstagramMedia,
  type InstagramSendContext,
  type InstagramTarget,
} from '@/lib/channels/sender';
import { InstagramError } from './errors';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The composer message types Instagram accepts, and the attachment type each becomes. */
const MEDIA_TYPES: Record<string, InstagramMedia['type']> = { image: 'image', audio: 'audio', video: 'video', document: 'file' };

export interface InstagramComposerInput {
  accountId: string;
  /** The signed-in member (messages.sender_id). */
  userId: string;
  conversationId: string;
  messageType: unknown;
  contentText: unknown;
  mediaUrl: unknown;
  filename?: unknown;
}

export interface InstagramComposerResult {
  messageId: string;
  /** Meta's mid. */
  providerMessageId: string;
}

/** Meta's outcome was ambiguous: the row is 'unknown' and must be reconciled by a person. */
export class InstagramDeliveryUncertainError extends Error {
  readonly code = 'delivery_uncertain';
  constructor(readonly messageId: string) {
    super('Instagram delivery uncertain');
    this.name = 'InstagramDeliveryUncertainError';
  }
}

/** Meta refused the message: the row is 'failed'. */
export class InstagramSendRejectedError extends Error {
  readonly code = 'meta_error';
  constructor(readonly messageId: string) {
    super('Instagram rejected the message');
    this.name = 'InstagramSendRejectedError';
  }
}

/** A file extension by its path, or by the object key of an app media link (/api/media/object?bucket=...&key=...). */
function hasExtension(value: unknown, ext: RegExp): boolean {
  if (typeof value !== 'string') return false;
  if (ext.test(value.split(/[?#]/)[0] ?? '')) return true;
  try { return ext.test(new URL(value, 'https://app.invalid').searchParams.get('key') ?? ''); } catch { return false; }
}
const isPdf = (value: unknown) => hasExtension(value, /\.pdf$/i);
/** Audio Instagram plays (AAC/M4A/MP4, WAV); an Ogg/Opus voice note or WebM is refused before Meta. */
const isInstagramAudio = (value: unknown) => hasExtension(value, /\.(aac|m4a|mp4|wav)$/i);

/** The media storage refusals (another workspace, not found, bad path); anything else is a server fault. */
const MEDIA_REFUSALS = new Set(['Invalid media resource', 'Invalid object path', 'Avatar access denied',
  'Media belongs to another workspace', 'Media not found in this workspace']);

/**
 * The URL Meta fetches. App media links (the composer's uploads and library
 * items) must be this workspace's objects and become a short-lived signed URL,
 * exactly as the WhatsApp composer sends them (providerMediaUrl).
 */
async function providerUrl(accountId: string, url: string): Promise<string> {
  try {
    return await providerMediaUrl(accountId, url);
  } catch (error) {
    if (error instanceof TypeError || (error instanceof Error && MEDIA_REFUSALS.has(error.message))) throw new InstagramError('invalid_request');
    throw error;
  }
}

type Prepared =
  | { kind: 'text'; text: string }
  | { kind: 'media'; media: InstagramMedia; caption: string | null };

/** Shape only; window, account and limits are checked against the target. */
function prepare(input: InstagramComposerInput): Prepared {
  if (input.messageType === 'text') {
    if (typeof input.contentText !== 'string') throw new InstagramError('invalid_request');
    return { kind: 'text', text: input.contentText };
  }
  const type = typeof input.messageType === 'string' ? MEDIA_TYPES[input.messageType] : undefined;
  if (!type) throw new ChannelUnavailableError(input.messageType === 'template' ? 'template' : input.messageType === 'interactive' ? 'interactive' : 'media_type');
  if (typeof input.mediaUrl !== 'string') throw new InstagramError('invalid_request');
  // Instagram accepts PDF as its only file type.
  if (type === 'file' && !isPdf(input.mediaUrl) && !isPdf(input.filename)) throw new ChannelUnavailableError('media_type');
  if (type === 'audio' && !isInstagramAudio(input.mediaUrl) && !isInstagramAudio(input.filename)) throw new ChannelUnavailableError('media_type');
  const text = typeof input.contentText === 'string' ? input.contentText.trim() : '';
  // A document's text is its file name, shown in our own bubble only (as on WhatsApp).
  if (type === 'file') return { kind: 'media', media: { type, url: input.mediaUrl }, caption: text.slice(0, 255) || null };
  // Instagram has no media captions; a caption is refused rather than silently dropped.
  if (text) throw new InstagramError('invalid_request');
  return { kind: 'media', media: { type, url: input.mediaUrl }, caption: null };
}

const tenant = <T>(accountId: string, work: (tx: TenantTransaction) => Promise<T>) =>
  withTenant({ accountId, role: 'owner' }, work, getWorkerPrisma());

async function settle(accountId: string, messageId: string, status: 'sent' | 'failed' | 'unknown', mid: string | null): Promise<void> {
  await tenant(accountId, (tx) => tx.$executeRaw`UPDATE messages SET status=${status}, message_id=COALESCE(${mid}, message_id)
    WHERE account_id=${accountId}::uuid AND id=${messageId}::uuid AND status='sending'`);
}

export async function sendInstagramFromComposer(input: InstagramComposerInput): Promise<InstagramComposerResult> {
  if (!UUID.test(input.accountId) || !UUID.test(input.conversationId) || !UUID.test(input.userId))
    throw new InstagramError('invalid_request');
  const prepared = prepare(input);
  // Resolved before the transaction (a signed URL lasts 15 minutes; the send follows within seconds).
  // The row keeps the app link; only Meta gets the signed one.
  const sendable: Prepared = prepared.kind === 'media'
    ? { ...prepared, media: { type: prepared.media.type, url: await providerUrl(input.accountId, prepared.media.url) } }
    : prepared;
  const ctx: InstagramSendContext = { sender: 'staff', now: new Date() };

  const { target, messageId } = await tenant(input.accountId, async (tx) => {
    const target: InstagramTarget = await loadInstagramTarget(tx, input.accountId, input.conversationId);
    if (sendable.kind === 'text') checkInstagramText(target, sendable.text, ctx);
    else checkInstagramMedia(target, sendable.media, ctx);
    // The agent stepping in: automated replies pause before the send, as on WhatsApp.
    await tx.$executeRaw`UPDATE conversations SET bot_paused=true, updated_at=now()
      WHERE account_id=${input.accountId}::uuid AND id=${input.conversationId}::uuid`;
    const contentType = prepared.kind === 'text' ? 'text' : (input.messageType as string);
    const [row] = await tx.$queryRaw<{ id: string }[]>`INSERT INTO messages(account_id,conversation_id,sender_type,sender_id,
        content_type,content_text,media_url,status)
      VALUES(${input.accountId}::uuid,${input.conversationId}::uuid,'agent',${input.userId}::uuid,${contentType},
        ${prepared.kind === 'text' ? prepared.text : prepared.caption},${prepared.kind === 'media' ? prepared.media.url : null},'sending')
      RETURNING id::text AS id`;
    return { target, messageId: row.id };
  });

  let mid: string;
  try {
    const sent = await dispatchOnce(input.accountId, `ig_send:${messageId}`, () =>
      sendable.kind === 'text' ? sendInstagramText(target, sendable.text, ctx) : sendInstagramMedia(target, sendable.media, ctx));
    mid = sent.messageId;
  } catch (error) {
    if (error instanceof UncertainDispatchError) {
      await settle(input.accountId, messageId, 'unknown', null);
      throw new InstagramDeliveryUncertainError(messageId);
    }
    await settle(input.accountId, messageId, 'failed', null);
    if (error instanceof MetaApiError) throw new InstagramSendRejectedError(messageId);
    throw error;
  }

  await tenant(input.accountId, async (tx) => {
    // If the echo of this send was processed first it stored the same mid as an
    // external-echo row; this send's own row is the one to keep.
    await tx.$executeRaw`DELETE FROM messages WHERE account_id=${input.accountId}::uuid
      AND conversation_id=${input.conversationId}::uuid AND message_id=${mid} AND id<>${messageId}::uuid
      AND sender_type='agent' AND interactive_payload->'ig'->>'external_echo'='true'`;
    await tx.$executeRaw`UPDATE messages SET status='sent', message_id=${mid}
      WHERE account_id=${input.accountId}::uuid AND id=${messageId}::uuid AND status='sending'`;
    const preview = prepared.kind === 'text' ? prepared.text : `[${input.messageType as string}]`;
    await tx.$executeRaw`UPDATE conversations SET last_message_text=${preview}, last_message_at=now(), updated_at=now()
      WHERE account_id=${input.accountId}::uuid AND id=${input.conversationId}::uuid`;
    // The active flow run on this conversation yields to the agent, as on WhatsApp.
    await tx.$executeRaw`UPDATE flow_runs SET status='paused_by_agent', ended_at=now(), end_reason='agent_replied'
      WHERE account_id=${input.accountId}::uuid AND contact_id=${target.contactId}::uuid
        AND conversation_id=${input.conversationId}::uuid AND status='active'`;
  });
  return { messageId, providerMessageId: mid };
}
