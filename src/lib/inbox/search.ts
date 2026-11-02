import { Prisma } from '@prisma/client';
import type { TenantTransaction } from '@/lib/db/tenant';
import type { AccountRole } from '@/lib/auth/roles';
import { getT } from '@/lib/i18n/translate';
import { displayPhone, shouldMask } from './masking';
import { MAX_MESSAGE_SEARCH_LENGTH, messageSearchVector, normalizeMessageSearch } from './message-search';
import { containsSnippet, SNIPPET_END, SNIPPET_START } from './search-snippet';

/**
 * Inbox message search (GET /api/inbox/search). Three modes:
 *  - fulltext: websearch_to_tsquery on messages_search_idx, ts_headline snippet;
 *  - contains: ILIKE on message text for queries under 3 letters/digits, which
 *    the 'simple' tsvector cannot prefix-match;
 *  - phone: digits-only queries (4+ digits) match message text, and, for members
 *    who see full numbers, the latest message of conversations whose contact
 *    number contains the digits. Masked members never match on contact numbers,
 *    so search cannot be used to probe a hidden number.
 * Results are newest first with a keyset cursor. Every query runs inside the
 * caller's withTenant transaction; RLS and the explicit account_id both scope it.
 */

export type InboxSearchMode = 'fulltext' | 'contains' | 'phone';
export const INBOX_SEARCH_STATUSES = ['open', 'pending', 'closed'] as const;
export type InboxSearchStatus = (typeof INBOX_SEARCH_STATUSES)[number];
export const DEFAULT_INBOX_SEARCH_LIMIT = 20;
export const MAX_INBOX_SEARCH_LIMIT = 50;
/** Per-user budget. Search is read-only but each call can scan an account's messages. */
export const INBOX_SEARCH_RATE_LIMIT = { limit: 30, windowMs: 60_000 } as const;
const STATEMENT_TIMEOUT_MS = 5_000;
const MIN_FULLTEXT_CHARS = 3;
const MIN_PHONE_DIGITS = 4;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HEADLINE_OPTIONS = `StartSel=${SNIPPET_START}, StopSel=${SNIPPET_END}, MaxWords=24, MinWords=8, ShortWord=2, MaxFragments=2, FragmentDelimiter=" … "`;

export interface InboxSearchFilters {
  whatsappConfigId?: string;
  status?: InboxSearchStatus;
  /** A member's user id, or 'unassigned'. */
  assignee?: string;
  from?: Date;
  to?: Date;
}

export interface InboxSearchInput {
  query: string;
  filters: InboxSearchFilters;
  cursor?: { createdAt: Date; id: string };
  limit: number;
}

export interface InboxSearchHit {
  message_id: string;
  conversation_id: string;
  /** Message text with matches wrapped in SNIPPET_START/SNIPPET_END (see search-snippet.ts). */
  snippet: string;
  created_at: string;
  /** Contact name, or the contact's number as this member may see it (masked when required). */
  contact_name: string | null;
}

export interface InboxSearchResult {
  results: InboxSearchHit[];
  next_cursor: string | null;
  mode: InboxSearchMode;
}

export interface InboxSearchContext {
  accountId: string;
  userId: string;
  role: AccountRole;
}

export class InboxSearchError extends Error {
  readonly status = 400;
}

const t = getT('Api.inboxSearch');

export function encodeSearchCursor(createdAt: Date, id: string): string {
  return Buffer.from(JSON.stringify([createdAt.toISOString(), id])).toString('base64url');
}

export function decodeSearchCursor(value: string): { createdAt: Date; id: string } | null {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
    if (!Array.isArray(parsed) || parsed.length !== 2) return null;
    const [at, id] = parsed;
    if (typeof at !== 'string' || typeof id !== 'string' || !uuid.test(id)) return null;
    const createdAt = new Date(at);
    return Number.isNaN(createdAt.getTime()) ? null : { createdAt, id };
  } catch {
    return null;
  }
}

