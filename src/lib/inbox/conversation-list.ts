// The inbox conversation list, paged and filtered in SQL (batch 7). Server only.
//
// Every filter the list offers (views and folders, channel, number, agent,
// tags, company, consent, search, the 24-hour window) is one WHERE over
// `conversations c LEFT JOIN contacts ct`, always with the account and the
// member's agent visibility (inbox-scope.ts), and with the member's own
// pending snoozes left out (except in the Reminders folder). Pages are keyset
// pages in the list's order: latest activity first (last_message_at DESC
// NULLS LAST, id), or, for the open-window queue, the window closing soonest
// first. Rows come back in the shape the browser's conversations resource
// read gives (contracts.ts columns, contact with its tags), numbers masked for
// a masked member. Nothing here is logged.
import { Prisma } from '@prisma/client';
import { withTenant, type TenantContext, type TenantTransaction } from '@/lib/db/tenant';
import { getResource } from '@/lib/data/contracts';
import { handledBySql } from './handling-history';
import { labelOfFilter, type InboxFilter, type InboxListQuery } from './inbox-filters';
import { conversationVisibleSql } from './inbox-scope';
import { loadPhoneMask, maskContactRow, maskedPhoneSearchSql } from './masking-apply';
import { messageSearchVector } from './message-search';

/** Rows per page. */
export const INBOX_PAGE_SIZE = 50;
export const MAX_INBOX_PAGE_SIZE = 100;
/** Most ids one membership check (`ids=`) takes. */
export const MAX_LOOKUP_IDS = 100;
/** Most changed rows one resync returns; past it the browser reloads its first page. */
export const MAX_CHANGED_ROWS = 200;
const STATEMENT_TIMEOUT_MS = 8_000;

