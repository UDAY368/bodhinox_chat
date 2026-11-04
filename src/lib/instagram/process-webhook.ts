// Instagram webhook processing (Phase 11, design section 5). The pre-scope job
// instagram.webhook loads its receipt and, per entry:
//   1. resolves entry.id to the workspace holding that professional account
//      (crm_resolve_instagram_account; unknown -> dropped, counted, no ids logged)
//      and checks the plan still includes Instagram;
//   2. stores customer messages and postbacks through the shared inbound ingest
//      (ingestInboundMessage, with no WhatsApp-only inputs), and echoes of sends
//      made in the Instagram app as agent messages (never opening the window);
//   3. records comments (only with the comments scope), matches a comment rule
//      and queues instagram.private_reply;
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
  | { kind: 'unsupported' }
  | { kind: 'ignored' };

export interface ParsedComment { commentId: string; mediaId: string | null; fromIgsid: string | null; text: string }

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

function referralOf(value: unknown): Record<string, string> | null {
  const r = obj(value);
  if (!r) return null;
  const out: Record<string, string> = {};
  for (const key of ['ref', 'source', 'type'] as const) {
    const v = str(r[key], 256);
    if (v) out[key] = v;
  }
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
    return [{ messageId: baseMid, contentType: 'story_reply', text, mediaUrl: null, interactiveReplyId: null,
      ig: withExtra({ story: true, ...(url ? { url } : {}) }) }];
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
    return { kind: 'message', igsid: sender, createdAt, replyToMid, items: messageItems(message, id) };
  }
  const postback = obj(ev.postback);
  if (postback) {
    if (!sender || sender === accountIgId) return { kind: 'ignored' };
    const payload = str(postback.payload, MAX_REPLY_ID);
    const title = str(postback.title, 256);
    if (!payload && !title) return { kind: 'ignored' };
    // Postbacks carry a mid; a synthetic, deterministic id keeps a redelivery deduplicated if one ever does not.
    const id = mid(postback.mid) ?? `igpb:${createHash('sha256').update(`${sender}:${String(ev.timestamp)}:${payload ?? ''}:${title ?? ''}`).digest('hex').slice(0, 48)}`;
    const referral = referralOf(postback.referral);
    return {
      kind: 'message', igsid: sender, createdAt, replyToMid: null,
      items: [{ messageId: id, contentType: 'interactive', text: title ?? payload, mediaUrl: null,
        interactiveReplyId: payload ?? title, ig: { postback: { title }, ...(referral ? { referral } : {}) } }],
    };
  }
  // message_reactions, messaging_seen (read), messaging_referral alone, optins, handover and unknown keys.
  return { kind: 'unsupported' };
}

/** A comments change, or null when it is not one this phase processes. */
export function parseCommentChange(raw: unknown): ParsedComment | 'unsupported' | null {
  const change = obj(raw);
  if (!change) return null;
  if (change.field !== 'comments') return 'unsupported';
  const value = obj(change.value);
  const commentId = igId(value?.id);
  if (!value || !commentId) return null;
  return {
    commentId,
    mediaId: igId(obj(value.media)?.id),
    fromIgsid: igId(obj(value.from)?.id),
    text: typeof value.text === 'string' ? value.text.slice(0, MAX_TEXT) : '',
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

async function storeCustomerMessage(owner: Owner, auditUserId: string,
  event: Extract<ParsedEvent, { kind: 'message' }>): Promise<void> {
  const thread = await resolveThread(owner, auditUserId, event.igsid);
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

/** Records a comment once, matches a rule and queues its private reply (one per comment, enforced by the unique key). */
async function recordComment(owner: Owner, comment: ParsedComment): Promise<void> {
  await tenant(owner.accountId, async (tx) => {
    const [event] = await tx.$queryRaw<{ id: string }[]>`
      INSERT INTO instagram_comment_events(account_id,instagram_account_id,comment_id,media_id,from_igsid)
      VALUES(${owner.accountId}::uuid,${owner.instagramAccountId}::uuid,${comment.commentId},${comment.mediaId},${comment.fromIgsid})
      ON CONFLICT DO NOTHING RETURNING id::text AS id`;
    if (!event) return;
    const rules = await tx.$queryRaw<CommentRule[]>`SELECT id::text AS id, media_id, keywords FROM instagram_comment_rules
      WHERE account_id=${owner.accountId}::uuid AND instagram_account_id=${owner.instagramAccountId}::uuid AND active
      ORDER BY created_at, id LIMIT 200`;
    // A comment without a sender id cannot get a private reply.
    const rule = comment.fromIgsid ? matchCommentRule(rules, comment) : null;
    // A contact the business blocked gets no automated DM (the private reply job checks again at send time).
    const blocked = rule ? await senderBlocked(tx, owner, comment.fromIgsid!) : false;
    await tx.$executeRaw`UPDATE instagram_comment_events SET rule_id=${rule?.id ?? null}::uuid,
      private_reply_status=${rule ? (blocked ? 'rejected' : 'queued') : 'no_rule'}
      WHERE account_id=${owner.accountId}::uuid AND id=${event.id}::uuid`;
    if (rule && !blocked) await tx.$executeRaw`INSERT INTO jobs(type,tenant_id,payload,dedupe_key)
      VALUES(${INSTAGRAM_PRIVATE_REPLY_JOB},${owner.accountId}::uuid,${JSON.stringify({ accountId: owner.accountId, eventId: event.id })}::jsonb,
        ${`igpr:${event.id}`}) ON CONFLICT(dedupe_key) DO NOTHING`;
  });
}
