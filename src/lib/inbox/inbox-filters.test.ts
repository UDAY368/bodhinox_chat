import { describe, expect, it } from 'vitest';
import { matchesInboxFilter, parseInboxFilter } from './inbox-filters';
const now = Date.parse('2026-10-24T12:00:00Z');
const conversation = {
  status: 'open' as const,
  unread_count: 0,
  last_customer_message_at: '2026-10-23T13:00:00Z',
  last_reply_at: null,
};
describe('operational inbox queues', () => {
  it('requires a newer customer message than a real reply', () => {
    expect(matchesInboxFilter(conversation, 'waiting', now)).toBe(true);
    expect(
      matchesInboxFilter(
        { ...conversation, last_reply_at: '2026-10-24T11:00:00Z' },
        'waiting',
        now
      )
    ).toBe(false);
    expect(
      matchesInboxFilter({ ...conversation, status: 'closed' }, 'waiting', now)
    ).toBe(false);
  });
  it('only expires waiting chats within a live two hour window', () => {
    expect(matchesInboxFilter(conversation, 'expiring-soon', now)).toBe(true);
    expect(
      matchesInboxFilter(conversation, 'expiring-soon', now + 3600000)
    ).toBe(false);
    expect(
      matchesInboxFilter(
        { ...conversation, last_customer_message_at: '2026-10-24T11:00:00Z' },
        'expiring-soon',
        now
      )
    ).toBe(false);
  });
  it('unassigned excludes closed chats and validates URL values', () => {
    expect(matchesInboxFilter(conversation, 'unassigned', now)).toBe(true);
    expect(
      matchesInboxFilter(
        { ...conversation, assigned_agent_id: 'agent' },
        'unassigned',
        now
      )
    ).toBe(false);
    expect(parseInboxFilter('bogus')).toBe('all');
  });
});

describe('my-team filter', () => {
  const base = { status: 'open' as const, unread_count: 0, last_customer_message_at: undefined };
  it('matches conversations assigned to a teammate only', () => {
    const team = new Set(['a', 'b']);
    expect(parseInboxFilter('my-team')).toBe('my-team');
    expect(matchesInboxFilter({ ...base, assigned_agent_id: 'a' }, 'my-team', 0, team)).toBe(true);
    expect(matchesInboxFilter({ ...base, assigned_agent_id: 'c' }, 'my-team', 0, team)).toBe(false);
    expect(matchesInboxFilter({ ...base, assigned_agent_id: undefined }, 'my-team', 0, team)).toBe(false);
    expect(matchesInboxFilter({ ...base, assigned_agent_id: 'a' }, 'my-team', 0)).toBe(false);
  });
});

describe('the Failed folder', () => {
  it('is a known filter and matches only the conversations whose last outbound message failed', () => {
    expect(parseInboxFilter('failed')).toBe('failed');
    const failedIds = new Set(['c1']);
    expect(matchesInboxFilter({ ...conversation, id: 'c1' }, 'failed', now, undefined, { failedIds })).toBe(true);
    expect(matchesInboxFilter({ ...conversation, id: 'c2' }, 'failed', now, undefined, { failedIds })).toBe(false);
    // Before the list loads nothing matches.
    expect(matchesInboxFilter({ ...conversation, id: 'c1' }, 'failed', now)).toBe(false);
  });
});
