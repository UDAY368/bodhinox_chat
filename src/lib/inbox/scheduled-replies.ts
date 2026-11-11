// Scheduled replies (Stage 4, batch 4D), both channels.
//
// A staff member writes a message now and picks when it goes out.
//
//   Queue before acknowledgement: createScheduledReply commits the
//   scheduled_replies row before the route answers "scheduled".
//   Sending (worker job inbox.scheduled_replies_due, per workspace with a due
//   row), one reply at a time:
//     1. claim, no network call, one transaction: lock the row (SKIP LOCKED),
//        re-check the conversation, the contact, the channel and the messaging
//        window, then either end it as 'skipped' (machine reason) or move it
//        pending -> sending (claimed_at is the lease), insert the staff message
//        row as 'sending', pause the bot, link message_id;
//     2. dispatchOnce(accountId, 'scheduled-reply:<id>') makes the one provider
//        call. The outbound intent is what stops a second send: a lease that
//        expires after a crash is claimed again, and the intent either replays
//        the accepted result or reports the outcome as uncertain;
//     3. the row becomes sent / failed (provider rejected it) / unknown
//        (ambiguous). 'unknown' is never retried or cleared automatically:
//        staff check the conversation and reconcile it.
//   Instagram: refused at schedule time beyond 7 days, outside the window that
//   will apply at that time, or after 24 hours without INSTAGRAM_HUMAN_AGENT_ENABLED;
//   re-checked at send time with the same rule (src/lib/instagram/window.ts),
//   and a reply past 24 hours carries the Human Agent tag only for this
//   staff-written message. WhatsApp: text, only inside the 24-hour window when
//   it goes out (otherwise skipped; a template is sent by hand).
// The text is staff-written and is never logged.
import { conversationVisible } from '@/lib/inbox/visibility-sql';
import { Prisma } from '@prisma/client';
import { NextResponse } from 'next/server';
import { toErrorResponse } from '@/lib/auth/account';
import { getWorkerPrisma } from '@/lib/db/prisma';
import { withTenant, type TenantContext, type TenantTransaction } from '@/lib/db/tenant';
import { databaseAdmin } from '@/lib/flows/admin-client';
import { conversationNumberDisconnected, loadAccountMetaCredentials } from '@/lib/flows/meta-send';
import { dispatchOnce, UncertainDispatchError } from '@/lib/jobs/dispatch';
import {
  ChannelUnavailableError,
  checkInstagramText,
  loadInstagramTarget,
  sendInstagramText,
  type InstagramSendContext,
  type InstagramTarget,
} from '@/lib/channels/sender';
import { manualRepliesBlockedIn } from '@/lib/platform/lifecycle';
import { instagramConfig } from '@/lib/instagram/config';
import { InstagramError } from '@/lib/instagram/errors';
import { INSTAGRAM_LIMITS, utf8Bytes } from '@/lib/instagram/graph-limits';
import { instagramWindow, STANDARD_WINDOW_MS } from '@/lib/instagram/window';
import { isRecipientNotAllowedError, phoneVariants } from '@/lib/whatsapp/phone-utils';
import { resolveContactSendTarget } from '@/lib/whatsapp/wa-identity';
import { sendTextMessage } from '@/lib/whatsapp/meta-api';
import { getSessionWindow } from '@/lib/inbox/session';
import {
  SCHEDULED_REPLY_LIMITS,
  type Channel,
  type ScheduledReply,
  type ScheduledReplyReason,
} from '@/types';

import { SCHEDULED_REPLIES_JOB } from './follow-up-jobs';
import { pauseForAgentReply } from './automation-pause';
export { SCHEDULED_REPLIES_JOB };
export const SCHEDULED_REPLY_WRITE_LIMIT = { limit: 30, windowMs: 60_000 };
/** A claimed reply whose worker vanished is taken again after this long (the intent still prevents a second send). */
export const SCHEDULED_REPLY_LEASE_MS = 10 * 60_000;
/** Replies sent per job run; the next run continues. */
const RUN_BATCH = 25;
/** A reply claimed this many times without finishing is surfaced as unknown instead of tried again. */
const MAX_ATTEMPTS = 5;
const DAY_MS = 24 * 60 * 60 * 1000;
const PAST_SLACK_MS = 5_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Codes match Inbox.scheduled.errors.* (plus invalid_request); the client maps them to text. */
export type ScheduledReplyErrorCode =
  | 'past' | 'tooFarWhatsapp' | 'tooFarInstagram' | 'windowClosed' | 'humanAgentOff' | 'empty'
  | 'tooLongInstagram' | 'tooLong' | 'notFound' | 'notPending' | 'invalid_request';

