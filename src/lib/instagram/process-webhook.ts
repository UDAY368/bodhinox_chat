// Instagram webhook processing (Phase 11, design section 5). The pre-scope job
// instagram.webhook loads its receipt and, per entry:
//   1. resolves entry.id to the workspace holding that professional account
//      (crm_resolve_instagram_account; unknown -> dropped, counted, no ids logged)
//      and checks the plan still includes Instagram;
//   2. stores customer messages and postbacks through the shared inbound ingest
//      (ingestInboundMessage, with no WhatsApp-only inputs), and echoes of sends
//      made in the Instagram app as agent messages (never opening the window);
//   3. records comments (only with the comments scope). A person's first
//      comment on a post is offered to the live ig_comment flows first
//      (comment-matching.ts); when one may match, instagram.private_reply is
//      queued to start it and the legacy comment rule is skipped (it stays the
//      fallback when no flow takes the comment). Otherwise a comment rule
//      matches and queues instagram.private_reply as before. Either path queues
//      one job per comment (dedupe igpr:<event id>) and sends at most one
//      private reply (intent ig_private_reply:<comment id>);
//   3b. Stage 3: a comment on the account's Instagram Live (the live_comments
//      field, sent only while live) is recorded the same way and offered to
//      the live ig_live_comment flows only (a person's first matching comment
//      per broadcast). No legacy rule applies to a Live comment, and an
//      ig_comment flow never takes one;
//   3c. Stage 3: a referral (a chat opened from an ig.me ref link or a
//      click-to-Direct ad) is kept with its message (the flow engine starts
//      ig_ref and ad_click flows from it) and its ref is saved on the
//      contact's Instagram identity (last_ref); a referral that arrives alone,
//      with no message, only updates an identity that already exists;
//   4. counts every other event type as "unsupported" on the account.
// Identity (CRM-02): a sender is found ONLY by (instagram_account_id, IGSID). A
// new IGSID always gets a new phone-less contact; no phone, name, username,
// email or picture matching ever happens here. The new contact has no name: the
// IGSID and username are identifiers that masking hides, so they are never
// copied into contacts.name (the profile fetch sets the display name only).
// Unsupported-event counts are added once per receipt, in the transaction that
// marks it processed, so a retried job never counts an entry twice.
// While Instagram is off the receipt is marked skipped_disabled and nothing is
// written or called.
import { createHash } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { getWorkerPrisma } from '@/lib/db/prisma';
import { withTenant, type TenantTransaction } from '@/lib/db/tenant';
import { withJobScope } from '@/lib/jobs/scope';
import { getEntitlements } from '@/lib/billing/entitlements';
import { ingestInboundMessage } from '@/lib/whatsapp/ingest';
import { instagramConfig, missingScopes } from './config';
import { INSTAGRAM_PRIVATE_REPLY_JOB, INSTAGRAM_PROFILE_FETCH_JOB } from './jobs';
import { lockInstagramSender } from '@/lib/contacts/identity-link';
import { INSTAGRAM_WEBHOOK_PROVIDER } from './webhook';
import { commentMatchesTrigger, rankCommentFlows, type CommentFlowCandidate, type PostMatch } from './comment-matching';
import { liveCommentMatches } from '@/lib/flows/triggers';
import { effectiveTriggers } from '@/lib/flows/flow-triggers';
import { normalizeInboundRef } from './ref-links';
import type { FlowRow, IgCommentTriggerConfig, IgLiveCommentTriggerConfig } from '@/lib/flows/types';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const IG_ID = /^\d{1,32}$/;
const MAX_ITEMS = 100;
const MAX_ATTACHMENTS = 10;
const MAX_TEXT = 4096;
const MAX_URL = 2048;
const MAX_REPLY_ID = 256;

// ---------------------------------------------------------------- parsing (pure)

export type IgContentType = 'text' | 'image' | 'video' | 'audio' | 'document' | 'interactive' | 'story_reply' | 'share' | 'unsupported';

export interface IgItem {
  /** Meta's mid for the first item; `<mid>#<n>` for further attachments of the same message. */
  messageId: string;
  contentType: IgContentType;
  text: string | null;
  mediaUrl: string | null;
  interactiveReplyId: string | null;
  /** Stored under interactive_payload.ig (fixed keys). */
  ig: Record<string, unknown> | null;
}

export type ParsedEvent =
  | { kind: 'message'; igsid: string; createdAt: Date; replyToMid: string | null; items: IgItem[] }
  | { kind: 'echo'; igsid: string; createdAt: Date; items: IgItem[] }
  /** A referral with no message (Stage 3): the chat was opened from a ref link or ad. */
  | { kind: 'referral'; igsid: string; createdAt: Date; referral: Record<string, string> }
  | { kind: 'unsupported' }
  | { kind: 'ignored' };

export interface ParsedComment {
  commentId: string;
  mediaId: string | null;
  fromIgsid: string | null;
  text: string;
  /** A comment on a Live broadcast (the live_comments field, Stage 3); `mediaId` is then the broadcast's media id. */
  live?: boolean;
}

const obj = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
const igId = (value: unknown): string | null => {
  const text = typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : value;
  return typeof text === 'string' && IG_ID.test(text) ? text : null;
};
const str = (value: unknown, max: number): string | null =>
  typeof value === 'string' && value.length > 0 ? value.slice(0, max) : null;
const httpsUrl = (value: unknown): string | null =>
  typeof value === 'string' && value.length <= MAX_URL && /^https:\/\/[^\s]+$/.test(value) ? value : null;
const mid = (value: unknown): string | null =>
  typeof value === 'string' && value.length >= 1 && value.length <= 240 && /^[\x21-\x7e]+$/.test(value) ? value : null;

