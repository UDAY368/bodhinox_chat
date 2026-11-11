// Conversation reminders and snoozes (Stage 4, batch 4D), both channels.
//
// A reminder tells its owner to look at a conversation again at a time; a
// snooze is the same row with kind 'snooze' and also hides the conversation
// from the owner's open list until then. The rows are personal: every member
// query below runs inside withTenant as the live member and filters on
// user_id as well as RLS, so another member's reminder is a not-found.
// The worker (inbox.reminders_due, per workspace with a due row) marks due
// reminders fired and creates the in-app notification in the SAME transaction,
// so a reminder is either fired and notified or neither (the dedupe key also
// makes a repeat harmless). The note is staff text: stored, never logged.
import { conversationVisible } from '@/lib/inbox/visibility-sql';
import { Prisma } from '@prisma/client';
import { NextResponse } from 'next/server';
import { toErrorResponse } from '@/lib/auth/account';
import { getWorkerPrisma } from '@/lib/db/prisma';
import { withTenant, type TenantContext } from '@/lib/db/tenant';
import { getT } from '@/lib/i18n/translate';
import { conversationLink } from '@/lib/notifications/emit';
import { createNotification } from './notify';
import {
  CONVERSATION_REMINDER_KINDS,
  CONVERSATION_REMINDER_LIMITS,
  type ConversationReminder,
  type ConversationReminderKind,
} from '@/types';

import { REMINDERS_JOB } from './follow-up-jobs';
export { REMINDERS_JOB };
export const REMINDER_WRITE_LIMIT = { limit: 60, windowMs: 60_000 };
const DAY_MS = 24 * 60 * 60 * 1000;
/** Time the client and server clocks may disagree about "now". */
const PAST_SLACK_MS = 5_000;
/** Reminders fired per job run; a larger backlog continues on the next run. */
const FIRE_BATCH = 200;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Codes match Inbox.reminders.errors.* (plus invalid_request); the client maps them to text. */
export type ReminderErrorCode = 'past' | 'tooFar' | 'notFound' | 'invalid_request';

export class ReminderError extends Error {
  constructor(readonly code: ReminderErrorCode, readonly status: 400 | 404) {
    super(code);
    this.name = 'ReminderError';
  }
}

export const reminderHeaders = { 'Cache-Control': 'private, no-store' };

export function reminderErrorResponse(error: unknown): NextResponse {
  if (error instanceof ReminderError)
    return NextResponse.json({ error: error.code, code: error.code }, { status: error.status, headers: reminderHeaders });
  // RLS refused the write (a viewer, or a session whose role changed).
  const code = (error as { code?: string; meta?: { code?: string } } | null)?.meta?.code ?? (error as { code?: string } | null)?.code;
  if (code === '42501') return NextResponse.json({ error: 'forbidden', code: 'forbidden' }, { status: 403, headers: reminderHeaders });
  return toErrorResponse(error);
}

type Member = TenantContext & { userId: string };
function member(ctx: TenantContext): Member {
  if (!ctx.userId) throw new Error('A member identity is required');
  return ctx as Member;
}

const invalid = () => new ReminderError('invalid_request', 400);

function parseRemindAt(value: unknown, now: Date): Date {
  if (typeof value !== 'string') throw invalid();
  const at = new Date(value);
  if (Number.isNaN(at.getTime())) throw invalid();
  if (at.getTime() <= now.getTime() + PAST_SLACK_MS) throw new ReminderError('past', 400);
  // The table allows 366 days from its own clock; stay a minute inside it.
  if (at.getTime() > now.getTime() + CONVERSATION_REMINDER_LIMITS.maxDaysAhead * DAY_MS - 60_000) throw new ReminderError('tooFar', 400);
  return at;
}

function parseNote(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw invalid();
  const note = value.trim();
  if (note.length > CONVERSATION_REMINDER_LIMITS.noteChars) throw invalid();
  return note || null;
}

export interface ReminderCreate { conversationId: string; kind: ConversationReminderKind; remindAt: Date; note: string | null }