export class ScheduledReplyError extends Error {
  constructor(readonly code: ScheduledReplyErrorCode, readonly status: 400 | 404 | 409) {
    super(code);
    this.name = 'ScheduledReplyError';
  }
}

export const scheduledReplyHeaders = { 'Cache-Control': 'private, no-store' };

export function scheduledReplyErrorResponse(error: unknown): NextResponse {
  if (error instanceof ScheduledReplyError)
    return NextResponse.json({ error: error.code, code: error.code }, { status: error.status, headers: scheduledReplyHeaders });
  if (error instanceof InstagramError)
    return NextResponse.json({ error: error.code, code: error.code }, { status: error.status, headers: scheduledReplyHeaders });
  // RLS refused the write (a viewer, or a session whose role changed).
  const code = (error as { code?: string; meta?: { code?: string } } | null)?.meta?.code ?? (error as { code?: string } | null)?.code;
  if (code === '42501') return NextResponse.json({ error: 'forbidden', code: 'forbidden' }, { status: 403, headers: scheduledReplyHeaders });
  return toErrorResponse(error);
}

type Member = TenantContext & { userId: string };
function member(ctx: TenantContext): Member {
  if (!ctx.userId) throw new Error('A member identity is required');
  return ctx as Member;
}
const invalid = () => new ScheduledReplyError('invalid_request', 400);

// ------------------------------------------------------------------ input

function parseSendAt(value: unknown, now: Date): Date {
  if (typeof value !== 'string') throw invalid();
  const at = new Date(value);
  if (Number.isNaN(at.getTime())) throw invalid();
  if (at.getTime() <= now.getTime() + PAST_SLACK_MS) throw new ScheduledReplyError('past', 400);
  return at;
}

function parseContent(value: unknown): string {
  if (typeof value !== 'string') throw invalid();
  const content = value.trim();
  if (!content) throw new ScheduledReplyError('empty', 400);
  if (content.length > SCHEDULED_REPLY_LIMITS.contentChars) throw new ScheduledReplyError('tooLong', 400);
  return content;
}

export function parseScheduleCreate(body: unknown, now: Date = new Date()): { conversationId: string; content: string; sendAt: Date } {
  const input = body && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
  if (!input || typeof input.conversation_id !== 'string' || !UUID.test(input.conversation_id)) throw invalid();
  return { conversationId: input.conversation_id, content: parseContent(input.content), sendAt: parseSendAt(input.send_at, now) };
}

export type ScheduledReplyPatch =
  | { kind: 'edit'; content?: string; sendAt?: Date }
  | { kind: 'cancel' }
  | { kind: 'reconcile'; outcome: 'sent' | 'failed' };

export function parseScheduledReplyPatch(body: unknown, now: Date = new Date()): ScheduledReplyPatch {
  const input = body && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
  if (!input) throw invalid();
  if (input.status === 'cancelled' && Object.keys(input).length === 1) return { kind: 'cancel' };
  if ('reconcile' in input) {
    if ((input.reconcile !== 'sent' && input.reconcile !== 'failed') || Object.keys(input).length !== 1) throw invalid();
    return { kind: 'reconcile', outcome: input.reconcile };
  }
  const edit: { kind: 'edit'; content?: string; sendAt?: Date } = { kind: 'edit' };
  if ('content' in input) edit.content = parseContent(input.content);
  if ('send_at' in input) edit.sendAt = parseSendAt(input.send_at, now);
  if (edit.content === undefined && edit.sendAt === undefined) throw invalid();
  return edit;
}

// -------------------------------------------------------------- schedule

const COLUMNS = Prisma.raw(`id::text AS id, conversation_id::text AS conversation_id, channel, created_by_user_id::text AS created_by_user_id,
  content, send_at, status, attempts, message_id::text AS message_id, sent_at, reason_code, created_at, updated_at`);
type Row = Omit<ScheduledReply, 'send_at' | 'sent_at' | 'created_at' | 'updated_at'> & {
  send_at: Date; sent_at: Date | null; created_at: Date; updated_at: Date;
};
const toDto = (row: Row): ScheduledReply => ({
  ...row,
  send_at: row.send_at.toISOString(),
  sent_at: row.sent_at ? row.sent_at.toISOString() : null,
  created_at: row.created_at.toISOString(),
  updated_at: row.updated_at.toISOString(),
});