/** Text made only of emoji (a story reaction): at least one pictograph, no letters or digits, short. */
export function isEmojiOnly(text: string | null): boolean {
  if (!text) return false;
  const trimmed = text.trim();
  return trimmed.length > 0 && trimmed.length <= 32 && /\p{Extended_Pictographic}/u.test(trimmed) &&
    !/[\p{L}\p{N}]/u.test(trimmed.replace(/\p{Extended_Pictographic}/gu, '')) &&
    /^[\p{Extended_Pictographic}\p{Emoji_Modifier}\p{Regional_Indicator}\u200d\ufe0f\s]+$/u.test(trimmed);
}

function eventDate(value: unknown, now: Date): Date {
  const ms = typeof value === 'number' ? value : typeof value === 'string' && /^\d{1,15}$/.test(value) ? Number(value) : NaN;
  // Meta sends milliseconds; anything implausible (or in the future) is "now".
  if (!Number.isFinite(ms) || ms < 1_000_000_000_000 || ms > now.getTime() + 60_000) return now;
  return new Date(ms);
}

const ATTACHMENT_TYPES: Record<string, IgContentType> = {
  image: 'image', video: 'video', audio: 'audio', file: 'document',
  share: 'share', ig_reel: 'share', reel: 'share', ig_post: 'share',
};

/** Attachment types that mean "shared one of the account's posts to their story" (needs live capture). */
const SHARE_TO_STORY_TYPES = new Set(['story_share', 'share_to_story']);

function referralOf(value: unknown): Record<string, string> | null {
  const r = obj(value);
  if (!r) return null;
  const out: Record<string, string> = {};
  for (const key of ['ref', 'source', 'type'] as const) {
    const v = str(r[key], 256);
    if (v) out[key] = v;
  }
  // Click-to-Direct ads (Stage 3; needs live capture): the ad id and title. Never the click id or customer content.
  const adId = igId(r.ad_id);
  if (adId) out.ad_id = adId;
  const adTitle = str(obj(r.ads_context_data)?.ad_title, 256);
  if (adTitle) out.ad_title = adTitle;
  return Object.keys(out).length ? out : null;
}

function messageItems(message: Record<string, unknown>, baseMid: string): IgItem[] {
  const text = str(message.text, MAX_TEXT);
  const extra: Record<string, unknown> = {};
  const referral = referralOf(message.referral);
  if (referral) extra.referral = referral;
  const withExtra = (ig: Record<string, unknown> | null) =>
    Object.keys(extra).length || ig ? { ...(ig ?? {}), ...extra } : null;
  if (message.is_unsupported === true)
    return [{ messageId: baseMid, contentType: 'unsupported', text: null, mediaUrl: null, interactiveReplyId: null, ig: withExtra({ type: 'unsupported' }) }];
  const replyTo = obj(message.reply_to);
  const story = obj(replyTo?.story);
  if (story) {
    const url = httpsUrl(story.url);
    const storyId = igId(story.id);
    // (needs live capture) a quick emoji reaction to a story arrives as a story reply whose text is only the emoji.
    const reaction = isEmojiOnly(text);
    return [{ messageId: baseMid, contentType: 'story_reply', text, mediaUrl: null, interactiveReplyId: null,
      ig: withExtra({ story: true, ...(url ? { url } : {}), ...(storyId ? { story_id: storyId } : {}), ...(reaction ? { reaction: true } : {}) }) }];
  }
  const quick = obj(message.quick_reply);
  const quickPayload = str(quick?.payload, MAX_REPLY_ID);
  if (quickPayload)
    return [{ messageId: baseMid, contentType: 'interactive', text, mediaUrl: null, interactiveReplyId: quickPayload,
      ig: withExtra({ quick_reply: true }) }];
  const attachments = Array.isArray(message.attachments) ? message.attachments.slice(0, MAX_ATTACHMENTS) : [];
  if (attachments.length) {
    return attachments.map((raw, index) => {
      const a = obj(raw);
      const type = typeof a?.type === 'string' ? a.type : '';
      const url = httpsUrl(obj(a?.payload)?.url);
      const mapped = ATTACHMENT_TYPES[type];
      const messageId = index === 0 ? baseMid : `${baseMid}#${index}`;
      const caption = index === 0 ? text : null;
      // (needs live capture) a mention of the account in the customer's story: Meta's
      // documented shape is an attachment of type story_mention with the story's CDN url.
      // Share-to-Story (Stage 4; needs live capture, Meta may not deliver it to Instagram Login apps):
      // built against a documented fixture, an attachment of type story_share with the shared post's url.
      // Only the engine acts on it, and only while INSTAGRAM_SHARE_TO_STORY_ENABLED is on.
      if (SHARE_TO_STORY_TYPES.has(type))
        return { messageId, contentType: 'share' as const, text: caption, mediaUrl: null, interactiveReplyId: null,
          ig: withExtra({ share_to_story: true, ...(url ? { url } : {}) }) };
      if (type === 'story_mention')
        return { messageId, contentType: 'share' as const, text: caption, mediaUrl: null, interactiveReplyId: null,
          ig: withExtra({ story_mention: true, ...(url ? { url } : {}) }) };
      if (!mapped || !url)
        return { messageId, contentType: 'unsupported' as const, text: caption, mediaUrl: null, interactiveReplyId: null,
          ig: withExtra({ type: /^[a-z_]{1,32}$/.test(type) ? type : 'unknown' }) };
      if (mapped === 'share')
        return { messageId, contentType: 'share' as const, text: caption, mediaUrl: null, interactiveReplyId: null, ig: withExtra({ url }) };
      return { messageId, contentType: mapped, text: caption, mediaUrl: url, interactiveReplyId: null, ig: withExtra(null) };
    });
  }
  if (text) return [{ messageId: baseMid, contentType: 'text', text, mediaUrl: null, interactiveReplyId: null, ig: withExtra(null) }];
  return [{ messageId: baseMid, contentType: 'unsupported', text: null, mediaUrl: null, interactiveReplyId: null, ig: withExtra({ type: 'unknown' }) }];
}

