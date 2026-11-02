// Client-safe helpers for showing a conversation's Phase 5 lifecycle and
// first-response SLA. The database trigger owns the real state; these only
// read it (with a fallback for rows loaded before the column existed).
import type { Conversation, ConversationLifecycleState } from '@/types';

export const LIFECYCLE_STATES: readonly ConversationLifecycleState[] = [
  'bot',
  'requesting',
  'assigned',
  'resolved',
];

export function isLifecycleState(value: unknown): value is ConversationLifecycleState {
  return (LIFECYCLE_STATES as readonly unknown[]).includes(value);
}

type LifecycleSource = Pick<Conversation, 'status' | 'assigned_agent_id'> & {
  lifecycle_state?: string | null;
};

/** The conversation's lifecycle state, derived like the backfill when the column is absent. */
export function lifecycleOf(c: LifecycleSource): ConversationLifecycleState {
  // A closed row is always resolved and an assignee always means assigned,
  // whatever an optimistic local patch left in lifecycle_state.
  if (c.status === 'closed') return 'resolved';
  if (c.assigned_agent_id) return 'assigned';
  if (c.lifecycle_state === 'bot' || c.lifecycle_state === 'requesting') return c.lifecycle_state;
  return 'requesting';
}

export type FirstResponseSla =
  | { kind: 'due'; msLeft: number; dueAt: string }
  | { kind: 'breached'; msOver: number; dueAt: string };

type SlaSource = LifecycleSource &
  Pick<Conversation, 'first_response_due_at' | 'first_responded_at'>;

/**
 * First-response SLA for an open conversation still waiting on its first
 * agent reply. Null when there is no due time, it was answered, it is
 * resolved, or the bot owns it.
 */
export function firstResponseSla(c: SlaSource, now: number): FirstResponseSla | null {
  const state = lifecycleOf(c);
  if (state === 'resolved' || state === 'bot') return null;
  if (c.first_responded_at || !c.first_response_due_at) return null;
  const due = Date.parse(c.first_response_due_at);
  if (!Number.isFinite(due)) return null;
  return due > now
    ? { kind: 'due', msLeft: due - now, dueAt: c.first_response_due_at }
    : { kind: 'breached', msOver: now - due, dueAt: c.first_response_due_at };
}

/** Compact duration such as `45m`, `3h` or `2d`, rounded up to the unit. */
export function compactDuration(ms: number): { value: number; unit: 'm' | 'h' | 'd' } {
  const minutes = Math.max(1, Math.ceil(ms / 60_000));
  if (minutes < 60) return { value: minutes, unit: 'm' };
  const hours = Math.ceil(minutes / 60);
  if (hours < 48) return { value: hours, unit: 'h' };
  return { value: Math.ceil(hours / 24), unit: 'd' };
}