const workerTenant = <T>(accountId: string, work: (tx: TenantTransaction) => Promise<T>) =>
  withTenant({ accountId, role: 'owner' }, work, getWorkerPrisma());

/**
 * The limits that depend on the channel and the time. Throws a ScheduledReplyError
 * (or an InstagramError for a channel that cannot send at all); nothing is stored
 * by a refusal. `target` is the Instagram send target (read by the worker role).
 */
function assertSchedulable(channel: Channel, content: string, sendAt: Date, now: Date, target: InstagramTarget | null, createdAt: Date = now): void {
  // The table caps send_at against the row's created_at, which an edit does not move.
  const ahead = sendAt.getTime() - Math.min(createdAt.getTime(), now.getTime());
  // The table allows 30 / 7 days from its own clock; stay a minute inside it.
  if (channel === 'whatsapp') {
    if (ahead > SCHEDULED_REPLY_LIMITS.maxDaysAhead.whatsapp * DAY_MS - 60_000) throw new ScheduledReplyError('tooFarWhatsapp', 400);
    return;
  }
  if (ahead > SCHEDULED_REPLY_LIMITS.maxDaysAhead.instagram * DAY_MS - 60_000) throw new ScheduledReplyError('tooFarInstagram', 400);
  if (utf8Bytes(content) > INSTAGRAM_LIMITS.textBytes) throw new ScheduledReplyError('tooLongInstagram', 400);
  const config = instagramConfig();
  if (!config || !target) throw new InstagramError('instagram_not_enabled');
  // The window as it will be when the reply goes out (the customer may write again before then; send time re-checks).
  const at = instagramWindow({
    lastCustomerAt: target.lastCustomerAt, sender: 'staff', humanAgentEnabled: config.humanAgentEnabled,
    adReferralAt: target.adReferralAt, ctdEnabled: config.ctdWindowEnabled, now: sendAt,
  });
  if (at.allowed) return;
  const withTag = instagramWindow({
    lastCustomerAt: target.lastCustomerAt, sender: 'staff', humanAgentEnabled: true,
    adReferralAt: target.adReferralAt, ctdEnabled: config.ctdWindowEnabled, now: sendAt,
  });
  throw new ScheduledReplyError(withTag.allowed ? 'humanAgentOff' : 'windowClosed', 409);
}

/** The conversation's channel as this member sees it (RLS), or not-found. */
async function conversationChannel(me: Member, conversationId: string): Promise<Channel> {
  const rows = await withTenant(me, (tx) => tx.$queryRaw<{ channel: string }[]>`
    SELECT channel FROM conversations WHERE account_id=${me.accountId}::uuid AND id=${conversationId}::uuid
      AND ${conversationVisible('conversations')}`);
  if (!rows.length) throw new ScheduledReplyError('notFound', 404);
  return rows[0].channel === 'instagram' ? 'instagram' : 'whatsapp';
}

async function instagramTargetFor(accountId: string, conversationId: string): Promise<InstagramTarget> {
  return workerTenant(accountId, (tx) => loadInstagramTarget(tx, accountId, conversationId));
}

export async function createScheduledReply(ctx: TenantContext, input: { conversationId: string; content: string; sendAt: Date },
  now: Date = new Date()): Promise<ScheduledReply> {
  const me = member(ctx);
  const channel = await conversationChannel(me, input.conversationId);
  const target = channel === 'instagram' ? await instagramTargetFor(me.accountId, input.conversationId) : null;
  assertSchedulable(channel, input.content, input.sendAt, now, target);
  // The row commits before the caller is told "scheduled". The channel is stamped from the conversation
  // (a trigger refuses any other); created_at stays the database's.
  return withTenant(me, async (tx) => {
    const [row] = await tx.$queryRaw<Row[]>(Prisma.sql`
      INSERT INTO scheduled_replies(account_id, conversation_id, channel, created_by_user_id, content, send_at)
      VALUES(${me.accountId}::uuid, ${input.conversationId}::uuid, ${channel}, ${me.userId}::uuid, ${input.content}, ${input.sendAt})
      RETURNING ${COLUMNS}`);
    return toDto(row);
  });
}