/** One entry.messaging[] event. `accountIgId` is entry.id (the professional account). */
export function parseMessagingEvent(accountIgId: string, raw: unknown, now: Date = new Date()): ParsedEvent {
  const ev = obj(raw);
  if (!ev) return { kind: 'ignored' };
  const sender = igId(obj(ev.sender)?.id);
  const recipient = igId(obj(ev.recipient)?.id);
  const createdAt = eventDate(ev.timestamp, now);
  const message = obj(ev.message);
  if (message) {
    if (message.is_deleted === true) return { kind: 'unsupported' };
    const id = mid(message.mid);
    if (!id) return { kind: 'ignored' };
    if (message.is_echo === true || sender === accountIgId) {
      if (!recipient || recipient === accountIgId) return { kind: 'ignored' };
      const items = messageItems(message, id).map((item) => ({ ...item, ig: { ...(item.ig ?? {}), external_echo: true } }));
      return { kind: 'echo', igsid: recipient, createdAt, items };
    }
    if (!sender) return { kind: 'ignored' };
    const replyToMid = mid(obj(message.reply_to)?.mid);
    const items = messageItems(message, id);
    // A referral beside the message (Stage 3; the other place Meta may put it) rides on the message's first item.
    const beside = referralOf(ev.referral);
    if (beside && !items[0].ig?.referral) items[0] = { ...items[0], ig: { ...(items[0].ig ?? {}), referral: beside } };
    return { kind: 'message', igsid: sender, createdAt, replyToMid, items };
  }
  const postback = obj(ev.postback);
  if (postback) {
    if (!sender || sender === accountIgId) return { kind: 'ignored' };
    const payload = str(postback.payload, MAX_REPLY_ID);
    const title = str(postback.title, 256);
    if (!payload && !title) return { kind: 'ignored' };
    // Postbacks carry a mid; a synthetic, deterministic id keeps a redelivery deduplicated if one ever does not.
    const id = mid(postback.mid) ?? `igpb:${createHash('sha256').update(`${sender}:${String(ev.timestamp)}:${payload ?? ''}:${title ?? ''}`).digest('hex').slice(0, 48)}`;
    const referral = referralOf(postback.referral) ?? referralOf(ev.referral);
    return {
      kind: 'message', igsid: sender, createdAt, replyToMid: null,
      items: [{ messageId: id, contentType: 'interactive', text: title ?? payload, mediaUrl: null,
        interactiveReplyId: payload ?? title, ig: { postback: { title }, ...(referral ? { referral } : {}) } }],
    };
  }
  // A referral on its own (Stage 3: the chat of someone already known was opened from a ref link or ad).
  const referral = referralOf(ev.referral);
  if (referral && sender && sender !== accountIgId) return { kind: 'referral', igsid: sender, createdAt, referral };
  // message_reactions, messaging_seen (read), optins, handover and unknown keys.
  return { kind: 'unsupported' };
}

/**
 * A comments or live_comments change, or null when it is not one this phase
 * processes. The live_comments payload (Stage 3) is built against Meta's
 * documented shape, the same as a comment with the broadcast as its media;
 * needs live capture.
 */
export function parseCommentChange(raw: unknown): ParsedComment | 'unsupported' | null {
  const change = obj(raw);
  if (!change) return null;
  if (change.field !== 'comments' && change.field !== 'live_comments') return 'unsupported';
  const value = obj(change.value);
  const commentId = igId(value?.id);
  if (!value || !commentId) return null;
  return {
    commentId,
    mediaId: igId(obj(value.media)?.id),
    fromIgsid: igId(obj(value.from)?.id),
    text: typeof value.text === 'string' ? value.text.slice(0, MAX_TEXT) : '',
    ...(change.field === 'live_comments' ? { live: true } : {}),
  };
}

export interface CommentRule { id: string; media_id: string | null; keywords: string[] }

/** The rule a comment matches: a rule for this post before an any-post rule, then the oldest. Keywords match as lower-cased substrings. */
export function matchCommentRule(rules: readonly CommentRule[], comment: { mediaId: string | null; text: string }): CommentRule | null {
  const text = comment.text.toLowerCase();
  const matches = (rule: CommentRule) =>
    (rule.media_id === null || rule.media_id === comment.mediaId) &&
    (rule.keywords.length === 0 || rule.keywords.some((k) => k && text.includes(k.toLowerCase())));
  return rules.find((r) => r.media_id !== null && matches(r)) ?? rules.find((r) => r.media_id === null && matches(r)) ?? null;
}

// ---------------------------------------------------------------- job

interface Owner { accountId: string; instagramAccountId: string }
interface AccountState { scopes: string[]; auditUserId: string | null }

async function markReceipt(receiptId: string, status: string): Promise<void> {
  await getWorkerPrisma().$executeRaw`UPDATE webhook_receipts SET status=${status}
    WHERE id=${receiptId}::uuid AND provider=${INSTAGRAM_WEBHOOK_PROVIDER} AND status<>'processed'`;
}