export function parseReminderCreate(body: unknown, now: Date = new Date()): ReminderCreate {
  const input = body && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
  if (!input) throw invalid();
  if (typeof input.conversation_id !== 'string' || !UUID.test(input.conversation_id)) throw invalid();
  const kind = input.kind === undefined ? 'reminder' : input.kind;
  if (!(CONVERSATION_REMINDER_KINDS as readonly unknown[]).includes(kind)) throw invalid();
  return {
    conversationId: input.conversation_id,
    kind: kind as ConversationReminderKind,
    remindAt: parseRemindAt(input.remind_at, now),
    note: parseNote(input.note),
  };
}

export interface ReminderPatch { status?: 'dismissed' | 'cancelled'; remindAt?: Date; note?: string | null }

export function parseReminderPatch(body: unknown, now: Date = new Date()): ReminderPatch {
  const input = body && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
  if (!input) throw invalid();
  const patch: ReminderPatch = {};
  if ('status' in input) {
    if (input.status !== 'dismissed' && input.status !== 'cancelled') throw invalid();
    patch.status = input.status;
  }
  if ('remind_at' in input) patch.remindAt = parseRemindAt(input.remind_at, now);
  if ('note' in input) patch.note = parseNote(input.note);
  if (Object.keys(patch).length === 0) throw invalid();
  // A status change is its own request: it cannot also move a time that is about to be fixed.
  if (patch.status && (patch.remindAt || 'note' in patch)) throw invalid();
  return patch;
}

const COLUMNS = Prisma.raw(`id::text AS id, conversation_id::text AS conversation_id, user_id::text AS user_id, kind, remind_at, note, status, fired_at, created_at, updated_at`);
type Row = Omit<ConversationReminder, 'remind_at' | 'fired_at' | 'created_at' | 'updated_at'> & {
  remind_at: Date; fired_at: Date | null; created_at: Date; updated_at: Date;
};
const toDto = (row: Row): ConversationReminder => ({
  ...row,
  remind_at: row.remind_at.toISOString(),
  fired_at: row.fired_at ? row.fired_at.toISOString() : null,
  created_at: row.created_at.toISOString(),
  updated_at: row.updated_at.toISOString(),
});

/** The caller's own reminders: pending and fired by default, newest due first. */
export async function listReminders(ctx: TenantContext, filter: { conversationId?: string | null; kind?: string | null; status?: string | null } = {}): Promise<ConversationReminder[]> {
  const me = member(ctx);
  if (filter.conversationId && !UUID.test(filter.conversationId)) throw invalid();
  if (filter.kind && !(CONVERSATION_REMINDER_KINDS as readonly string[]).includes(filter.kind)) throw invalid();
  const statuses = filter.status ? [filter.status] : ['pending', 'fired'];
  if (!statuses.every((s) => ['pending', 'fired', 'dismissed', 'cancelled'].includes(s))) throw invalid();
  const rows = await withTenant(me, (tx) => tx.$queryRaw<Row[]>(Prisma.sql`
    SELECT ${COLUMNS} FROM conversation_reminders
    WHERE account_id=${me.accountId}::uuid AND user_id=${me.userId}::uuid AND status = ANY(${statuses}::text[])
      AND (${filter.conversationId ?? null}::uuid IS NULL OR conversation_id=${filter.conversationId ?? null}::uuid)
      AND (${filter.kind ?? null}::text IS NULL OR kind=${filter.kind ?? null})
    ORDER BY remind_at ASC, id LIMIT 200`));
  return rows.map(toDto);
}