/** The conversation's scheduled replies that still matter (pending, sending, needing a check, or ended badly in the last week). */
export async function listScheduledReplies(ctx: TenantContext, conversationId: string): Promise<ScheduledReply[]> {
  const me = member(ctx);
  if (!UUID.test(conversationId)) throw invalid();
  const rows = await withTenant(me, (tx) => tx.$queryRaw<Row[]>(Prisma.sql`
    SELECT ${COLUMNS} FROM scheduled_replies
    WHERE account_id=${me.accountId}::uuid AND conversation_id=${conversationId}::uuid
      AND (status IN ('pending','sending','unknown') OR (status IN ('failed','skipped') AND updated_at > now() - interval '7 days'))
    ORDER BY send_at, id LIMIT 100`));
  return rows.map(toDto);
}

async function loadOwnRow(me: Member, id: string): Promise<{ status: string; channel: Channel; conversation_id: string; content: string; send_at: Date; created_at?: Date }> {
  const rows = await withTenant(me, (tx) => tx.$queryRaw<{ status: string; channel: Channel; conversation_id: string; content: string; send_at: Date; created_at?: Date }[]>`
    SELECT status, channel, conversation_id::text AS conversation_id, content, send_at, created_at FROM scheduled_replies
    WHERE account_id=${me.accountId}::uuid AND id=${id}::uuid`);
  if (!rows.length) throw new ScheduledReplyError('notFound', 404);
  return rows[0];
}

/** Change the text or time, or cancel, while pending. The creator or an admin (RLS); anyone else gets not-found. */
export async function updateScheduledReply(ctx: TenantContext, id: string, patch: Extract<ScheduledReplyPatch, { kind: 'edit' | 'cancel' }>,
  now: Date = new Date()): Promise<ScheduledReply> {
  const me = member(ctx);
  if (!UUID.test(id)) throw new ScheduledReplyError('notFound', 404);
  const current = await loadOwnRow(me, id);
  if (current.status !== 'pending') throw new ScheduledReplyError('notPending', 409);
  if (patch.kind === 'edit') {
    const content = patch.content ?? current.content;
    const sendAt = patch.sendAt ?? current.send_at;
    const target = current.channel === 'instagram' ? await instagramTargetFor(me.accountId, current.conversation_id) : null;
    assertSchedulable(current.channel, content, sendAt, now, target, current.created_at instanceof Date ? current.created_at : now);
  }
  const rows = await withTenant(me, (tx) => tx.$queryRaw<Row[]>(Prisma.sql`
    UPDATE scheduled_replies SET
      content = COALESCE(${patch.kind === 'edit' ? patch.content ?? null : null}::text, content),
      send_at = COALESCE(${patch.kind === 'edit' ? patch.sendAt ?? null : null}::timestamptz, send_at),
      status = ${patch.kind === 'cancel' ? 'cancelled' : 'pending'}
    WHERE account_id=${me.accountId}::uuid AND id=${id}::uuid AND status='pending'
    RETURNING ${COLUMNS}`));
  // RLS hid it (not the creator) or the worker claimed it a moment ago.
  if (!rows.length) throw new ScheduledReplyError('notPending', 409);
  return toDto(rows[0]);
}

/**
 * Staff say what happened to a reply whose outcome was ambiguous ('unknown'):
 * it was sent or it was not. Never re-sends. The app role cannot make this
 * change (it only edits pending rows), so it runs on the worker connection,
 * after the member's own read proved the row is theirs to see.
 */
export async function reconcileScheduledReply(ctx: TenantContext, id: string, outcome: 'sent' | 'failed'): Promise<ScheduledReply> {
  const me = member(ctx);
  if (!UUID.test(id)) throw new ScheduledReplyError('notFound', 404);
  const current = await loadOwnRow(me, id);
  if (current.status !== 'unknown') throw new ScheduledReplyError('notPending', 409);
  return workerTenant(me.accountId, async (tx) => {
    const rows = await tx.$queryRaw<Row[]>(Prisma.sql`
      UPDATE scheduled_replies SET status=${outcome},
        sent_at = CASE WHEN ${outcome} = 'sent' THEN now() ELSE sent_at END,
        reason_code = CASE WHEN ${outcome} = 'failed' THEN 'send_failed' ELSE reason_code END
      WHERE account_id=${me.accountId}::uuid AND id=${id}::uuid AND status='unknown'
      RETURNING ${COLUMNS}`);
    if (!rows.length) throw new ScheduledReplyError('notPending', 409);
    if (rows[0].message_id)
      await tx.$executeRaw`UPDATE messages SET status=${outcome} WHERE account_id=${me.accountId}::uuid
        AND id=${rows[0].message_id}::uuid AND status='unknown'`;
    return toDto(rows[0]);
  });
}