/** The instagram.webhook job: { receiptId }. */
export async function processInstagramWebhookJob(payload: Record<string, unknown>, assertLease: () => void = () => {}): Promise<void> {
  const receiptId = payload.receiptId;
  if (typeof receiptId !== 'string' || !UUID.test(receiptId)) throw new Error('Invalid job identifier');
  if (!instagramConfig()) {
    // Queued while Instagram was on: nothing is written or called.
    await markReceipt(receiptId, 'skipped_disabled');
    return;
  }
  const rows = await getWorkerPrisma().$queryRaw<{ payload: unknown; status: string }[]>`
    SELECT payload, status FROM webhook_receipts WHERE id=${receiptId}::uuid AND provider=${INSTAGRAM_WEBHOOK_PROVIDER}`;
  if (!rows[0] || rows[0].status === 'processed') return;
  const body = obj(rows[0].payload);
  const entries = body?.object === 'instagram' && Array.isArray(body.entry) ? body.entry.slice(0, MAX_ITEMS) : [];
  let unknownAccounts = 0;
  let planDropped = 0;
  const unsupported = new Map<string, { owner: Owner; count: number }>();
  for (const rawEntry of entries) {
    assertLease();
    const entry = obj(rawEntry);
    const accountIgId = igId(entry?.id);
    if (!entry || !accountIgId) continue;
    const owner = await resolveOwner(accountIgId);
    if (!owner) {
      unknownAccounts++;
      continue;
    }
    const outcome = await withJobScope({ accountId: owner.accountId, role: 'owner' },
      () => processEntry(owner, accountIgId, entry, assertLease));
    if (outcome === 'plan') planDropped++;
    else if (outcome.unsupported) {
      const seen = unsupported.get(owner.instagramAccountId);
      if (seen) seen.count += outcome.unsupported;
      else unsupported.set(owner.instagramAccountId, { owner, count: outcome.unsupported });
    }
  }
  // Counts only: no Instagram ids or content are logged.
  if (unknownAccounts) console.warn('[instagram] webhook entries for unconnected accounts dropped', { count: unknownAccounts });
  if (planDropped) console.warn('[instagram] webhook entries dropped: plan does not include Instagram', { count: planDropped });
  assertLease();
  if (!unsupported.size) {
    await markReceipt(receiptId, 'processed');
    return;
  }
  // The counts apply only if this transaction is the one that marks the receipt
  // processed: a retry after a failed entry recounts in memory, never in the table.
  await getWorkerPrisma().$transaction(async (tx) => {
    const marked = await tx.$executeRaw`UPDATE webhook_receipts SET status='processed'
      WHERE id=${receiptId}::uuid AND provider=${INSTAGRAM_WEBHOOK_PROVIDER} AND status<>'processed'`;
    if (!marked) return;
    for (const { owner, count } of unsupported.values()) {
      await tx.$queryRaw`SELECT set_config('app.account_id', ${owner.accountId}, true),
        set_config('app.user_id', '', true), set_config('app.account_role', 'owner', true)`;
      await tx.$executeRaw`UPDATE instagram_accounts
        SET unsupported_event_count=LEAST(unsupported_event_count::bigint + ${count}, 2147483647)::int, unsupported_event_last_at=now()
        WHERE account_id=${owner.accountId}::uuid AND id=${owner.instagramAccountId}::uuid`;
    }
  }, { maxWait: 10_000, timeout: 30_000 });
}

async function resolveOwner(igUserId: string): Promise<Owner | null> {
  const rows = await getWorkerPrisma().$queryRaw<{ account_id: string; instagram_account_id: string }[]>`
    SELECT account_id::text AS account_id, instagram_account_id::text AS instagram_account_id
    FROM crm_resolve_instagram_account(${igUserId})`;
  return rows[0] ? { accountId: rows[0].account_id, instagramAccountId: rows[0].instagram_account_id } : null;
}

const tenant = <T>(accountId: string, work: (tx: TenantTransaction) => Promise<T>) =>
  withTenant({ accountId, role: 'owner' }, work, getWorkerPrisma());

async function processEntry(owner: Owner, accountIgId: string, entry: Record<string, unknown>,
  assertLease: () => void): Promise<{ unsupported: number } | 'plan'> {
  const state = await tenant(owner.accountId, async (tx): Promise<AccountState | null> => {
    const entitlements = await getEntitlements(tx, owner.accountId);
    if (!entitlements.features.instagram) return null;
    const [row] = await tx.$queryRaw<{ scopes: string[] | null; connected_by_user_id: string | null; owner_user_id: string | null }[]>`
      SELECT a.scopes, a.connected_by_user_id::text AS connected_by_user_id, acc.owner_user_id::text AS owner_user_id
      FROM instagram_accounts a JOIN accounts acc ON acc.id=a.account_id
      WHERE a.account_id=${owner.accountId}::uuid AND a.id=${owner.instagramAccountId}::uuid`;
    await tx.$executeRaw`UPDATE instagram_accounts SET last_webhook_at=now()
      WHERE account_id=${owner.accountId}::uuid AND id=${owner.instagramAccountId}::uuid`;
    return { scopes: row?.scopes ?? [], auditUserId: row?.connected_by_user_id ?? row?.owner_user_id ?? null };
  });
  if (!state) return 'plan';
  if (!state.auditUserId) throw new Error('Instagram audit user could not be resolved');
  let unsupported = 0;
  const now = new Date();
  const messaging = Array.isArray(entry.messaging) ? entry.messaging.slice(0, MAX_ITEMS) : [];
  for (const raw of messaging) {
    assertLease();
    const event = parseMessagingEvent(accountIgId, raw, now);
    if (event.kind === 'unsupported') unsupported++;
    else if (event.kind === 'message') await storeCustomerMessage(owner, state.auditUserId, event);
    else if (event.kind === 'echo') await storeEcho(owner, event);
    else if (event.kind === 'referral') await storeReferralOnly(owner, event);
  }
  // standby (handover protocol) is not used in this phase.
  if (Array.isArray(entry.standby)) unsupported += Math.min(entry.standby.length, MAX_ITEMS);
  const changes = Array.isArray(entry.changes) ? entry.changes.slice(0, MAX_ITEMS) : [];
  const commentsGranted = missingScopes(state.scopes, 'comments').length === 0;
  for (const raw of changes) {
    assertLease();
    const comment = parseCommentChange(raw);
    if (comment === null) continue;
    if (comment === 'unsupported' || !commentsGranted) {
      unsupported++;
      continue;
    }
    // The account's own comments (replies made in the Instagram app) never trigger a private reply.
    if (comment.fromIgsid === accountIgId) continue;
    await recordComment(owner, comment);
  }
  return { unsupported };
}

