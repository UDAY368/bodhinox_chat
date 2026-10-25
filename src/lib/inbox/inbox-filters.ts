import type { Conversation } from '@/types';
import { getSessionWindow } from './session';
export type InboxFilter =
  | Conversation['status']
  | 'all'
  | 'unread'
  | 'waiting'
  | 'unassigned'
  | 'expiring-soon';
const FILTERS: InboxFilter[] = [
  'all',
  'unread',
  'open',
  'pending',
  'closed',
  'waiting',
  'unassigned',
  'expiring-soon',
];
export function parseInboxFilter(value: string | null): InboxFilter {
  return FILTERS.includes(value as InboxFilter)
    ? (value as InboxFilter)
    : 'all';
}
type QueueConversation = Pick<
  Conversation,
  'status' | 'unread_count' | 'assigned_agent_id' | 'last_customer_message_at'
> & { last_reply_at?: string | null };
export function matchesInboxFilter(
  c: QueueConversation,
  filter: InboxFilter,
  now: number
): boolean {
  const inbound = Date.parse(c.last_customer_message_at ?? '');
  const reply = Date.parse(c.last_reply_at ?? '');
  const waiting =
    c.status !== 'closed' &&
    Number.isFinite(inbound) &&
    (!Number.isFinite(reply) || inbound > reply);
  if (filter === 'waiting') return waiting;
  if (filter === 'unassigned')
    return c.status !== 'closed' && !c.assigned_agent_id;
  if (filter === 'expiring-soon') {
    const window = getSessionWindow(c.last_customer_message_at, now);
    return waiting && window.active && window.remainingMs <= 2 * 60 * 60 * 1000;
  }
  if (filter === 'unread') return c.unread_count > 0;
  return filter === 'all' || c.status === filter;
}