// ----------------------------------------------------------------- worker

interface Claimed {
  id: string;
  accountId: string;
  conversationId: string;
  contactId: string;
  channel: Channel;
  content: string;
  messageRowId: string;
  userId: string | null;
  ctx: InstagramSendContext;
  instagram: InstagramTarget | null;
  whatsapp: { contact: { phone: string | null; wa_user_id: string | null } } | null;
}

type Claim = { kind: 'none' } | { kind: 'ended' } | { kind: 'send'; claimed: Claimed };

interface DueRow {
  id: string; conversation_id: string; channel: string; created_by_user_id: string | null; content: string;
  status: 'pending' | 'sending'; message_id: string | null; attempts: number;
  conv_status: string; contact_id: string; blocked_at: Date | null; phone: string | null; wa_user_id: string | null;
  last_customer_at: Date | null; send_at: Date;
}

/** The IG refusal as a skip reason. */
function instagramSkipReason(error: unknown, target: InstagramTarget | null, now: Date): ScheduledReplyReason {
  if (error instanceof InstagramError) {
    if (error.code === 'instagram_window_closed') {
      const config = instagramConfig();
      const past24h = target?.lastCustomerAt ? now.getTime() - target.lastCustomerAt.getTime() >= STANDARD_WINDOW_MS : false;
      return config && !config.humanAgentEnabled && past24h ? 'human_agent_off' : 'window_closed';
    }
    if (error.code === 'invalid_request') return 'send_failed';
    return 'channel_off';
  }
  if (error instanceof ChannelUnavailableError) return 'send_failed';
  throw error;
}

async function skip(tx: TenantTransaction, accountId: string, id: string, reason: ScheduledReplyReason): Promise<Claim> {
  await tx.$executeRaw`UPDATE scheduled_replies SET status='skipped', reason_code=${reason}
    WHERE account_id=${accountId}::uuid AND id=${id}::uuid AND status='pending'`;
  return { kind: 'ended' };
}