interface Thread { contactId: string; conversationId: string; contactCreated: boolean; conversationCreated: boolean }

/**
 * Finds or creates the identity, its contact and the Instagram conversation in
 * one transaction. The sender lock on (instagram account, IGSID) makes two
 * deliveries for the same new sender create one contact, and is the lock staff
 * link/unlink take first, so the identity read below is never a contact a link
 * is moving it away from; the unique keys stay the final guard.
 */
async function resolveThread(owner: Owner, auditUserId: string, igsid: string): Promise<Thread> {
  return tenant(owner.accountId, async (tx) => {
    await lockInstagramSender(tx, owner.instagramAccountId, igsid);
    let contactCreated = false;
    let [identity] = await tx.$queryRaw<{ id: string; contact_id: string }[]>`
      SELECT id::text AS id, contact_id::text AS contact_id FROM contact_channel_identities
      WHERE account_id=${owner.accountId}::uuid AND instagram_account_id=${owner.instagramAccountId}::uuid AND external_id=${igsid}`;
    if (!identity) {
      // A new IGSID always gets its own phone-less contact (CRM-02: never matched to an existing one).
      const [contact] = await tx.$queryRaw<{ id: string }[]>`
        INSERT INTO contacts(account_id,user_id,phone,name)
        VALUES(${owner.accountId}::uuid,${auditUserId}::uuid,'',NULL) RETURNING id::text AS id`;
      [identity] = await tx.$queryRaw<{ id: string; contact_id: string }[]>`
        INSERT INTO contact_channel_identities(account_id,contact_id,channel,instagram_account_id,external_id)
        VALUES(${owner.accountId}::uuid,${contact.id}::uuid,'instagram',${owner.instagramAccountId}::uuid,${igsid})
        RETURNING id::text AS id, contact_id::text AS contact_id`;
      contactCreated = true;
      await tx.$executeRaw`INSERT INTO jobs(type,tenant_id,payload,dedupe_key)
        VALUES(${INSTAGRAM_PROFILE_FETCH_JOB},${owner.accountId}::uuid,${JSON.stringify({ accountId: owner.accountId, identityId: identity.id })}::jsonb,
          ${`igprofile:${identity.id}`}) ON CONFLICT(dedupe_key) DO NOTHING`;
    }
    const find = () => tx.$queryRaw<{ id: string }[]>`SELECT id::text AS id FROM conversations
      WHERE account_id=${owner.accountId}::uuid AND contact_id=${identity.contact_id}::uuid
        AND channel='instagram' AND instagram_account_id=${owner.instagramAccountId}::uuid LIMIT 1`;
    let [conversation] = await find();
    let conversationCreated = false;
    if (!conversation) {
      [conversation] = await tx.$queryRaw<{ id: string }[]>`
        INSERT INTO conversations(account_id,user_id,contact_id,channel,instagram_account_id)
        VALUES(${owner.accountId}::uuid,${auditUserId}::uuid,${identity.contact_id}::uuid,'instagram',${owner.instagramAccountId}::uuid)
        ON CONFLICT DO NOTHING RETURNING id::text AS id`;
      if (conversation) conversationCreated = true;
      else [conversation] = await find();
      if (!conversation) throw new Error('Instagram conversation could not be resolved');
    }
    return { contactId: identity.contact_id, conversationId: conversation.id, contactCreated, conversationCreated };
  });
}

/** The ref a referral carries, if it fits what we store (a label only). */
const refOf = (referral: Record<string, unknown> | null | undefined): string | null => normalizeInboundRef(referral?.ref);

/**
 * Saves the ref on the sender's identity (the contact's last ref link), never
 * moving it back to an older event. Worker role inside the workspace; the app
 * role cannot write these columns.
 */
async function saveLastRef(tx: TenantTransaction, owner: Owner, igsid: string, ref: string, at: Date): Promise<void> {
  await tx.$executeRaw`UPDATE contact_channel_identities SET last_ref=${ref}, last_ref_at=${at}
    WHERE account_id=${owner.accountId}::uuid AND instagram_account_id=${owner.instagramAccountId}::uuid AND external_id=${igsid}
      AND (last_ref_at IS NULL OR last_ref_at <= ${at})`;
}

/** A referral with no message: only an identity that already exists is updated; nothing is created or started. */
async function storeReferralOnly(owner: Owner, event: Extract<ParsedEvent, { kind: 'referral' }>): Promise<void> {
  const ref = refOf(event.referral);
  if (!ref) return;
  await tenant(owner.accountId, async (tx) => {
    await lockInstagramSender(tx, owner.instagramAccountId, event.igsid);
    await saveLastRef(tx, owner, event.igsid, ref, event.createdAt);
  });
}

