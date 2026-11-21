import type { Conversation } from '@/types';
import { getSessionWindow } from './session';
import { lifecycleOf } from './lifecycle-view';
export type InboxFilter =
  | Conversation['status']
  | 'all'
  | 'unread'
  | 'waiting'
  | 'unassigned'
  | 'my-team'
  | 'expiring-soon'
  | `lifecycle-${'bot' | 'requesting' | 'assigned' | 'resolved'}`
  /** Stage 5 folders: assigned to me, my favourites, my pending reminders and snoozes, one label. */
  | 'mine'
  | 'favourites'
  | 'reminders'
  /** Conversations whose latest agent or bot message failed (GET /api/inbox/failed). */
  | 'failed'
  | `label-${string}`;
const FILTERS: InboxFilter[] = [
  'all',
  'unread',
  'open',
  'closed',
  'waiting',
  'unassigned',
  'my-team',
  'expiring-soon',
  'lifecycle-bot',
  'lifecycle-requesting',
  'lifecycle-assigned',
  'lifecycle-resolved',
  'mine',
  'favourites',
  'reminders',
  'failed',
];
/** Open, as the UI shows it: 'open', plus legacy rows stored as 'pending'. */
export function isOpenStatus(status: string | null | undefined): boolean {
  return status === 'open' || status === 'pending';
}
const LABEL_FILTER = /^label-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;
export function parseInboxFilter(value: string | null): InboxFilter {
  if (value && LABEL_FILTER.test(value)) return value.toLowerCase() as InboxFilter;
  // "Pending" is never shown: an old ?filter=pending link opens Open, which includes those rows.
  if (value === 'pending') return 'open';
  return FILTERS.includes(value as InboxFilter)
    ? (value as InboxFilter)
    : 'all';
}
/** The label id of a `label-<id>` folder filter, else null. */
export function labelOfFilter(filter: InboxFilter): string | null {
  return LABEL_FILTER.exec(filter)?.[1]?.toLowerCase() ?? null;
}
/** The folder filter of one label. */
export function labelFilter(labelId: string): InboxFilter {
  return `label-${labelId.toLowerCase()}`;
}
/**
 * What the Stage 5 folder filters read, loaded by the inbox (all optional: a
 * folder whose data is not loaded matches nothing).
 */
export interface FolderContext {
  /** The signed-in member, for 'mine'. */
  userId?: string | null;
  /** The member's favourite conversation ids. */
  favouriteIds?: ReadonlySet<string>;
  /** Conversations with one of the member's pending reminders or snoozes. */
  reminderIds?: ReadonlySet<string>;
  /** Label ids per conversation id. */
  labelsByConversation?: ReadonlyMap<string, ReadonlySet<string>>;
  /** Conversations whose latest agent or bot message failed, for 'failed'. */
  failedIds?: ReadonlySet<string>;
}
type QueueConversation = Pick<
  Conversation,
  'status' | 'unread_count' | 'assigned_agent_id' | 'last_customer_message_at'
> & { id?: string; last_reply_at?: string | null; lifecycle_state?: string | null };
export function matchesInboxFilter(
  c: QueueConversation,
  filter: InboxFilter,
  now: number,
  /** Members of the caller's teams (caller included), for 'my-team'. */
  teamMemberIds?: ReadonlySet<string>,
  folders?: FolderContext
): boolean {
  if (filter === 'mine')
    return c.status !== 'closed' && !!folders?.userId && c.assigned_agent_id === folders.userId;
  if (filter === 'favourites') return !!c.id && !!folders?.favouriteIds?.has(c.id);
  if (filter === 'reminders') return !!c.id && !!folders?.reminderIds?.has(c.id);
  if (filter === 'failed') return !!c.id && !!folders?.failedIds?.has(c.id);
  const label = labelOfFilter(filter);
  if (label) return !!c.id && !!folders?.labelsByConversation?.get(c.id)?.has(label);
  const inbound = Date.parse(c.last_customer_message_at ?? '');
  const reply = Date.parse(c.last_reply_at ?? '');
  const waiting =
    c.status !== 'closed' &&
    Number.isFinite(inbound) &&
    (!Number.isFinite(reply) || inbound > reply);
  if (filter === 'waiting') return waiting;
  if (filter === 'my-team')
    return !!c.assigned_agent_id && !!teamMemberIds?.has(c.assigned_agent_id);
  if (filter === 'unassigned')
    return c.status !== 'closed' && !c.assigned_agent_id;
  if (filter === 'expiring-soon') {
    const window = getSessionWindow(c.last_customer_message_at, now);
    return waiting && window.active && window.remainingMs <= 2 * 60 * 60 * 1000;
  }
  if (filter === 'unread') return c.unread_count > 0;
  if (filter.startsWith('lifecycle-'))
    return `lifecycle-${lifecycleOf(c)}` === filter;
  // Open includes legacy rows still stored as 'pending' (the UI never shows that status).
  if (filter === 'open' || filter === 'pending') return isOpenStatus(c.status);
  return filter === 'all' || c.status === filter;
}

/**
 * The inbox's Agent filter (team management): one member, either the chats
 * assigned to them now, or every chat they handled (assigned now, or listed by
 * GET /api/inbox/handled-by: assigned at any time, resolved, or a message they
 * sent). Null shows every agent's chats.
 */
