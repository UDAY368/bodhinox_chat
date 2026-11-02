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
  | `lifecycle-${'bot' | 'requesting' | 'assigned' | 'resolved'}`;
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
];
export function parseInboxFilter(value: string | null): InboxFilter {
  return FILTERS.includes(value as InboxFilter)
    ? (value as InboxFilter)
    : 'all';
}
type QueueConversation = Pick<
  Conversation,
  'status' | 'unread_count' | 'assigned_agent_id' | 'last_customer_message_at'
> & { last_reply_at?: string | null; lifecycle_state?: string | null };
export function matchesInboxFilter(
  c: QueueConversation,
  filter: InboxFilter,
  now: number,
  /** Members of the caller's teams (caller included), for 'my-team'. */
  teamMemberIds?: ReadonlySet<string>
): boolean {
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