async function storeCustomerMessage(owner: Owner, auditUserId: string,
  event: Extract<ParsedEvent, { kind: 'message' }>): Promise<void> {
  const thread = await resolveThread(owner, auditUserId, event.igsid);
  // The ref is saved before the message is stored, so the flow it starts already finds it on the contact.
  const ref = event.items.map((item) => refOf(item.ig?.referral as Record<string, unknown> | undefined)).find((r) => r !== null) ?? null;
  if (ref) await tenant(owner.accountId, (tx) => saveLastRef(tx, owner, event.igsid, ref, event.createdAt));
  const replyToMessageId = event.replyToMid ? await tenant(owner.accountId, async (tx) => {
    const [row] = await tx.$queryRaw<{ id: string }[]>`SELECT id::text AS id FROM messages
      WHERE account_id=${owner.accountId}::uuid AND conversation_id=${thread.conversationId}::uuid AND message_id=${event.replyToMid} LIMIT 1`;
    return row?.id ?? null;
  }) : null;
  let first = true;
  for (const item of event.items) {
    await ingestInboundMessage({
      accountId: owner.accountId, userId: auditUserId, contactId: thread.contactId, conversationId: thread.conversationId,
      metaMessageId: item.messageId, contentType: item.contentType, contentText: item.text,
      mediaUrl: item.mediaUrl, mediaType: null, interactiveReplyId: item.interactiveReplyId,
      interactivePayload: item.ig ? { ig: item.ig } : null,
      replyToMessageId: first ? replyToMessageId : null, createdAt: event.createdAt,
      wasContactCreated: first && thread.contactCreated, wasConversationCreated: first && thread.conversationCreated,
    });
    first = false;
  }
}

/**
 * A message the business sent from the Instagram app: stored as an agent
 * message (deduped by mid, so our own sends are a no-op). Never creates a
 * contact or conversation, and never counts as a customer message.
 */
async function storeEcho(owner: Owner, event: Extract<ParsedEvent, { kind: 'echo' }>): Promise<void> {
  await tenant(owner.accountId, async (tx) => {
    const [conversation] = await tx.$queryRaw<{ id: string }[]>`SELECT c.id::text AS id
      FROM contact_channel_identities i
      JOIN conversations c ON c.account_id=i.account_id AND c.contact_id=i.contact_id
        AND c.channel='instagram' AND c.instagram_account_id=i.instagram_account_id
      WHERE i.account_id=${owner.accountId}::uuid AND i.instagram_account_id=${owner.instagramAccountId}::uuid
        AND i.external_id=${event.igsid} LIMIT 1`;
    if (!conversation) return;
    let inserted = 0;
    let preview: string | null = null;
    for (const item of event.items) {
      const rows = await tx.$executeRaw(Prisma.sql`INSERT INTO messages(account_id,conversation_id,sender_type,content_type,
        content_text,media_url,message_id,status,created_at,interactive_reply_id,interactive_payload)
        VALUES(${owner.accountId}::uuid,${conversation.id}::uuid,'agent',${item.contentType},${item.text},${item.mediaUrl},
          ${item.messageId},'sent',${event.createdAt},${item.interactiveReplyId},${JSON.stringify({ ig: item.ig })}::jsonb)
        ON CONFLICT(conversation_id,message_id) DO NOTHING`);
      if (rows) {
        inserted += rows;
        preview ??= item.text || `[${item.contentType}]`;
      }
    }
    if (inserted) await tx.$executeRaw`UPDATE conversations SET last_message_text=${preview},last_message_at=now(),updated_at=now()
      WHERE account_id=${owner.accountId}::uuid AND id=${conversation.id}::uuid`;
  });
}

/** True when the commenter's identity on this account belongs to a blocked contact. */
async function senderBlocked(tx: TenantTransaction, owner: Owner, igsid: string): Promise<boolean> {
  const [row] = await tx.$queryRaw<{ blocked: boolean }[]>`SELECT EXISTS(SELECT 1 FROM contact_channel_identities i
      JOIN contacts ct ON ct.account_id=i.account_id AND ct.id=i.contact_id
      WHERE i.account_id=${owner.accountId}::uuid AND i.instagram_account_id=${owner.instagramAccountId}::uuid
        AND i.external_id=${igsid} AND ct.blocked_at IS NOT NULL) AS blocked`;
  return row?.blocked === true;
}

/**
 * A live ig_comment flow the comment fits; `check`: only if its post is the
 * account's next post (the job decides). `trigger` (Stage 5): the index, in
 * effectiveTriggers order, of the flow's comment trigger that matched (a flow
 * may also listen on extra triggers); absent on jobs queued before Stage 5,
 * which mean the primary trigger.
 */
export interface CommentFlowChoice { flowId: string; check: boolean; trigger?: number }

/** A flow that may take a comment: the active flows' published triggers, and drafts tested by this commenter (Stage 5). */
interface CommentFlowRow {
  id: string;
  created_at: Date;
  status: FlowRow['status'];
  trigger_type: string;
  trigger_config: unknown;
  extra_triggers: unknown;
}

/**
 * The flows that listen on `triggerType`: each active flow on its published
 * version (primary trigger or one of its extra triggers, Stage 5), plus the
 * drafts whose test usernames include this commenter's stored username on
 * this account (drafts first, as for messages). This workspace only.
 */
async function commentFlowRows(tx: TenantTransaction, owner: Owner, triggerType: 'ig_comment' | 'ig_live_comment',
  scopes: readonly string[], igsid: string): Promise<CommentFlowRow[]> {
  const extra = JSON.stringify([{ trigger_type: triggerType }]);
  return tx.$queryRaw<CommentFlowRow[]>`
    SELECT f.id::text AS id, f.created_at, f.status, v.trigger_type, v.trigger_config, v.extra_triggers
    FROM flows f JOIN flow_versions v ON v.account_id=f.account_id AND v.id=f.published_version_id AND v.flow_id=f.id
    WHERE f.account_id=${owner.accountId}::uuid AND f.status='active'
      AND (v.trigger_type=${triggerType} OR v.extra_triggers @> ${extra}::jsonb)
      AND v.channel_scope = ANY(${[...scopes]}::text[])
    UNION ALL
    SELECT f.id::text AS id, f.created_at, f.status, f.trigger_type, f.trigger_config, f.extra_triggers
    FROM flows f JOIN contact_channel_identities i ON i.account_id=f.account_id
      AND i.instagram_account_id=${owner.instagramAccountId}::uuid AND i.external_id=${igsid}
    WHERE f.account_id=${owner.accountId}::uuid AND f.status='draft' AND f.channel_scope='instagram'
      AND cardinality(f.test_usernames)>0 AND ltrim(lower(btrim(i.username)), '@') = ANY(f.test_usernames)
      AND (f.trigger_type=${triggerType} OR f.extra_triggers @> ${extra}::jsonb)
    -- status DESC: 'draft' sorts before 'active', so a tester's draft comes first.
    ORDER BY 3 DESC, 2, 1 LIMIT 120`;
}

