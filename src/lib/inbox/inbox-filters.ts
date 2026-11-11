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
  | `label-${string}`;
const FILTERS: InboxFilter[] = [
  'all',
  'unread',
  'open',
  'pending',
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
];
const LABEL_FILTER = /^label-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;
export function parseInboxFilter(value: string | null): InboxFilter {
  if (value && LABEL_FILTER.test(value)) return value.toLowerCase() as InboxFilter;
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
  return filter === 'all' || c.status === filter;
}
