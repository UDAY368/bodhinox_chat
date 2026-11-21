// Conversation-level inbox actions behind fixed routes: mark conversations
// read or unread, assign, resolve and label them (one, or many from the bulk
// route), and export a conversation's messages as CSV. Each looks conversations
// up through the member's visibility (Stage 5), inside the caller's tenant
// transaction, so another workspace's id, or one the member cannot see, is
// not found. Nothing from a message is logged.
import type { TenantTransaction } from '@/lib/db/tenant';
import { csvCell } from '@/lib/audience/csv-cell';
import { loadPhoneMask, type PhoneMaskContext } from '@/lib/inbox/masking-apply';
import { maskPhonesInText } from '@/lib/inbox/masking';
import { conversationVisible } from '@/lib/inbox/visibility-sql';
import { eligibleMembers } from '@/lib/inbox/routing';

export class ConversationActionError extends Error {
  constructor(readonly code: 'not_found' | 'invalid_request', readonly status: number) {
    super(code);
    this.name = 'ConversationActionError';
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Most messages one export holds (newest kept); a longer chat says so in its last row. */
export const EXPORT_MESSAGE_LIMIT = 10_000;

/**
 * Mark a visible conversation unread (at least one unread message, so it
 * shows bold with a count) or read (count 0). Returns the new count.
 */
export async function setConversationUnread(
  tx: TenantTransaction,
  accountId: string,
  conversationId: string,
  unread: boolean,
): Promise<number> {
  if (!UUID.test(conversationId)) throw new ConversationActionError('not_found', 404);
  const rows = await markConversationsUnread(tx, accountId, [conversationId], unread);
  if (!rows[0]) throw new ConversationActionError('not_found', 404);
  return rows[0].unread_count;
}

// ---------------------------------------------------------------- set-based actions
//
// The single and bulk inbox actions share these. Each changes only the
// conversations of `ids` the member may see (visibility in the WHERE, RLS for
// the workspace) and returns the ids it changed; a hidden or foreign id is
// simply not changed. The row triggers do the rest exactly as for a
// one-conversation edit: lifecycle state, who resolved it, the handling log,
// the assignee's notification and the realtime event.

/** Ids must be checked uuids before they reach SQL. */
function checkedIds(ids: readonly string[]): string[] {
  if (!ids.every((id) => UUID.test(id))) throw new ConversationActionError('invalid_request', 400);
  return [...new Set(ids.map((id) => id.toLowerCase()))];
}

/** Unread (at least one) or read (0). Returns each changed conversation with its new count. */
export async function markConversationsUnread(
  tx: TenantTransaction,
  accountId: string,
  ids: readonly string[],
  unread: boolean,
): Promise<{ id: string; unread_count: number }[]> {
  const wanted = checkedIds(ids);
  if (!wanted.length) return [];
  const rows = await tx.$queryRaw<{ id: string; unread_count: number }[]>`
    UPDATE conversations SET unread_count = CASE WHEN ${unread} THEN GREATEST(unread_count, 1) ELSE 0 END,
      updated_at = NOW()
    WHERE id = ANY(${wanted}::uuid[]) AND account_id=${accountId}::uuid AND ${conversationVisible('conversations')}
    RETURNING id::text AS id, unread_count`;
  return rows.map((row) => ({ id: row.id, unread_count: Number(row.unread_count) }));
}

/**
 * Assign to a member of this workspace, or unassign (null). Conversations
 * already with that assignee are left alone (no repeat notification). The
 * assignee must still be able to own conversations (owner, admin or agent):
 * the rule the shared assign action applies (src/lib/actions/assign.ts
 * resolveAssignee, routing.ts eligibleMembers), so a viewer or a removed member
 * is refused.
 */
export async function assignConversations(
  tx: TenantTransaction,
  accountId: string,
  ids: readonly string[],
  agentId: string | null,
): Promise<string[]> {
  const wanted = checkedIds(ids);
  if (agentId !== null) {
    if (!UUID.test(agentId)) throw new ConversationActionError('invalid_request', 400);
    if (!(await eligibleMembers(tx, accountId, [agentId])).has(agentId.toLowerCase()))
      throw new ConversationActionError('invalid_request', 400);
  }
  if (!wanted.length) return [];
  const rows = await tx.$queryRaw<{ id: string }[]>`
    UPDATE conversations SET assigned_agent_id = ${agentId}::uuid
    WHERE id = ANY(${wanted}::uuid[]) AND account_id=${accountId}::uuid
      AND assigned_agent_id IS DISTINCT FROM ${agentId}::uuid AND ${conversationVisible('conversations')}
    RETURNING id::text AS id`;
  return rows.map((row) => row.id);
}

/** Resolve (status closed). Already resolved conversations are left alone. */
export async function resolveConversations(tx: TenantTransaction, accountId: string, ids: readonly string[]): Promise<string[]> {
  const wanted = checkedIds(ids);
  if (!wanted.length) return [];
  const rows = await tx.$queryRaw<{ id: string }[]>`
    UPDATE conversations SET status = 'closed'
    WHERE id = ANY(${wanted}::uuid[]) AND account_id=${accountId}::uuid AND status <> 'closed'
      AND ${conversationVisible('conversations')}
    RETURNING id::text AS id`;
  return rows.map((row) => row.id);
}

/** Apply a label of this workspace (labels.ts); an unknown label is not_found. Returns the newly labelled ids. */
export async function labelConversations(
  tx: TenantTransaction,
  accountId: string,
  ids: readonly string[],
  labelId: string,
): Promise<string[]> {
  const wanted = checkedIds(ids);
  if (!UUID.test(labelId)) throw new ConversationActionError('not_found', 404);
  const label = await tx.$queryRaw<{ id: string }[]>`
    SELECT id::text AS id FROM conversation_labels WHERE account_id=${accountId}::uuid AND id=${labelId}::uuid`;
  if (!label[0]) throw new ConversationActionError('not_found', 404);
  if (!wanted.length) return [];
  const rows = await tx.$queryRaw<{ id: string }[]>`
    INSERT INTO conversation_label_links(account_id, conversation_id, label_id)
    SELECT ${accountId}::uuid, conversations.id, ${labelId}::uuid FROM conversations
    WHERE conversations.id = ANY(${wanted}::uuid[]) AND conversations.account_id=${accountId}::uuid
      AND ${conversationVisible('conversations')}
    ON CONFLICT DO NOTHING
    RETURNING conversation_id::text AS id`;
  return rows.map((row) => row.id);
}

export interface ExportMessageRow {
  created_at: Date | string;
  sender_type: string;
  sender_name: string | null;
  content_type: string;
  content_text: string | null;
  media_url: string | null;
  status: string | null;
}

const SENDER_LABEL: Record<string, string> = { customer: 'Customer', agent: 'Team', bot: 'Automation' };

/** The CSV text for an export: a header row, then one row per message, oldest first. */
export function conversationCsv(rows: readonly ExportMessageRow[], options: { mask: boolean; truncated: boolean }): string {
  const text = (value: string | null) => (options.mask ? maskPhonesInText(value) : value);
  const lines = [['Time', 'From', 'Sender', 'Type', 'Text', 'Attachment', 'Status'].map(csvCell).join(',')];
  for (const row of rows) {
    lines.push([
      row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
      SENDER_LABEL[row.sender_type] ?? row.sender_type,
      row.sender_type === 'customer' ? '' : (row.sender_name ?? ''),
      row.content_type,
      text(row.content_text) ?? '',
      row.media_url ? 'yes' : '',
      row.status ?? '',
    ].map(csvCell).join(','));
  }
  if (options.truncated) lines.push(csvCell(`Only the latest ${EXPORT_MESSAGE_LIMIT} messages are included`));
  return `${lines.join('\r\n')}\r\n`;
}

/** A safe download name: the contact's name (letters, digits, dashes) or "chat". */
export function exportFileName(contactName: string | null | undefined): string {
  const slug = (contactName ?? '').normalize('NFKD').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
  return `${slug || 'chat'}.csv`;
}

/** The visible conversation's messages as CSV, phone numbers masked for a masked member. */
export async function exportConversation(
  tx: TenantTransaction,
  context: PhoneMaskContext,
  conversationId: string,
): Promise<{ csv: string; fileName: string }> {
  if (!UUID.test(conversationId)) throw new ConversationActionError('not_found', 404);
  const accountId = context.accountId;
  const found = await tx.$queryRaw<{ name: string | null }[]>`
    SELECT ct.name FROM conversations
    LEFT JOIN contacts ct ON ct.account_id=conversations.account_id AND ct.id=conversations.contact_id
    WHERE conversations.id=${conversationId}::uuid AND conversations.account_id=${accountId}::uuid
      AND ${conversationVisible('conversations')}`;
  if (!found[0]) throw new ConversationActionError('not_found', 404);
  const mask = await loadPhoneMask(tx, context);
  const rows = await tx.$queryRaw<ExportMessageRow[]>`
    SELECT * FROM (
      SELECT m.created_at, m.sender_type, p.full_name AS sender_name, m.content_type, m.content_text, m.media_url, m.status
      FROM messages m
      LEFT JOIN profiles p ON p.user_id=m.sender_id AND p.account_id=m.account_id
      WHERE m.account_id=${accountId}::uuid AND m.conversation_id=${conversationId}::uuid
      ORDER BY m.created_at DESC, m.id DESC
      LIMIT ${EXPORT_MESSAGE_LIMIT + 1}
    ) recent ORDER BY created_at, sender_type`;
  const truncated = rows.length > EXPORT_MESSAGE_LIMIT;
  const kept = truncated ? rows.slice(1) : rows;
  const name = mask ? maskPhonesInText(found[0].name) : found[0].name;
  return { csv: conversationCsv(kept, { mask, truncated }), fileName: exportFileName(name) };
}