export async function createReminder(ctx: TenantContext, input: ReminderCreate): Promise<ConversationReminder> {
  const me = member(ctx);
  return withTenant(me, async (tx) => {
    // The conversation must be one this member can read (RLS), in this workspace.
    const seen = await tx.$queryRaw<{ id: string }[]>`SELECT id::text AS id FROM conversations
      WHERE account_id=${me.accountId}::uuid AND id=${input.conversationId}::uuid AND ${conversationVisible('conversations')}`;
    if (!seen.length) throw new ReminderError('notFound', 404);
    // One pending snooze per conversation and person: a new one replaces the old.
    if (input.kind === 'snooze')
      await tx.$executeRaw`UPDATE conversation_reminders SET status='cancelled'
        WHERE account_id=${me.accountId}::uuid AND user_id=${me.userId}::uuid
          AND conversation_id=${input.conversationId}::uuid AND kind='snooze' AND status='pending'`;
    const [row] = await tx.$queryRaw<Row[]>(Prisma.sql`
      INSERT INTO conversation_reminders(account_id, conversation_id, user_id, kind, remind_at, note)
      VALUES(${me.accountId}::uuid,${input.conversationId}::uuid,${me.userId}::uuid,${input.kind},${input.remindAt},${input.note})
      RETURNING ${COLUMNS}`);
    return toDto(row);
  });
}

/** Only the owner's own row: another member's id (or another workspace's) is a not-found. */
export async function updateReminder(ctx: TenantContext, id: string, patch: ReminderPatch): Promise<ConversationReminder> {
  const me = member(ctx);
  if (!UUID.test(id)) throw new ReminderError('notFound', 404);
  return withTenant(me, async (tx) => {
    // The table caps remind_at against the row's own created_at, which an edit does not move.
    if (patch.remindAt) {
      const own = await tx.$queryRaw<{ created_at: Date }[]>`SELECT created_at FROM conversation_reminders
        WHERE account_id=${me.accountId}::uuid AND user_id=${me.userId}::uuid AND id=${id}::uuid`;
      if (own[0] && patch.remindAt.getTime() > own[0].created_at.getTime() + CONVERSATION_REMINDER_LIMITS.maxDaysAhead * DAY_MS - 60_000)
        throw new ReminderError('tooFar', 400);
    }
    // dismissed: pending or fired; cancelled and edits: pending only (the guard trigger holds the same rules).
    const allowed = patch.status === 'dismissed' ? ['pending', 'fired'] : ['pending'];
    const rows = await tx.$queryRaw<Row[]>(Prisma.sql`
      UPDATE conversation_reminders SET
        status = COALESCE(${patch.status ?? null}::text, status),
        remind_at = COALESCE(${patch.remindAt ?? null}::timestamptz, remind_at),
        note = CASE WHEN ${'note' in patch}::boolean THEN ${patch.note ?? null}::text ELSE note END
      WHERE account_id=${me.accountId}::uuid AND user_id=${me.userId}::uuid AND id=${id}::uuid AND status = ANY(${allowed}::text[])
      RETURNING ${COLUMNS}`);
    if (!rows.length) throw new ReminderError('notFound', 404);
    return toDto(rows[0]);
  });
}

/**
 * Worker: fires this workspace's due reminders. The status change and the
 * notification share one transaction; the dedupe key makes a repeat a no-op.
 * Returns how many fired. Titles are fixed text; the note is not copied into
 * the notification and nothing here is logged.
 */
export async function runDueReminders(accountId: string): Promise<number> {
  const t = getT('Inbox.reminders.notification');
  return withTenant({ accountId, role: 'owner' }, async (tx) => {
    const fired = await tx.$queryRaw<{ id: string; user_id: string; conversation_id: string }[]>`
      UPDATE conversation_reminders SET status='fired', fired_at=now()
      WHERE account_id=${accountId}::uuid AND id IN (
        SELECT id FROM conversation_reminders
        WHERE account_id=${accountId}::uuid AND status='pending' AND remind_at <= now()
        ORDER BY remind_at, id LIMIT ${FIRE_BATCH} FOR UPDATE SKIP LOCKED)
      RETURNING id::text AS id, user_id::text AS user_id, conversation_id::text AS conversation_id`;
    for (const reminder of fired)
      await createNotification(tx, {
        accountId,
        userIds: [reminder.user_id],
        // No reminder event exists (that would widen the notification checks); a reminder is a team notice.
        event: 'automation_notice',
        title: t('title'),
        body: t('body'),
        link: conversationLink(reminder.conversation_id),
        dedupeKey: `reminder:${reminder.id}`,
        conversationId: reminder.conversation_id,
      });
    return fired.length;
  }, getWorkerPrisma());
}
