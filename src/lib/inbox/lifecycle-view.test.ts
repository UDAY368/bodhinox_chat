import { describe, expect, it } from 'vitest';
import {
  compactDuration,
  firstResponseSla,
  isLifecycleState,
  lifecycleOf,
} from './lifecycle-view';
import { matchesInboxFilter, parseInboxFilter } from './inbox-filters';

const NOW = Date.parse('2026-11-02T12:00:00Z');

describe('lifecycleOf', () => {
  it('reads the stored state and lets status and assignee win', () => {
    expect(lifecycleOf({ status: 'open', lifecycle_state: 'bot' })).toBe('bot');
    expect(lifecycleOf({ status: 'open', lifecycle_state: 'requesting' })).toBe('requesting');
    expect(lifecycleOf({ status: 'closed', lifecycle_state: 'bot' })).toBe('resolved');
    expect(lifecycleOf({ status: 'open', assigned_agent_id: 'u1', lifecycle_state: 'requesting' })).toBe('assigned');
    // A local reopen before the realtime row arrives.
    expect(lifecycleOf({ status: 'open', lifecycle_state: 'resolved' })).toBe('requesting');
    expect(lifecycleOf({ status: 'pending' })).toBe('requesting');
  });

  it('validates state names', () => {
    expect(isLifecycleState('bot')).toBe(true);
    expect(isLifecycleState('closed')).toBe(false);
  });
});

describe('firstResponseSla', () => {
  const base = { status: 'open' as const, lifecycle_state: 'requesting' };

  it('counts down until due and reports a breach after', () => {
    expect(
      firstResponseSla({ ...base, first_response_due_at: '2026-11-02T12:30:00Z' }, NOW)
    ).toEqual({ kind: 'due', msLeft: 30 * 60_000, dueAt: '2026-11-02T12:30:00Z' });
    expect(
      firstResponseSla({ ...base, first_response_due_at: '2026-11-02T10:00:00Z' }, NOW)
    ).toMatchObject({ kind: 'breached', msOver: 2 * 3_600_000 });
  });

  it('is silent once answered, resolved, bot-owned or without a due time', () => {
    const due = { first_response_due_at: '2026-11-02T10:00:00Z' };
    expect(firstResponseSla({ ...base, ...due, first_responded_at: '2026-11-02T09:00:00Z' }, NOW)).toBeNull();
    expect(firstResponseSla({ ...base, ...due, status: 'closed' }, NOW)).toBeNull();
    expect(firstResponseSla({ ...base, ...due, lifecycle_state: 'bot' }, NOW)).toBeNull();
    expect(firstResponseSla(base, NOW)).toBeNull();
    expect(firstResponseSla({ ...base, first_response_due_at: 'nope' }, NOW)).toBeNull();
  });
});

describe('compactDuration', () => {
  it('rounds up to minutes, hours, then days', () => {
    expect(compactDuration(10_000)).toEqual({ value: 1, unit: 'm' });
    expect(compactDuration(59 * 60_000)).toEqual({ value: 59, unit: 'm' });
    expect(compactDuration(61 * 60_000)).toEqual({ value: 2, unit: 'h' });
    expect(compactDuration(72 * 3_600_000)).toEqual({ value: 3, unit: 'd' });
  });
});

describe('lifecycle inbox filters', () => {
  const conv = {
    status: 'open' as const,
    unread_count: 0,
    last_customer_message_at: null,
    lifecycle_state: 'bot',
  };

  it('parses lifecycle filter values from the URL', () => {
    expect(parseInboxFilter('lifecycle-bot')).toBe('lifecycle-bot');
    expect(parseInboxFilter('lifecycle-nope')).toBe('all');
  });

  it('matches conversations by lifecycle state', () => {
    expect(matchesInboxFilter(conv, 'lifecycle-bot', NOW)).toBe(true);
    expect(matchesInboxFilter(conv, 'lifecycle-requesting', NOW)).toBe(false);
    expect(matchesInboxFilter({ ...conv, status: 'closed' }, 'lifecycle-resolved', NOW)).toBe(true);
    expect(matchesInboxFilter({ ...conv, assigned_agent_id: 'u1' }, 'lifecycle-assigned', NOW)).toBe(true);
  });
});