/** Steps 1 of the header: no network call; either an end state or a claimed reply to send. */
async function claimNext(accountId: string, now: Date): Promise<Claim> {
  const lease = new Date(now.getTime() - SCHEDULED_REPLY_LEASE_MS);
  return workerTenant(accountId, async (tx) => {
    const [row] = await tx.$queryRaw<DueRow[]>(Prisma.sql`
      SELECT s.id::text AS id, s.conversation_id::text AS conversation_id, s.channel, s.created_by_user_id::text AS created_by_user_id,
        s.content, s.status, s.message_id::text AS message_id, s.attempts, s.send_at,
        c.status AS conv_status, c.contact_id::text AS contact_id, ct.blocked_at, ct.phone, ct.wa_user_id,
        (SELECT max(m.created_at) FROM messages m WHERE m.account_id=c.account_id AND m.conversation_id=c.id
           AND m.sender_type='customer') AS last_customer_at
      FROM scheduled_replies s
      JOIN conversations c ON c.account_id=s.account_id AND c.id=s.conversation_id
      JOIN contacts ct ON ct.account_id=c.account_id AND ct.id=c.contact_id
      WHERE s.account_id=${accountId}::uuid
        AND ((s.status='pending' AND s.send_at <= ${now}) OR (s.status='sending' AND s.claimed_at < ${lease}))
      ORDER BY s.send_at, s.id LIMIT 1 FOR UPDATE OF s SKIP LOCKED`);
    if (!row) return { kind: 'none' };
    const channel: Channel = row.channel === 'instagram' ? 'instagram' : 'whatsapp';
    const ctx: InstagramSendContext = { sender: 'staff', now };

    // A reply claimed too many times without finishing is surfaced for a person, never tried again.
    if (row.status === 'sending' && row.attempts >= MAX_ATTEMPTS) {
      await tx.$executeRaw`UPDATE scheduled_replies SET status='unknown', claimed_at=${now}
        WHERE account_id=${accountId}::uuid AND id=${row.id}::uuid AND status='sending'`;
      if (row.message_id)
        await tx.$executeRaw`UPDATE messages SET status='unknown' WHERE account_id=${accountId}::uuid AND id=${row.message_id}::uuid AND status='sending'`;
      return { kind: 'ended' };
    }

    let instagram: InstagramTarget | null = null;
    if (row.status === 'pending') {
      if (row.conv_status === 'closed') return skip(tx, accountId, row.id, 'conversation_closed');
      if (row.blocked_at) return skip(tx, accountId, row.id, 'channel_off');
      // A platform admin's block on manual replies (abuse) also covers a reply written earlier and sent later.
      if (await manualRepliesBlockedIn(tx, accountId)) return skip(tx, accountId, row.id, 'channel_off');
      if (channel === 'whatsapp') {
        if (await conversationNumberDisconnected(databaseAdmin(), accountId, row.conversation_id).catch(() => true))
          return skip(tx, accountId, row.id, 'channel_off');
        if (!getSessionWindow(row.last_customer_at ? row.last_customer_at.toISOString() : null, now.getTime()).active)
          return skip(tx, accountId, row.id, 'window_closed');
      } else {
        try {
          instagram = await loadInstagramTarget(tx, accountId, row.conversation_id);
          checkInstagramText(instagram, row.content, ctx);
        } catch (error) {
          return skip(tx, accountId, row.id, instagramSkipReason(error, instagram, now));
        }
      }
    } else if (channel === 'instagram') {
      // A recovered claim: the window was proven when it was first claimed and the intent decides the rest;
      // only the target is needed. If it cannot be loaded now, leave the claim to expire and be surfaced.
      try { instagram = await loadInstagramTarget(tx, accountId, row.conversation_id); } catch { return { kind: 'ended' }; }
    }

    // Claim: the lease starts now. The staff message row exists from here, so the thread shows it as sending.
    let messageRowId = row.message_id;
    if (!messageRowId) {
      const [message] = await tx.$queryRaw<{ id: string }[]>`INSERT INTO messages(account_id,conversation_id,sender_type,sender_id,
          content_type,content_text,status)
        VALUES(${accountId}::uuid,${row.conversation_id}::uuid,'agent',${row.created_by_user_id}::uuid,'text',${row.content},'sending')
        RETURNING id::text AS id`;
      messageRowId = message.id;
    }
    await tx.$executeRaw`UPDATE scheduled_replies SET status='sending', claimed_at=${now}, attempts=attempts+1, message_id=${messageRowId}::uuid
      WHERE account_id=${accountId}::uuid AND id=${row.id}::uuid AND status IN ('pending','sending')`;
    // The staff member stepping in: automated replies pause before the send, as on the composer.
    // Stage 5: for the workspace's agent_reply_pause_minutes, or until resumed when unset.
    await pauseForAgentReply(tx, accountId, row.conversation_id, row.created_by_user_id);
    return {
      kind: 'send',
      claimed: {
        id: row.id, accountId, conversationId: row.conversation_id, contactId: row.contact_id, channel,
        content: row.content, messageRowId, userId: row.created_by_user_id, ctx, instagram,
        whatsapp: channel === 'whatsapp' ? { contact: { phone: row.phone, wa_user_id: row.wa_user_id } } : null,
      },
    };
  });
}

/**
 * Everything the provider call needs, resolved before dispatchOnce (so a local
 * problem never leaves an intent behind); returns the one call to make inside it.
 * WhatsApp tries the phone's trunk-prefix variants like every other WhatsApp send.
 */
async function prepareSend(c: Claimed): Promise<() => Promise<{ messageId: string }>> {
  if (c.channel === 'instagram') {
    const target = c.instagram as InstagramTarget;
    return async () => ({ messageId: (await sendInstagramText(target, c.content, c.ctx)).messageId });
  }
  const target = resolveContactSendTarget(c.whatsapp!.contact);
  if (!target) throw new Error('No WhatsApp address');
  const { phoneNumberId, accessToken } = await loadAccountMetaCredentials(databaseAdmin(), c.accountId, c.conversationId);
  const variants = target.isPhone ? phoneVariants(target.target) : [target.target];
  return async () => {
    let lastError: unknown = null;
    for (const to of variants) {
      try {
        const sent = await sendTextMessage({ phoneNumberId, accessToken, to, text: c.content });
        return { messageId: sent.messageId };
      } catch (error) {
        // "Recipient not allowed" was refused before delivery, so the next spelling is safe to try.
        if (!isRecipientNotAllowedError(error instanceof Error ? error.message : String(error))) throw error;
        lastError = error;
      }
    }
    throw lastError;
  };
}

