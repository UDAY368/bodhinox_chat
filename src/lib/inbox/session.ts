import type { Message } from '@/types';

export type SessionFilter = 'all' | 'active' | 'expired';
const SESSION_MS = 24 * 60 * 60 * 1000;

export function getSessionWindow(lastCustomerMessageAt: string | null | undefined, now: number) {
  const timestamp = lastCustomerMessageAt ? Date.parse(lastCustomerMessageAt) : NaN;
  const expiresAt = Number.isFinite(timestamp) ? timestamp + SESSION_MS : null;
  const remainingMs = expiresAt === null ? 0 : Math.max(0, expiresAt - now);
  return { active: remainingMs > 0, expiresAt, remainingMs };
}

export function matchesSessionFilter(timestamp: string | null | undefined, filter: SessionFilter, now: number): boolean {
  if (filter === 'all') return true;
  return getSessionWindow(timestamp, now).active === (filter === 'active');
}

/** Business replies do not reopen a session; delayed events cannot rewind it. */
export function latestCustomerMessageAt(current: string | null | undefined, message: Pick<Message, 'sender_type' | 'created_at'>): string | null {
  if (message.sender_type !== 'customer' || !Number.isFinite(Date.parse(message.created_at))) return current ?? null;
  if (current && Date.parse(current) >= Date.parse(message.created_at)) return current;
  return message.created_at;
}