/** The flow's triggers of one kind, with their index in effectiveTriggers order. */
function triggersOfType<T>(flow: CommentFlowRow, triggerType: string): Array<{ index: number; config: T }> {
  return effectiveTriggers(flow).flatMap((trigger, index) => (trigger.trigger_type === triggerType
    ? [{ index, config: trigger.config as unknown as T }] : []));
}

/**
 * What the live ig_comment flows make of a comment. `choices`: the flows it may
 * start, best first (comment-matching.ts). `ruleSkipped`: a flow already took an
 * earlier comment by this person on this post, so the flow owns that
 * conversation and the legacy rule must not send a second, different DM.
 */
export interface CommentFlowOffer { choices: CommentFlowChoice[]; ruleSkipped: boolean }

/**
 * Reads the published version of each active Instagram (or legacy both-channel)
 * flow of this workspace only. No choices unless this is the person's first
 * comment on the post: this account's comment events are the record of that.
 */
async function commentFlowChoices(tx: TenantTransaction, owner: Owner, comment: ParsedComment, eventId: string): Promise<CommentFlowOffer> {
  const flows = await commentFlowRows(tx, owner, 'ig_comment', ['instagram', 'any'], comment.fromIgsid!);
  if (!flows.length) return { choices: [], ruleSkipped: false };
  if (comment.mediaId) {
    const [earlier] = await tx.$queryRaw<{ found: boolean; flow_taken: boolean }[]>`SELECT
      EXISTS(SELECT 1 FROM instagram_comment_events
        WHERE account_id=${owner.accountId}::uuid AND instagram_account_id=${owner.instagramAccountId}::uuid
          AND media_id=${comment.mediaId} AND from_igsid=${comment.fromIgsid} AND id<>${eventId}::uuid) AS found,
      EXISTS(SELECT 1 FROM instagram_comment_events
        WHERE account_id=${owner.accountId}::uuid AND instagram_account_id=${owner.instagramAccountId}::uuid
          AND media_id=${comment.mediaId} AND from_igsid=${comment.fromIgsid} AND id<>${eventId}::uuid
          AND flow_run_id IS NOT NULL) AS flow_taken`;
    if (earlier?.found) return { choices: [], ruleSkipped: earlier.flow_taken === true };
  }
  const facts = { instagramAccountId: owner.instagramAccountId, mediaId: comment.mediaId, text: comment.text };
  const candidates: Array<CommentFlowCandidate & { match: PostMatch; trigger: number; draft: boolean }> = [];
  for (const flow of flows) {
    // Stage 5: each of the flow's ig_comment triggers (primary or extra); the best match speaks for the flow.
    let best: (CommentFlowCandidate & { match: PostMatch; trigger: number; draft: boolean }) | null = null;
    for (const { index, config } of triggersOfType<IgCommentTriggerConfig>(flow, 'ig_comment')) {
      let resolvedNext: string | null = null;
      if (config.post_scope === 'next' && !config.resolved_media_id && typeof config.next_after === 'string'
        && Number.isFinite(Date.parse(config.next_after))) {
        // The next post is the one the flow's first comment run started on (that run carries the media id).
        const [first] = await tx.$queryRaw<{ media_id: string | null }[]>`SELECT vars->>'ig_media_id' AS media_id
          FROM flow_runs WHERE account_id=${owner.accountId}::uuid AND flow_id=${flow.id}::uuid
            AND started_at >= ${new Date(config.next_after)} AND vars->>'ig_media_id' IS NOT NULL
          ORDER BY started_at, id LIMIT 1`;
        resolvedNext = first?.media_id ?? null;
      }
      const match = commentMatchesTrigger(config, facts, resolvedNext);
      if (match === 'no' || (best && (best.match === 'yes' || match === 'check'))) continue;
      best = { flowId: flow.id, createdAt: new Date(flow.created_at).toISOString(), config, match, trigger: index, draft: flow.status === 'draft' };
    }
    if (best) candidates.push(best);
  }
  // A draft being tested comes first for its tester (as with messages, triggers.ts byPrecedence).
  const ranked = rankCommentFlows(candidates);
  const ordered = [...ranked.filter((c) => c.draft), ...ranked.filter((c) => !c.draft)];
  return { choices: ordered.map((c) => ({ flowId: c.flowId, check: c.match === 'check', ...(c.trigger ? { trigger: c.trigger } : {}) })), ruleSkipped: false };
}

/**
 * What the live ig_live_comment flows make of a Live comment: the flows it may
 * start, oldest first. A person's first *matching* comment per broadcast only:
 * once an earlier comment of theirs on this broadcast has been taken (a flow
 * run, or a private reply queued or sent), later ones start nothing, while
 * comments nobody took do not use the person's one start up. Reads the
 * published version of this workspace's flows only. No legacy rule applies.
 */