/** True when a send intent for this reply exists, i.e. an earlier attempt may have reached the provider. */
async function intentExists(accountId: string, id: string): Promise<boolean> {
  const rows = await workerTenant(accountId, (tx) => tx.$queryRaw<{ n: number }[]>`
    SELECT 1 AS n FROM outbound_intents WHERE account_id=${accountId}::uuid AND idempotency_key=${`${accountId}:scheduled-reply:${id}`}`);
  return rows.length > 0;
}

async function settle(c: Claimed, outcome: { status: 'sent'; messageId: string } | { status: 'failed' | 'unknown' }): Promise<void> {
  await workerTenant(c.accountId, async (tx) => {
    if (outcome.status === 'sent') {
      // If the echo of this send was processed first it stored the same mid as an external-echo row; keep this row.
      await tx.$executeRaw`DELETE FROM messages WHERE account_id=${c.accountId}::uuid AND conversation_id=${c.conversationId}::uuid
        AND message_id=${outcome.messageId} AND id<>${c.messageRowId}::uuid AND sender_type='agent'
        AND interactive_payload->'ig'->>'external_echo'='true'`;
      await tx.$executeRaw`UPDATE messages SET status='sent', message_id=${outcome.messageId}
        WHERE account_id=${c.accountId}::uuid AND id=${c.messageRowId}::uuid AND status='sending'`;
      await tx.$executeRaw`UPDATE scheduled_replies SET status='sent', sent_at=now()
        WHERE account_id=${c.accountId}::uuid AND id=${c.id}::uuid AND status='sending'`;
      await tx.$executeRaw`UPDATE conversations SET last_message_text=${c.content}, last_message_at=now(), updated_at=now()
        WHERE account_id=${c.accountId}::uuid AND id=${c.conversationId}::uuid`;
      // The active flow run yields to the staff member, as for a composer send.
      await tx.$executeRaw`UPDATE flow_runs SET status='paused_by_agent', ended_at=now(), end_reason='agent_replied'
        WHERE account_id=${c.accountId}::uuid AND contact_id=${c.contactId}::uuid
          AND conversation_id=${c.conversationId}::uuid AND status='active'`;
      return;
    }
    await tx.$executeRaw`UPDATE messages SET status=${outcome.status}
      WHERE account_id=${c.accountId}::uuid AND id=${c.messageRowId}::uuid AND status='sending'`;
    await tx.$executeRaw`UPDATE scheduled_replies SET status=${outcome.status},
        reason_code = CASE WHEN ${outcome.status} = 'failed' THEN 'send_failed' ELSE reason_code END
      WHERE account_id=${c.accountId}::uuid AND id=${c.id}::uuid AND status='sending'`;
  });
}

/**
 * Worker: sends this workspace's due scheduled replies, one at a time, at most
 * RUN_BATCH per run. Returns how many reached a provider outcome or an end state.
 * Only machine reasons are recorded; nothing about the text is logged.
 */
export async function runScheduledReplies(accountId: string, now: Date = new Date()): Promise<number> {
  let handled = 0;
  for (let i = 0; i < RUN_BATCH; i += 1) {
    const claim = await claimNext(accountId, now);
    if (claim.kind === 'none') break;
    handled += 1;
    if (claim.kind === 'ended') continue;
    const c = claim.claimed;
    let send: () => Promise<{ messageId: string }>;
    try {
      send = await prepareSend(c);
    } catch (error) {
      // Nothing was sent by this attempt; an earlier attempt that left an intent behind may have, so that one is unknown.
      console.error('[scheduled reply] not sent', { error: error instanceof Error ? error.name : 'unknown' });
      await settle(c, { status: (await intentExists(accountId, c.id)) ? 'unknown' : 'failed' });
      continue;
    }
    try {
      const sent = await dispatchOnce(accountId, `scheduled-reply:${c.id}`, send);
      await settle(c, { status: 'sent', messageId: sent.messageId });
    } catch (error) {
      if (error instanceof UncertainDispatchError) await settle(c, { status: 'unknown' });
      else {
        // The provider (or a local check) refused it before anything was delivered.
        console.error('[scheduled reply] send failed', { error: error instanceof Error ? error.name : 'unknown' });
        await settle(c, { status: 'failed' });
      }
    }
  }
  return handled;
}
