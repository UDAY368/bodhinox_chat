import type { Channel, Conversation, Contact, Tag } from "@/types";
import type { DataClient, QueryResult } from '@/lib/data/types';
import { fetchAllPages } from '@/lib/data/paged-query';

/**
 * Conversation select that embeds the contact plus its tags, so the Inbox
 * can filter conversations by contact tag without a second round-trip.
 * `contact_tags(tags(*))` returns the join rows; {@link normalizeConversation}
 * flattens them onto `contact.tags`.
 */
export const CONVERSATION_SELECT =
  "*, contact:contacts(*, contact_tags(tags(*)))";

/**
 * The Inbox list, in the server's order. With `updatedSince` only the
 * conversations changed at or after that instant are read, so a periodic
 * resync costs the rows that changed instead of the whole inbox. With
 * `channel` only that channel's conversations are read (a channel inbox
 * never loads the other channel's rows); without it every channel is.
 */
export async function loadInboxConversations(
  db: DataClient,
  options: { updatedSince?: string; channel?: Channel } = {},
): Promise<QueryResult<Conversation[]>> {
  try {
    const data = await fetchAllPages<Conversation>((from, to) => {
      let query = db
        .from('conversations')
        .select<Conversation>(CONVERSATION_SELECT);
      // conversations.channel is NOT NULL DEFAULT 'whatsapp', so older rows match 'whatsapp'.
      if (options.channel) query = query.eq('channel', options.channel);
      if (options.updatedSince) query = query.gte('updated_at', options.updatedSince);
      return query
        .order('last_message_at', { ascending: false, nullsFirst: false })
        .order('id', { ascending: true })
        .range(from, to);
    });
    return { data, error: null };
  } catch (error) {
    return { data: null, error: { message: error instanceof Error ? error.message : 'Unable to load conversations' } };
  }
}

/**
 * A row's updated_at is the start time of the transaction that wrote it, so a
 * slow transaction can commit a time earlier than rows already read. Each
 * incremental sync re-reads this much before the newest updated_at it has seen.
 */
export const INBOX_SYNC_OVERLAP_MS = 2 * 60_000;

/**
 * Longest gap between full Inbox list reloads. Incremental syncs cannot see a
 * deleted conversation or a contact edit (neither touches the conversation
 * row), so the list is reloaded whole at most this often.
 */
export const INBOX_FULL_RELOAD_MS = 5 * 60_000;

/**
 * The next incremental-sync cursor: the newest updated_at among `rows` (or
 * `previous` when it is newer), minus the overlap. Null when nothing is known.
 */
export function nextSyncCursor(rows: Pick<Conversation, 'updated_at'>[], previous: string | null): string | null {
  let newest = previous ? Date.parse(previous) + INBOX_SYNC_OVERLAP_MS : Number.NEGATIVE_INFINITY;
  for (const row of rows) {
    const at = Date.parse(row.updated_at);
    if (Number.isFinite(at) && at > newest) newest = at;
  }
  return Number.isFinite(newest) ? new Date(newest - INBOX_SYNC_OVERLAP_MS).toISOString() : null;
}

const lastMessageMs = (c: Conversation) => (c.last_message_at ? Date.parse(c.last_message_at) : Number.NEGATIVE_INFINITY);

/**
 * Merge changed rows (already normalized) into the loaded list: a changed row
 * replaces its loaded copy, a new one is added, and the result keeps the
 * server's order (latest message first, no-message rows last, then id).
 * `activeId`'s unread count stays as loaded: the agent is reading it.
 */
export function mergeConversations(prev: Conversation[], changed: Conversation[], activeId?: string | null): Conversation[] {
  if (changed.length === 0) return prev;
  const byId = new Map(prev.map((c) => [c.id, c]));
  for (const row of changed) {
    const loaded = byId.get(row.id);
    byId.set(row.id, loaded && row.id === activeId ? { ...row, unread_count: loaded.unread_count } : row);
  }
  return [...byId.values()].sort((a, b) => lastMessageMs(b) - lastMessageMs(a) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** Raw shape returned by {@link CONVERSATION_SELECT} before flattening. */
type RawContact = Contact & { contact_tags?: { tags: Tag | null }[] };
type RawConversation = Omit<Conversation, "contact"> & {
  contact?: RawContact | null;
};

/**
 * Flatten the embedded `contact_tags(tags(*))` join into `contact.tags`.
 * Safe to call on rows fetched with {@link CONVERSATION_SELECT}; a row with
 * no contact (e.g. a freshly-inserted conversation) passes through untouched.
 */
export function normalizeConversation(raw: RawConversation): Conversation {
  const rawContact = raw.contact;
  if (!rawContact) return raw as Conversation;

  const { contact_tags, ...contact } = rawContact;
  return {
    ...raw,
    contact: {
      ...contact,
      tags: (contact_tags ?? [])
        .map((ct) => ct.tags)
        .filter((t): t is Tag => t != null),
    },
  };
}

export function normalizeConversations(
  rows: RawConversation[],
): Conversation[] {
  return rows.map(normalizeConversation);
}

export interface ContactFilters {
  /** Tag ids; a conversation matches if its contact has ANY of them (OR). */
  tagIds: string[];
  /** Exact company match, or null for no company filter. */
  company: string | null;
}

/**
 * Whether a conversation passes the contact-based Inbox filters (issue #272).
 * Empty `tagIds` and null `company` are no-ops, so the default (no filters)
 * always matches. Tags use OR logic, consistent with Broadcast audiences.
 */
export function matchesContactFilters(
  conversation: Conversation,
  { tagIds, company }: ContactFilters,
): boolean {
  if (tagIds.length > 0) {
    const contactTagIds = conversation.contact?.tags ?? [];
    if (!contactTagIds.some((t) => tagIds.includes(t.id))) return false;
  }

  if (company !== null && conversation.contact?.company?.trim() !== company) {
    return false;
  }

  return true;
}