/** Digits of a phone-shaped query ('+91 98765-43210'), or null. */
export function phoneQueryDigits(query: string): string | null {
  if (!/^[+\d\s().-]+$/.test(query)) return null;
  const digits = query.replace(/\D/g, '');
  return digits.length >= MIN_PHONE_DIGITS ? digits : null;
}

export function searchModeFor(query: string): InboxSearchMode {
  if (phoneQueryDigits(query)) return 'phone';
  const meaningful = query.match(/[\p{L}\p{N}]/gu)?.length ?? 0;
  return meaningful < MIN_FULLTEXT_CHARS ? 'contains' : 'fulltext';
}

function likePattern(text: string): string {
  return `%${text.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

function parseDate(value: string | null, key: string): Date | undefined {
  if (value === null || value === '') return undefined;
  const date = new Date(value);
  if (!/^\d{4}-\d{2}-\d{2}/.test(value) || Number.isNaN(date.getTime())) throw new InboxSearchError(t(key));
  return date;
}

/** Validate query-string input. `userId` resolves assignee=me. Throws InboxSearchError (400). */
export function parseInboxSearchParams(params: URLSearchParams, userId: string): InboxSearchInput {
  const raw = params.get('q') ?? '';
  if (raw.length > MAX_MESSAGE_SEARCH_LENGTH * 4) throw new InboxSearchError(t('queryTooLong'));
  const query = normalizeMessageSearch(raw);
  if (!query) throw new InboxSearchError(t('queryRequired'));

  const filters: InboxSearchFilters = {};
  const number = params.get('whatsapp_config_id');
  if (number) {
    if (!uuid.test(number)) throw new InboxSearchError(t('invalidNumber'));
    filters.whatsappConfigId = number;
  }
  const status = params.get('status');
  if (status) {
    if (!(INBOX_SEARCH_STATUSES as readonly string[]).includes(status)) throw new InboxSearchError(t('invalidStatus'));
    filters.status = status as InboxSearchStatus;
  }
  const assignee = params.get('assignee');
  if (assignee) {
    if (assignee === 'me') filters.assignee = userId;
    else if (assignee === 'unassigned' || uuid.test(assignee)) filters.assignee = assignee;
    else throw new InboxSearchError(t('invalidAssignee'));
  }
  filters.from = parseDate(params.get('from'), 'invalidDate');
  filters.to = parseDate(params.get('to'), 'invalidDate');
  if (filters.from && filters.to && filters.from >= filters.to) throw new InboxSearchError(t('invalidDateRange'));

  let cursor: InboxSearchInput['cursor'];
  const rawCursor = params.get('cursor');
  if (rawCursor) {
    cursor = decodeSearchCursor(rawCursor) ?? undefined;
    if (!cursor) throw new InboxSearchError(t('invalidCursor'));
  }

  const rawLimit = params.get('limit');
  let limit = DEFAULT_INBOX_SEARCH_LIMIT;
  if (rawLimit) {
    limit = Number(rawLimit);
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_INBOX_SEARCH_LIMIT) throw new InboxSearchError(t('invalidLimit'));
  }
  return { query, filters, cursor, limit };
}

interface Row {
  message_id: string;
  conversation_id: string;
  created_at: Date;
  snippet: string | null;
  content_text: string | null;
  contact_name: string | null;
  contact_phone: string | null;
}

export async function searchInboxMessages(
  tx: TenantTransaction,
  ctx: InboxSearchContext,
  input: InboxSearchInput,
): Promise<InboxSearchResult> {
  await tx.$queryRaw`SELECT set_config('statement_timeout', ${String(STATEMENT_TIMEOUT_MS)}, true)`;
  const membership = await tx.$queryRaw<{ mask_phone_numbers: boolean }[]>`
    SELECT mask_phone_numbers FROM account_memberships
    WHERE account_id = ${ctx.accountId}::uuid AND user_id = ${ctx.userId}::uuid`;
  // No membership row should be impossible behind a live session; fail closed to masked.
  const mask = membership.length === 0 || shouldMask(ctx.role, membership[0]);

  const mode = searchModeFor(input.query);
  const digits = mode === 'phone' ? phoneQueryDigits(input.query)! : null;
  let match: Prisma.Sql;
  if (mode === 'fulltext') {
    match = Prisma.sql`${messageSearchVector('m')} @@ websearch_to_tsquery('simple', ${input.query})`;
  } else if (mode === 'contains' || mask) {
    match = Prisma.sql`m.content_text ILIKE ${likePattern(input.query)}`;
  } else {
    match = Prisma.sql`(m.content_text ILIKE ${likePattern(input.query)}
      OR (ct.phone_normalized LIKE ${likePattern(digits!)}
          AND m.id = (SELECT m2.id FROM messages m2
                      WHERE m2.account_id = m.account_id AND m2.conversation_id = m.conversation_id
                        AND m2.created_at IS NOT NULL
                      ORDER BY m2.created_at DESC, m2.id DESC LIMIT 1)))`;
  }

  const { filters } = input;
  const conditions: Prisma.Sql[] = [Prisma.sql`m.account_id = ${ctx.accountId}::uuid`, Prisma.sql`m.created_at IS NOT NULL`, match];
  if (filters.whatsappConfigId) conditions.push(Prisma.sql`c.whatsapp_config_id = ${filters.whatsappConfigId}::uuid`);
  if (filters.status) conditions.push(Prisma.sql`c.status = ${filters.status}`);
  if (filters.assignee === 'unassigned') conditions.push(Prisma.sql`c.assigned_agent_id IS NULL`);
  else if (filters.assignee) conditions.push(Prisma.sql`c.assigned_agent_id = ${filters.assignee}::uuid`);
  if (filters.from) conditions.push(Prisma.sql`m.created_at >= ${filters.from}`);
  if (filters.to) conditions.push(Prisma.sql`m.created_at < ${filters.to}`);
  if (input.cursor) conditions.push(Prisma.sql`(m.created_at, m.id) < (${input.cursor.createdAt}::timestamptz, ${input.cursor.id}::uuid)`);

  const snippet = mode === 'fulltext'
    ? Prisma.sql`ts_headline('simple', translate(COALESCE(h.content_text, ''), ${SNIPPET_START + SNIPPET_END}, ''),
        websearch_to_tsquery('simple', ${input.query}), ${HEADLINE_OPTIONS})`
    : Prisma.sql`NULL::text`;

  const rows = await tx.$queryRaw<Row[]>`
    WITH hits AS (
      SELECT m.id, m.conversation_id, m.created_at, m.content_text, ct.name AS contact_name, ct.phone AS contact_phone
      FROM messages m
      JOIN conversations c ON c.account_id = m.account_id AND c.id = m.conversation_id
      JOIN contacts ct ON ct.account_id = c.account_id AND ct.id = c.contact_id
      WHERE ${Prisma.join(conditions, ' AND ')}
      ORDER BY m.created_at DESC, m.id DESC
      LIMIT ${input.limit + 1}
    )
    SELECT h.id AS message_id, h.conversation_id, h.created_at, ${snippet} AS snippet,
      CASE WHEN ${mode === 'fulltext'} THEN NULL ELSE h.content_text END AS content_text,
      h.contact_name, h.contact_phone
    FROM hits h
    ORDER BY h.created_at DESC, h.id DESC`;

  const page = rows.slice(0, input.limit);
  const last = page[page.length - 1];
  return {
    mode,
    next_cursor: rows.length > input.limit && last ? encodeSearchCursor(last.created_at, last.message_id) : null,
    results: page.map((row) => ({
      message_id: row.message_id,
      conversation_id: row.conversation_id,
      created_at: row.created_at.toISOString(),
      snippet: row.snippet ?? containsSnippet(row.content_text, input.query),
      contact_name: row.contact_name?.trim() || displayPhone(row.contact_phone, mask),
    })),
  };
}