export class InboxListError extends Error {
  readonly status = 400;
  constructor(readonly code: 'invalid_request' | 'invalid_cursor') {
    super(code);
    this.name = 'InboxListError';
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?Z$/;

// ---------------------------------------------------------------- SQL pieces

/** Latest customer message (the 24-hour window), as the conversations resource computes it (repositories/query.ts). */
const LAST_CUSTOMER = Prisma.raw(`(SELECT max(lcm.created_at) FROM messages lcm
  WHERE lcm.account_id = c.account_id AND lcm.conversation_id = c.id AND lcm.sender_type = 'customer')`);
/** Latest successful business reply, as the conversations resource computes it. */
const LAST_REPLY = Prisma.raw(`(SELECT max(lr.created_at) FROM messages lr
  WHERE lr.account_id = c.account_id AND lr.conversation_id = c.id AND lr.sender_type IN ('agent','bot')
    AND lr.status IN ('sent','delivered','read') AND lr.content_type NOT IN ('template','system'))`);
/**
 * The 24-hour window is open. last_message_at is never older than the latest
 * customer message, so the cheap indexed bound (with an hour of slack for
 * provider timestamps) skips the per-row lookup for every older conversation.
 */
const WINDOW_OPEN = Prisma.sql`(c.last_message_at > now() - interval '25 hours' AND ${LAST_CUSTOMER} > now() - interval '24 hours')`;
const WAITING = Prisma.sql`(c.status <> 'closed' AND ${LAST_CUSTOMER} IS NOT NULL
  AND (${LAST_REPLY} IS NULL OR ${LAST_CUSTOMER} > ${LAST_REPLY}))`;
const ME = Prisma.raw('app_user_id()');
/** A pending snooze of the member's own hides the conversation until it wakes. */
const NOT_SNOOZED = Prisma.sql`NOT EXISTS (SELECT 1 FROM conversation_reminders snz
  WHERE snz.account_id = c.account_id AND snz.conversation_id = c.id AND snz.user_id = ${ME}
    AND snz.kind = 'snooze' AND snz.status = 'pending' AND snz.remind_at > now())`;
const FROM = Prisma.sql`conversations c LEFT JOIN contacts ct ON ct.account_id = c.account_id AND ct.id = c.contact_id`;
const TRUE = Prisma.sql`TRUE`;

const and = (parts: Prisma.Sql[]) => (parts.length ? Prisma.join(parts, ' AND ') : TRUE);

function likePattern(text: string): string {
  return `%${text.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
}

/** The view or folder (inbox-filters.ts matchesInboxFilter, in SQL). */
export function folderSql(filter: InboxFilter): Prisma.Sql {
  const label = labelOfFilter(filter);
  if (label)
    return Prisma.sql`EXISTS (SELECT 1 FROM conversation_label_links l
      WHERE l.account_id = c.account_id AND l.conversation_id = c.id AND l.label_id = ${label}::uuid)`;
  switch (filter) {
    case 'all':
      return TRUE;
    case 'open':
    case 'pending':
      // Open includes legacy rows still stored as 'pending' (inbox-filters.ts isOpenStatus).
      return Prisma.sql`c.status IN ('open', 'pending')`;
    case 'closed':
      return Prisma.sql`c.status = 'closed'`;
    case 'unread':
      return Prisma.sql`c.unread_count > 0`;
    case 'waiting':
      return WAITING;
    case 'unassigned':
      return Prisma.sql`(c.status <> 'closed' AND c.assigned_agent_id IS NULL)`;
    case 'mine':
      return Prisma.sql`(c.status <> 'closed' AND c.assigned_agent_id = ${ME})`;
    case 'my-team':
      return Prisma.sql`EXISTS (SELECT 1 FROM team_members mine
        JOIN team_members theirs ON theirs.account_id = mine.account_id AND theirs.team_id = mine.team_id
        WHERE mine.account_id = c.account_id AND mine.user_id = ${ME} AND theirs.user_id = c.assigned_agent_id)`;
    case 'expiring-soon':
      // Waiting, and the window closes within two hours.
      return Prisma.sql`(${WAITING} AND ${WINDOW_OPEN} AND ${LAST_CUSTOMER} <= now() - interval '22 hours')`;
    case 'lifecycle-resolved':
      return Prisma.sql`c.status = 'closed'`;
    case 'lifecycle-assigned':
      return Prisma.sql`(c.status <> 'closed' AND c.assigned_agent_id IS NOT NULL)`;
    case 'lifecycle-bot':
      return Prisma.sql`(c.status <> 'closed' AND c.assigned_agent_id IS NULL AND c.lifecycle_state = 'bot')`;
    case 'lifecycle-requesting':
      return Prisma.sql`(c.status <> 'closed' AND c.assigned_agent_id IS NULL AND c.lifecycle_state <> 'bot')`;
    case 'favourites':
      return Prisma.sql`EXISTS (SELECT 1 FROM conversation_favourites f
        WHERE f.account_id = c.account_id AND f.conversation_id = c.id AND f.user_id = ${ME})`;
    case 'reminders':
      return Prisma.sql`EXISTS (SELECT 1 FROM conversation_reminders r
        WHERE r.account_id = c.account_id AND r.conversation_id = c.id AND r.user_id = ${ME} AND r.status = 'pending')`;
    case 'failed':
      // failed-outbound.ts: the latest team message failed, in the last 30 days.
      return Prisma.sql`(c.last_message_at > now() - interval '30 days' AND (SELECT m.status FROM messages m
        WHERE m.account_id = c.account_id AND m.conversation_id = c.id AND m.sender_type IN ('agent','bot')
        ORDER BY m.created_at DESC, m.id DESC LIMIT 1) = 'failed')`;
    default:
      return Prisma.sql`FALSE`;
  }
}

/** The narrowing beside the view: channel tab, number, agent, tags, company, consent, search. */
export function narrowingSql(query: InboxListQuery, maskPhones: boolean): Prisma.Sql {
  const parts: Prisma.Sql[] = [];
  if (query.channel) parts.push(Prisma.sql`c.channel = ${query.channel}`);
  if (query.numberId === 'none') parts.push(Prisma.sql`(c.channel = 'whatsapp' AND c.whatsapp_config_id IS NULL)`);
  else if (query.numberId) parts.push(Prisma.sql`(c.channel = 'whatsapp' AND c.whatsapp_config_id = ${query.numberId}::uuid)`);
  if (query.agent?.mode === 'handled') parts.push(handledBySql(query.agent.memberId));
  else if (query.agent) parts.push(Prisma.sql`c.assigned_agent_id = ${query.agent.memberId}::uuid`);
  if (query.tagIds.length)
    parts.push(Prisma.sql`EXISTS (SELECT 1 FROM contact_tags x
      WHERE x.account_id = c.account_id AND x.contact_id = c.contact_id AND x.tag_id = ANY(${query.tagIds}::uuid[]))`);
  if (query.company !== null) parts.push(Prisma.sql`btrim(ct.company) = ${query.company}`);
  // WhatsApp consent: Instagram chats have their own subscription, so they drop out.
  if (query.consent === 'opted_out') parts.push(Prisma.sql`(c.channel = 'whatsapp' AND ct.opted_out_at IS NOT NULL)`);
  if (query.consent === 'opted_in')
    parts.push(Prisma.sql`(c.channel = 'whatsapp' AND ct.opted_out_at IS NULL AND ct.opted_in_at IS NOT NULL)`);
  if (query.consent === 'none')
    parts.push(Prisma.sql`(c.channel = 'whatsapp' AND ct.opted_out_at IS NULL AND ct.opted_in_at IS NULL)`);
  const search = query.search.trim();
  if (search) {
    const pattern = likePattern(search);
    // A masked member searches numbers only by their last digits (masking-apply.ts).
    const phone = maskPhones ? maskedPhoneSearchSql(Prisma.sql`ct.phone`, search) : Prisma.sql`ct.phone ILIKE ${pattern}`;
    // Older messages: the indexed full-text match (search.ts), for terms with three letters or digits.
    const meaningful = search.match(/[\p{L}\p{N}]/gu)?.length ?? 0;
    const inMessages = meaningful >= 3
      ? Prisma.sql`OR c.id IN (SELECT m.conversation_id FROM messages m WHERE m.account_id = c.account_id
          AND ${messageSearchVector('m')} @@ websearch_to_tsquery('simple', ${search}))`
      : Prisma.empty;
    parts.push(Prisma.sql`(ct.name ILIKE ${pattern} OR ${phone} OR c.last_message_text ILIKE ${pattern} ${inMessages})`);
  }
  return and(parts);
}

function sessionSql(query: InboxListQuery): Prisma.Sql {
  if (query.session === 'active') return WINDOW_OPEN;
  if (query.session === 'expired') return Prisma.sql`NOT ${WINDOW_OPEN}`;
  return TRUE;
}

/** The inbox itself: this workspace, conversations the member may see, the page's channel. */
function inboxSql(accountId: string, query: InboxListQuery): Prisma.Sql {
  const parts = [Prisma.sql`c.account_id = ${accountId}::uuid`, Prisma.raw(conversationVisibleSql('c'))];
  if (query.scope !== 'all') parts.push(Prisma.sql`c.channel = ${query.scope}`);
  return and(parts);
}

/** Leaves out the member's snoozed conversations, except in the Reminders folder (which lists them). */
function snoozeSql(query: InboxListQuery): Prisma.Sql {
  return query.filter === 'reminders' ? TRUE : NOT_SNOOZED;
}

/** Every condition of the query, over `FROM`. */
export function listWhere(accountId: string, query: InboxListQuery, maskPhones: boolean): Prisma.Sql {
  return and([inboxSql(accountId, query), snoozeSql(query), folderSql(query.filter), narrowingSql(query, maskPhones), sessionSql(query)]);
}

// ---------------------------------------------------------------- rows

type Sort = 'recent' | 'window';
const sortOf = (query: InboxListQuery): Sort => (query.session === 'active' ? 'window' : 'recent');

/** A keyset position: the sort value (microseconds kept as text) and the id. */
interface Cursor { s: Sort; at: string | null; id: string }

export function encodeListCursor(cursor: Cursor): string {
  return Buffer.from(JSON.stringify(cursor)).toString('base64url');
}

export function decodeListCursor(value: string, sort: Sort): Cursor {
  try {
    if (value.length > 300 || !/^[A-Za-z0-9_-]+$/.test(value)) throw new Error();
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as Partial<Cursor>;
    if (parsed.s !== sort || typeof parsed.id !== 'string' || !UUID.test(parsed.id)) throw new Error();
    if (parsed.at !== null && (typeof parsed.at !== 'string' || !STAMP.test(parsed.at))) throw new Error();
    if (sort === 'window' && parsed.at === null) throw new Error();
    return { s: sort, at: parsed.at, id: parsed.id };
  } catch {
    throw new InboxListError('invalid_cursor');
  }
}

const SAFE_COLUMN = /^[a-z_][a-z0-9_]*$/;
const VIRTUAL = new Set(['last_customer_message_at', 'last_reply_at']);
let columnCache: { conversation: Prisma.Sql; contact: string[]; tag: string[] } | null = null;
/** The columns the browser may read (contracts.ts), as the conversations resource returns them. */
function columns() {
  if (!columnCache) {
    const names = getResource('conversations', true).read.filter((name) => !VIRTUAL.has(name) && SAFE_COLUMN.test(name));
    columnCache = {
      conversation: Prisma.raw(names.map((name) => `c."${name}"`).join(', ')),
      contact: getResource('contacts', true).read,
      tag: getResource('tags', true).read,
    };
  }
  return columnCache;
}

const pick = (row: Record<string, unknown>, keys: readonly string[]) =>
  Object.fromEntries(keys.filter((key) => Object.hasOwn(row, key)).map((key) => [key, row[key]]));

/** The row columns: the conversation, its computed times, its contact with tags. */
const ROW_SELECT = () => Prisma.sql`${columns().conversation},
  ${LAST_CUSTOMER} AS last_customer_message_at, ${LAST_REPLY} AS last_reply_at,
  CASE WHEN ct.id IS NULL THEN NULL ELSE to_jsonb(ct) END AS contact_json,
  (SELECT COALESCE(jsonb_agg(to_jsonb(t) ORDER BY t.name, t.id), '[]'::jsonb) FROM contact_tags x
    JOIN tags t ON t.account_id = x.account_id AND t.id = x.tag_id
    WHERE x.account_id = c.account_id AND x.contact_id = c.contact_id) AS tags_json`;

type RawRow = Record<string, unknown> & { contact_json: Record<string, unknown> | null; tags_json: Record<string, unknown>[] | null };

/** One list row as the browser gets it. */
export type ListRow = Record<string, unknown> & { id: string };

/** Columns of the raw row that are query plumbing, not part of the list row. */
const PLUMBING = new Set(['contact_json', 'tags_json', 'cursor_at', 'matches']);

function toListRow(raw: RawRow, maskPhones: boolean): ListRow {
  const conversation: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) if (!PLUMBING.has(key)) conversation[key] = value;
  const cols = columns();
  const contact = raw.contact_json
    ? { ...maskContactRow(pick(raw.contact_json, cols.contact), maskPhones), tags: (raw.tags_json ?? []).map((tag) => pick(tag, cols.tag)) }
    : null;
  return { ...conversation, id: String(raw.id), contact };
}

async function prepare(tx: TenantTransaction, ctx: TenantContext): Promise<boolean> {
  await tx.$queryRaw`SELECT set_config('statement_timeout', ${String(STATEMENT_TIMEOUT_MS)}, true)`;
  return loadPhoneMask(tx, ctx);
}

export interface InboxListCounts {
  /** The quick views of this inbox (snoozed conversations left out). */
  views: Record<'all' | 'open' | 'unread' | 'unassigned' | 'mine' | 'closed' | 'lifecycle-requesting' | 'lifecycle-assigned', number>;
  /** Conversations of this inbox with an open 24-hour window. */
  activeWindow: number;
  /** The current view per channel (the All view's channel tabs). */
  channels: { all: number; whatsapp: number; instagram: number };
  /** The current view and narrowing, without the window filter: open and closed windows. */
  windows: { active: number; expired: number };
  /** Every conversation the whole query matches (what "Select all" reaches). */
  total: number;
}

export interface InboxListPage {
  conversations: ListRow[];
  nextCursor: string | null;
  counts?: InboxListCounts;
  /** Companies of this inbox's contacts, for the company filter (first page only). */
  companies?: string[];
}

async function countsFor(tx: TenantTransaction, accountId: string, query: InboxListQuery, maskPhones: boolean): Promise<InboxListCounts> {
  const inbox = and([inboxSql(accountId, query), snoozeSql({ ...query, filter: 'all' })]);
  const [views] = await tx.$queryRaw<Record<string, number>[]>(Prisma.sql`
    SELECT count(*)::int AS "all",
      count(*) FILTER (WHERE ${folderSql('open')})::int AS "open",
      count(*) FILTER (WHERE ${folderSql('unread')})::int AS "unread",
      count(*) FILTER (WHERE ${folderSql('unassigned')})::int AS "unassigned",
      count(*) FILTER (WHERE ${folderSql('mine')})::int AS "mine",
      count(*) FILTER (WHERE c.status = 'closed')::int AS "closed",
      count(*) FILTER (WHERE ${folderSql('lifecycle-requesting')})::int AS "lifecycle-requesting",
      count(*) FILTER (WHERE ${folderSql('lifecycle-assigned')})::int AS "lifecycle-assigned",
      count(*) FILTER (WHERE ${WINDOW_OPEN})::int AS "active_window"
    FROM conversations c WHERE ${inbox}`);
  const narrowing = narrowingSql(query, maskPhones);
  const [view] = await tx.$queryRaw<Record<string, number>[]>(Prisma.sql`
    SELECT count(*)::int AS "all",
      count(*) FILTER (WHERE c.channel = 'whatsapp')::int AS "whatsapp",
      count(*) FILTER (WHERE c.channel = 'instagram')::int AS "instagram",
      count(*) FILTER (WHERE ${narrowing})::int AS "matched",
      count(*) FILTER (WHERE ${narrowing} AND ${WINDOW_OPEN})::int AS "matched_active"
    FROM ${FROM} WHERE ${inboxSql(accountId, query)} AND ${snoozeSql(query)} AND ${folderSql(query.filter)}`);
  const { active_window: activeWindow, ...viewCounts } = views;
  const windows = { active: view.matched_active, expired: view.matched - view.matched_active };
  return {
    views: viewCounts as InboxListCounts['views'],
    activeWindow,
    channels: { all: view.all, whatsapp: view.whatsapp, instagram: view.instagram },
    windows,
    total: query.session === 'active' ? windows.active : query.session === 'expired' ? windows.expired : view.matched,
  };
}

/** The counts alone (a resync refreshes them without reloading a page). */
export async function countInboxConversations(ctx: TenantContext, query: InboxListQuery): Promise<InboxListCounts> {
  return withTenant(ctx, async (tx) => countsFor(tx, ctx.accountId, query, await prepare(tx, ctx)));
}

const RECENT_ORDER = Prisma.sql`c.last_message_at DESC NULLS LAST, c.id`;

/**
 * The ids (and sort keys) of one page, `take` rows after `cursor`. Latest
 * activity first reads conversations_list_order_idx (account_id,
 * last_message_at DESC NULLS LAST, id): after a dated cursor, a range on the
 * index for the dated rows (`<= at`, the ties at `at` past the cursor's id),
 * merged with the undated rows that follow every dated one; after an undated
 * cursor, the undated rows past its id. The open-window queue sorts the few
 * conversations of the last day by their latest customer message.
 */
function pageIdsSql(where: Prisma.Sql, sort: Sort, cursor: Cursor | null, take: number): Prisma.Sql {
  const select = (key: Prisma.Sql) => Prisma.sql`SELECT c.id, ${key} AS k FROM ${FROM}`;
  if (sort === 'window') {
    const keyset = cursor
      ? Prisma.sql`(${LAST_CUSTOMER} > ${cursor.at}::timestamptz OR (${LAST_CUSTOMER} = ${cursor.at}::timestamptz AND c.id > ${cursor.id}::uuid))`
      : TRUE;
    return Prisma.sql`${select(LAST_CUSTOMER)} WHERE ${where} AND ${keyset} ORDER BY 2 ASC, 1 LIMIT ${take}`;
  }
  const recent = select(Prisma.sql`c.last_message_at`);
  if (!cursor) return Prisma.sql`${recent} WHERE ${where} ORDER BY ${RECENT_ORDER} LIMIT ${take}`;
  if (cursor.at === null)
    return Prisma.sql`${recent} WHERE ${where} AND c.last_message_at IS NULL AND c.id > ${cursor.id}::uuid ORDER BY ${RECENT_ORDER} LIMIT ${take}`;
  return Prisma.sql`(${recent} WHERE ${where} AND c.last_message_at <= ${cursor.at}::timestamptz
        AND (c.last_message_at < ${cursor.at}::timestamptz OR c.id > ${cursor.id}::uuid)
        ORDER BY ${RECENT_ORDER} LIMIT ${take})
      UNION ALL
      (${recent} WHERE ${where} AND c.last_message_at IS NULL ORDER BY ${RECENT_ORDER} LIMIT ${take})
      ORDER BY k DESC NULLS LAST, id LIMIT ${take}`;
}

/**
 * One page of the list. The first page (no cursor) also carries the counts and
 * the company choices.
 */
export async function listInboxConversations(
  ctx: TenantContext,
  query: InboxListQuery,
  page: { cursor?: string | null; limit?: number } = {},
): Promise<InboxListPage> {
  const sort = sortOf(query);
  const cursor = page.cursor ? decodeListCursor(page.cursor, sort) : null;
  const limit = Math.min(Math.max(Math.trunc(page.limit ?? INBOX_PAGE_SIZE), 1), MAX_INBOX_PAGE_SIZE);
  return withTenant(ctx, async (tx) => {
    const maskPhones = await prepare(tx, ctx);
    const where = listWhere(ctx.accountId, query, maskPhones);
    const order = sort === 'window' ? Prisma.sql`page.k ASC, page.id` : Prisma.sql`page.k DESC NULLS LAST, page.id`;
    const raw = await tx.$queryRaw<(RawRow & { cursor_at: string | null })[]>(Prisma.sql`
      WITH page AS MATERIALIZED (${pageIdsSql(where, sort, cursor, limit + 1)})
      SELECT ${ROW_SELECT()}, to_char(page.k AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_at
      FROM page JOIN conversations c ON c.account_id = ${ctx.accountId}::uuid AND c.id = page.id
      LEFT JOIN contacts ct ON ct.account_id = c.account_id AND ct.id = c.contact_id
      ORDER BY ${order}`);
    const more = raw.length > limit;
    const rows = more ? raw.slice(0, limit) : raw;
    const last = rows[rows.length - 1];
    const result: InboxListPage = {
      conversations: rows.map((row) => toListRow(row, maskPhones)),
      nextCursor: more && last ? encodeListCursor({ s: sort, at: last.cursor_at, id: String(last.id) }) : null,
    };
    if (!cursor) {
      result.counts = await countsFor(tx, ctx.accountId, query, maskPhones);
      const companies = await tx.$queryRaw<{ company: string }[]>(Prisma.sql`
        SELECT DISTINCT btrim(ct.company) AS company FROM ${FROM}
        WHERE ${inboxSql(ctx.accountId, query)} AND btrim(ct.company) <> ''
        ORDER BY 1 LIMIT 200`);
      result.companies = companies.map((row) => row.company);
    }
    return result;
  });
}

export interface InboxListChanges {
  /** Rows that match the query now, in list shape. */
  conversations: ListRow[];
  /** Ids looked at that do not match (or are gone, or hidden from the member): drop them from the list. */
  removedIds: string[];
  /** More rows changed than one resync returns: reload the first page instead. */
  overflow: boolean;
}

/**
 * Which of some conversations match the query now: by id (a realtime event
 * named them) or every one changed since a time (a resync). Matching rows come
 * back whole; the rest only as ids to drop.
 */
export async function matchInboxConversations(
  ctx: TenantContext,
  query: InboxListQuery,
  target: { ids: string[] } | { since: string },
): Promise<InboxListChanges> {
  let pickRows: Prisma.Sql;
  let limit: number;
  let wanted: string[] = [];
  if ('ids' in target) {
    wanted = [...new Set(target.ids.map((id) => id.toLowerCase()))];
    if (!wanted.length || wanted.length > MAX_LOOKUP_IDS || !wanted.every((id) => UUID.test(id))) throw new InboxListError('invalid_request');
    pickRows = Prisma.sql`c.id = ANY(${wanted}::uuid[])`;
    limit = wanted.length;
  } else {
    if (!STAMP.test(target.since) && Number.isNaN(Date.parse(target.since))) throw new InboxListError('invalid_request');
    pickRows = Prisma.sql`c.updated_at >= ${new Date(target.since)}`;
    limit = MAX_CHANGED_ROWS;
  }
  return withTenant(ctx, async (tx) => {
    const maskPhones = await prepare(tx, ctx);
    const matches = and([snoozeSql(query), folderSql(query.filter), narrowingSql(query, maskPhones), sessionSql(query),
      query.scope === 'all' ? TRUE : Prisma.sql`c.channel = ${query.scope}`]);
    const raw = await tx.$queryRaw<(RawRow & { matches: boolean })[]>(Prisma.sql`
      SELECT ${ROW_SELECT()}, (${matches}) AS matches FROM ${FROM}
      WHERE c.account_id = ${ctx.accountId}::uuid AND ${Prisma.raw(conversationVisibleSql('c'))} AND ${pickRows}
      ORDER BY c.updated_at DESC, c.id LIMIT ${limit + 1}`);
    const overflow = raw.length > limit;
    const rows = overflow ? raw.slice(0, limit) : raw;
    const found = new Set(rows.map((row) => String(row.id)));
    return {
      conversations: rows.filter((row) => row.matches).map((row) => toListRow(row, maskPhones)),
      removedIds: [...rows.filter((row) => !row.matches).map((row) => String(row.id)), ...wanted.filter((id) => !found.has(id))],
      overflow,
    };
  });
}

/**
 * The ids of the conversations the query matches, in list order, at most
 * `cap + 1` (so the caller can tell the cap was passed). Bulk actions on
 * "every conversation matching" start here.
 */
export async function matchingConversationIds(tx: TenantTransaction, ctx: TenantContext, query: InboxListQuery, cap: number): Promise<string[]> {
  const maskPhones = await prepare(tx, ctx);
  const rows = await tx.$queryRaw<{ id: string }[]>(Prisma.sql`
    SELECT c.id::text AS id FROM ${FROM} WHERE ${listWhere(ctx.accountId, query, maskPhones)}
    ORDER BY c.last_message_at DESC NULLS LAST, c.id LIMIT ${cap + 1}`);
  return rows.map((row) => row.id);
}