export interface AgentFilter {
  memberId: string;
  mode: 'assigned' | 'handled';
}

// ---------------------------------------------------------------- server-side list query (batch 7)
//
// Everything the conversation list filters by, as one value the browser sends
// to GET /api/inbox/conversations (as query parameters) and to the bulk route.
// The server turns it into SQL (conversation-list.ts); the browser only keeps
// the rows of the pages it loaded.

export type ListConsent = 'any' | 'opted_in' | 'opted_out' | 'none';
export type ListSession = 'all' | 'active' | 'expired';
export type ListChannel = 'whatsapp' | 'instagram';

export interface InboxListQuery {
  /** The inbox page: one channel, or 'all' (the All view). */
  scope: 'all' | ListChannel;
  /** The view or folder (the `?filter=` URL value). */
  filter: InboxFilter;
  /** The All view's channel tab; null for every channel. */
  channel: ListChannel | null;
  /** A WhatsApp number id, 'none' for conversations without one, or null. */
  numberId: string | null;
  agent: AgentFilter | null;
  /** Contact tags, OR-matched. */
  tagIds: string[];
  /** Exact (trimmed) contact company. */
  company: string | null;
  consent: ListConsent;
  /** Name, number, last message, or any message text. */
  search: string;
  session: ListSession;
}

export const DEFAULT_LIST_QUERY: InboxListQuery = {
  scope: 'all',
  filter: 'all',
  channel: null,
  numberId: null,
  agent: null,
  tagIds: [],
  company: null,
  consent: 'any',
  search: '',
  session: 'all',
};

export const MAX_LIST_TAGS = 50;
export const MAX_LIST_TEXT = 200;
const LIST_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CHANNELS: readonly string[] = ['whatsapp', 'instagram'];
const CONSENTS: readonly string[] = ['any', 'opted_in', 'opted_out', 'none'];
const SESSIONS: readonly string[] = ['all', 'active', 'expired'];

/** The query as URL parameters (defaults left out, so equal queries give equal strings). */
export function listQueryParams(query: InboxListQuery): URLSearchParams {
  const params = new URLSearchParams();
  if (query.scope !== 'all') params.set('scope', query.scope);
  if (query.filter !== 'all') params.set('filter', query.filter);
  if (query.channel) params.set('channel', query.channel);
  if (query.numberId) params.set('number', query.numberId);
  if (query.agent) {
    params.set('agent', query.agent.memberId);
    params.set('agentMode', query.agent.mode);
  }
  if (query.tagIds.length) params.set('tags', [...query.tagIds].sort().join(','));
  if (query.company !== null) params.set('company', query.company);
  if (query.consent !== 'any') params.set('consent', query.consent);
  if (query.search.trim()) params.set('q', query.search.trim());
  if (query.session !== 'all') params.set('session', query.session);
  return params;
}

/**
 * The query from URL parameters. Lenient like parseInboxFilter: an unknown or
 * malformed value is left at its default, never passed on.
 */
export function parseListQuery(params: URLSearchParams): InboxListQuery {
  const pick = <T extends string>(value: string | null, allowed: readonly string[], fallback: T): T =>
    value !== null && allowed.includes(value) ? (value as T) : fallback;
  const number = params.get('number');
  const agent = params.get('agent');
  const company = params.get('company');
  return {
    scope: pick(params.get('scope'), CHANNELS, 'all'),
    filter: parseInboxFilter(params.get('filter')),
    channel: CHANNELS.includes(params.get('channel') ?? '') ? (params.get('channel') as ListChannel) : null,
    numberId: number === 'none' ? 'none' : number && LIST_UUID.test(number) ? number.toLowerCase() : null,
    agent: agent && LIST_UUID.test(agent)
      ? { memberId: agent.toLowerCase(), mode: params.get('agentMode') === 'handled' ? 'handled' : 'assigned' }
      : null,
    tagIds: [...new Set((params.get('tags') ?? '').split(',').filter((id) => LIST_UUID.test(id)).map((id) => id.toLowerCase()))]
      .slice(0, MAX_LIST_TAGS),
    company: company !== null && company.trim() ? company.trim().slice(0, MAX_LIST_TEXT) : null,
    consent: pick(params.get('consent'), CONSENTS, 'any'),
    search: (params.get('q') ?? '').trim().slice(0, MAX_LIST_TEXT),
    session: pick(params.get('session'), SESSIONS, 'all'),
  };
}

/** Whether every visible conversation of the inbox (but snoozed ones) matches: no view and no narrowing. */
export function isUnfilteredList(query: InboxListQuery): boolean {
  return listQueryParams({ ...query, scope: 'all' }).size === 0;
}

export function matchesAgentFilter(
  c: { id?: string; assigned_agent_id?: string | null },
  agent: AgentFilter | null,
  /** The ids handled-by returned; while loading, only the current assignee matches. */
  handledIds?: ReadonlySet<string> | null
): boolean {
  if (!agent) return true;
  if (c.assigned_agent_id === agent.memberId) return true;
  return agent.mode === 'handled' && !!c.id && !!handledIds?.has(c.id);
}
