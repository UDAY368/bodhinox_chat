import type { TenantContext, TenantTransaction } from '@/lib/db/tenant';
import { createNotification } from './notify';

/**
 * Internal conversation notes with @mentions. Notes are team-only: they are
 * stored in conversation_notes and never reach the contact, so nothing here
 * touches a WhatsApp send path, the jobs queue or outbound intents.
 *
 * Runs inside the caller's tenant transaction. RLS lets every member read,
 * agents+ write their own notes, and admins soft-delete anyone's; this module
 * repeats those checks so a refused change is a clear 403/404 instead of a
 * silent zero-row update. Mentions keep only current members of the account,
 * and each mentioned member gets one 'mention' notification per note (dedupe
 * key), so editing a note notifies only newly added members.
 *
 * Note bodies are customer-adjacent content: stored, never logged.
 */

export const NOTE_BODY_MAX = 4000;
export const MAX_NOTE_MENTIONS = 20;
export const MAX_NOTES_LISTED = 200;

export interface ConversationNote {
  id: string;
  conversation_id: string;
  author_id: string;
  body: string;
  mentions: string[];
  created_at: string;
  edited_at: string | null;
}

export type NoteErrorCode = 'not_found' | 'forbidden' | 'invalid_body' | 'invalid_mentions';

export class NoteError extends Error {
  constructor(readonly code: NoteErrorCode, readonly status: number) {
    super(code);
    this.name = 'NoteError';
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (value: unknown): value is string => typeof value === 'string' && UUID.test(value);

/** Trimmed body, 1..4000 characters; throws invalid_body otherwise. */
export function normalizeNoteBody(value: unknown): string {
  if (typeof value !== 'string') throw new NoteError('invalid_body', 400);
  const body = value.trim();
  if (!body || body.length > NOTE_BODY_MAX) throw new NoteError('invalid_body', 400);
  return body;
}

/** Unique, lower-cased member ids (at most 20); absent means none. */
export function normalizeMentions(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || !value.every(isUuid)) throw new NoteError('invalid_mentions', 400);
  const ids = [...new Set(value.map((id) => id.toLowerCase()))];
  if (ids.length > MAX_NOTE_MENTIONS) throw new NoteError('invalid_mentions', 400);
  return ids;
}

/** Short excerpt for the notification body. */
export function noteExcerpt(body: string, max = 140): string {
  const flat = body.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

type NoteRow = {
  id: string;
  conversation_id: string;
  author_id: string;
  body: string;
  mentions: string[] | null;
  created_at: Date;
  edited_at: Date | null;
};

const toNote = (row: NoteRow): ConversationNote => ({
  id: row.id,
  conversation_id: row.conversation_id,
  author_id: row.author_id,
  body: row.body,
  mentions: row.mentions ?? [],
  created_at: new Date(row.created_at).toISOString(),
  edited_at: row.edited_at ? new Date(row.edited_at).toISOString() : null,
});

type Actor = Required<Pick<TenantContext, 'accountId' | 'userId' | 'role'>>;

async function visibleConversation(tx: TenantTransaction, accountId: string, conversationId: string) {
  if (!isUuid(conversationId)) throw new NoteError('not_found', 404);
  const rows = await tx.$queryRaw<{ id: string; contact_id: string | null }[]>`
    SELECT id::text AS id, contact_id::text AS contact_id FROM conversations
    WHERE id=${conversationId}::uuid AND account_id=${accountId}::uuid`;
  if (!rows[0]) throw new NoteError('not_found', 404);
  return rows[0];
}

/** Mentioned ids that are members of this account right now; others are dropped. */
async function currentMembers(tx: TenantTransaction, accountId: string, ids: string[]): Promise<string[]> {
  if (!ids.length) return [];
  const rows = await tx.$queryRaw<{ user_id: string }[]>`
    SELECT user_id::text AS user_id FROM account_memberships
    WHERE account_id=${accountId}::uuid AND user_id = ANY(${ids}::uuid[])`;
  const members = new Set(rows.map((row) => row.user_id.toLowerCase()));
  return ids.filter((id) => members.has(id));
}

async function notifyMentions(
  tx: TenantTransaction,
  actor: Actor,
  conversation: { id: string; contact_id: string | null },
  note: ConversationNote,
): Promise<string[]> {
  if (!note.mentions.length) return [];
  const profile = await tx.$queryRaw<{ full_name: string | null }[]>`
    SELECT full_name FROM profiles WHERE user_id=${actor.userId}::uuid`;
  const name = profile[0]?.full_name?.trim() || 'A teammate';
  const result = await createNotification(tx, {
    accountId: actor.accountId,
    userIds: note.mentions,
    event: 'mention',
    title: `${name} mentioned you in a note`,
    body: noteExcerpt(note.body),
    link: `/inbox?c=${conversation.id}`,
    // One mention notification per member per note, across edits.
    dedupeKey: `note-mention:${note.id}`,
    actorUserId: actor.userId,
    conversationId: conversation.id,
    contactId: conversation.contact_id,
  });
  return result.inApp;
}

export async function listConversationNotes(
  tx: TenantTransaction,
  accountId: string,
  conversationId: string,
): Promise<ConversationNote[]> {
  await visibleConversation(tx, accountId, conversationId);
  const rows = await tx.$queryRaw<NoteRow[]>`
    SELECT * FROM (
      SELECT id::text AS id, conversation_id::text AS conversation_id, author_id::text AS author_id, body,
        mentions::text[] AS mentions, created_at, edited_at
      FROM conversation_notes
      WHERE account_id=${accountId}::uuid AND conversation_id=${conversationId}::uuid AND deleted_at IS NULL
      ORDER BY created_at DESC, id DESC
      LIMIT ${MAX_NOTES_LISTED}
    ) recent ORDER BY created_at, id`;
  return rows.map(toNote);
}

export async function createConversationNote(
  tx: TenantTransaction,
  actor: Actor,
  conversationId: string,
  input: { body: unknown; mentions?: unknown },
): Promise<{ note: ConversationNote; notified: string[] }> {
  const body = normalizeNoteBody(input.body);
  const requested = normalizeMentions(input.mentions);
  const conversation = await visibleConversation(tx, actor.accountId, conversationId);
  const mentions = await currentMembers(tx, actor.accountId, requested);
  const rows = await tx.$queryRaw<NoteRow[]>`
    INSERT INTO conversation_notes(account_id, conversation_id, author_id, body, mentions)
    VALUES(${actor.accountId}::uuid, ${conversation.id}::uuid, ${actor.userId}::uuid, ${body}, ${mentions}::uuid[])
    RETURNING id::text AS id, conversation_id::text AS conversation_id, author_id::text AS author_id, body,
      mentions::text[] AS mentions, created_at, edited_at`;
  const note = toNote(rows[0]);
  return { note, notified: await notifyMentions(tx, actor, conversation, note) };
}

async function liveNote(tx: TenantTransaction, accountId: string, conversationId: string, noteId: string) {
  if (!isUuid(noteId)) throw new NoteError('not_found', 404);
  const rows = await tx.$queryRaw<NoteRow[]>`
    SELECT id::text AS id, conversation_id::text AS conversation_id, author_id::text AS author_id, body,
      mentions::text[] AS mentions, created_at, edited_at
    FROM conversation_notes
    WHERE id=${noteId}::uuid AND account_id=${accountId}::uuid AND conversation_id=${conversationId}::uuid
      AND deleted_at IS NULL`;
  if (!rows[0]) throw new NoteError('not_found', 404);
  return toNote(rows[0]);
}

/** Only the author edits the text; newly mentioned members are notified once. */
export async function updateConversationNote(
  tx: TenantTransaction,
  actor: Actor,
  conversationId: string,
  noteId: string,
  input: { body: unknown; mentions?: unknown },
): Promise<{ note: ConversationNote; notified: string[] }> {
  const body = normalizeNoteBody(input.body);
  const requested = normalizeMentions(input.mentions);
  const conversation = await visibleConversation(tx, actor.accountId, conversationId);
  const existing = await liveNote(tx, actor.accountId, conversation.id, noteId);
  if (existing.author_id.toLowerCase() !== actor.userId.toLowerCase()) throw new NoteError('forbidden', 403);
  const mentions = await currentMembers(tx, actor.accountId, requested);
  const rows = await tx.$queryRaw<NoteRow[]>`
    UPDATE conversation_notes SET body=${body}, mentions=${mentions}::uuid[]
    WHERE id=${existing.id}::uuid AND account_id=${actor.accountId}::uuid AND deleted_at IS NULL
    RETURNING id::text AS id, conversation_id::text AS conversation_id, author_id::text AS author_id, body,
      mentions::text[] AS mentions, created_at, edited_at`;
  if (!rows[0]) throw new NoteError('not_found', 404);
  const note = toNote(rows[0]);
  return { note, notified: await notifyMentions(tx, actor, conversation, note) };
}

/** Soft delete: the author, or an admin/owner for anyone's note. */
export async function deleteConversationNote(
  tx: TenantTransaction,
  actor: Actor,
  conversationId: string,
  noteId: string,
): Promise<void> {
  const conversation = await visibleConversation(tx, actor.accountId, conversationId);
  const existing = await liveNote(tx, actor.accountId, conversation.id, noteId);
  const isAuthor = existing.author_id.toLowerCase() === actor.userId.toLowerCase();
  const isAdmin = actor.role === 'admin' || actor.role === 'owner';
  if (!isAuthor && !isAdmin) throw new NoteError('forbidden', 403);
  const changed = await tx.$executeRaw`
    UPDATE conversation_notes SET deleted_at=now()
    WHERE id=${existing.id}::uuid AND account_id=${actor.accountId}::uuid AND deleted_at IS NULL`;
  if (!changed) throw new NoteError('not_found', 404);
}