async function liveCommentFlowChoices(tx: TenantTransaction, owner: Owner, comment: ParsedComment, eventId: string): Promise<CommentFlowOffer> {
  const flows = await commentFlowRows(tx, owner, 'ig_live_comment', ['instagram'], comment.fromIgsid!);
  if (!flows.length) return { choices: [], ruleSkipped: false };
  // Stage 5: the first of the flow's ig_live_comment triggers (primary or extra) that the comment fits.
  const matching = flows.flatMap((flow) => {
    const hit = triggersOfType<IgLiveCommentTriggerConfig>(flow, 'ig_live_comment')
      .find(({ config }) => liveCommentMatches(config, { instagramAccountId: owner.instagramAccountId, text: comment.text }));
    return hit ? [{ id: flow.id, trigger: hit.index }] : [];
  });
  if (!matching.length) return { choices: [], ruleSkipped: false };
  if (comment.mediaId) {
    const [earlier] = await tx.$queryRaw<{ taken: boolean }[]>`SELECT EXISTS(SELECT 1 FROM instagram_comment_events
      WHERE account_id=${owner.accountId}::uuid AND instagram_account_id=${owner.instagramAccountId}::uuid
        AND media_id=${comment.mediaId} AND from_igsid=${comment.fromIgsid} AND id<>${eventId}::uuid
        AND (flow_run_id IS NOT NULL OR private_reply_status IN ('queued','sent','unknown'))) AS taken`;
    if (earlier?.taken) return { choices: [], ruleSkipped: false };
  }
  return { choices: matching.map((flow) => ({ flowId: flow.id, check: false, ...(flow.trigger ? { trigger: flow.trigger } : {}) })), ruleSkipped: false };
}

/**
 * Records a comment once and queues its private reply job (one per comment:
 * the unique key and the job's dedupe key). A comment a live ig_comment flow
 * may take is queued for the flow, with the matching legacy rule (if any) kept
 * only as the fallback when no flow takes it; otherwise the legacy rule path
 * runs exactly as before, except that a person a flow already answered on this
 * post gets no rule DM for a later comment there. The sender lock serialises
 * two comments by the same person, so only one of them is their first on a post.
 */
async function recordComment(owner: Owner, comment: ParsedComment): Promise<void> {
  await tenant(owner.accountId, async (tx) => {
    if (comment.fromIgsid) await lockInstagramSender(tx, owner.instagramAccountId, comment.fromIgsid);
    const [event] = await tx.$queryRaw<{ id: string }[]>`
      INSERT INTO instagram_comment_events(account_id,instagram_account_id,comment_id,media_id,from_igsid)
      VALUES(${owner.accountId}::uuid,${owner.instagramAccountId}::uuid,${comment.commentId},${comment.mediaId},${comment.fromIgsid})
      ON CONFLICT DO NOTHING RETURNING id::text AS id`;
    if (!event) return;
    // Legacy comment rules are for posts: a Live comment never matches one.
    const rules = comment.live ? [] : await tx.$queryRaw<CommentRule[]>`SELECT id::text AS id, media_id, keywords FROM instagram_comment_rules
      WHERE account_id=${owner.accountId}::uuid AND instagram_account_id=${owner.instagramAccountId}::uuid AND active
      ORDER BY created_at, id LIMIT 200`;
    // A comment without a sender id cannot get a private reply.
    const noFlows: CommentFlowOffer = { choices: [], ruleSkipped: false };
    const offer = !comment.fromIgsid ? noFlows
      : comment.live ? await liveCommentFlowChoices(tx, owner, comment, event.id) : await commentFlowChoices(tx, owner, comment, event.id);
    // A flow already answered this person on this post: the rule never adds a second DM.
    const rule = comment.fromIgsid && !offer.ruleSkipped ? matchCommentRule(rules, comment) : null;
    const flows = offer.choices;
    const wanted = Boolean(rule) || flows.length > 0;
    // A contact the business blocked gets no automated DM (the private reply job checks again at send time).
    const blocked = wanted ? await senderBlocked(tx, owner, comment.fromIgsid!) : false;
    await tx.$executeRaw`UPDATE instagram_comment_events SET rule_id=${flows.length ? null : rule?.id ?? null}::uuid,
      private_reply_status=${wanted ? (blocked ? 'rejected' : 'queued') : 'no_rule'}
      WHERE account_id=${owner.accountId}::uuid AND id=${event.id}::uuid`;
    if (!wanted || blocked) return;
    // Ids only: the comment text never leaves this transaction.
    const payload = flows.length
      ? { accountId: owner.accountId, eventId: event.id, flows, fallbackRuleId: rule?.id ?? null }
      : { accountId: owner.accountId, eventId: event.id };
    await tx.$executeRaw`INSERT INTO jobs(type,tenant_id,payload,dedupe_key)
      VALUES(${INSTAGRAM_PRIVATE_REPLY_JOB},${owner.accountId}::uuid,${JSON.stringify(payload)}::jsonb,
        ${`igpr:${event.id}`}) ON CONFLICT(dedupe_key) DO NOTHING`;
  });
}

/**
 * The commenter's contact and Instagram conversation, created on their first
 * contact with the account under the same identity rules as a DM (found only
 * by (instagram account, IGSID), never matched by anything else). The comment
 * flow job calls it before it starts the run.
 */
export async function resolveCommentThread(accountId: string, instagramAccountId: string, igsid: string):
  Promise<{ contactId: string; conversationId: string; auditUserId: string }> {
  if (!IG_ID.test(igsid)) throw new Error('Invalid Instagram sender');
  const auditUserId = await tenant(accountId, async (tx) => {
    const [row] = await tx.$queryRaw<{ audit_user_id: string | null }[]>`
      SELECT COALESCE(a.connected_by_user_id, acc.owner_user_id)::text AS audit_user_id
      FROM instagram_accounts a JOIN accounts acc ON acc.id=a.account_id
      WHERE a.account_id=${accountId}::uuid AND a.id=${instagramAccountId}::uuid`;
    return row?.audit_user_id ?? null;
  });
  if (!auditUserId) throw new Error('Instagram audit user could not be resolved');
  const thread = await resolveThread({ accountId, instagramAccountId }, auditUserId, igsid);
  return { contactId: thread.contactId, conversationId: thread.conversationId, auditUserId };
}
