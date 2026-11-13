import { describe, expect, it } from 'vitest';

import { planPushes, pushDedupeKey, type PushEntry } from './push-delivery';

const now = new Date('2026-11-13T17:00:00Z'); // 22:30 in Asia/Kolkata
const entry = (patch: Partial<PushEntry>): PushEntry => ({
  id: 'e1', user_id: 'u1', event: 'assigned_message', created_at: new Date(now.getTime() - 60_000), read: false, wants_push: true,
  quiet_enabled: null, quiet_start: null, quiet_end: null, quiet_time_zone: null, quiet_allow_mentions: null, ...patch,
});
const quiet = { quiet_enabled: true, quiet_start: 1320, quiet_end: 420, quiet_time_zone: 'Asia/Kolkata', quiet_allow_mentions: true };

describe('planPushes', () => {
  it('wakes each member once for all their entries', () => {
    const plan = planPushes([entry({ id: 'a' }), entry({ id: 'b' }), entry({ id: 'c', user_id: 'u2' })], now);
    expect(plan.send).toEqual([{ userId: 'u1', entryIds: ['a', 'b'] }, { userId: 'u2', entryIds: ['c'] }]);
    expect(plan.quiet).toEqual([]);
    expect(plan.skipped).toEqual([]);
  });

  it('holds pushes back during the member’s quiet hours, except an allowed mention', () => {
    const plan = planPushes([entry({ id: 'a', ...quiet }), entry({ id: 'b', event: 'mention', ...quiet }),
      entry({ id: 'c', event: 'mention', ...quiet, quiet_allow_mentions: false })], now);
    expect(plan.quiet).toEqual(['a', 'c']);
    expect(plan.send).toEqual([{ userId: 'u1', entryIds: ['b'] }]);
  });

  it('skips read, switched-off and stale entries', () => {
    const plan = planPushes([entry({ id: 'a', read: true }), entry({ id: 'b', wants_push: false }),
      entry({ id: 'c', created_at: new Date(now.getTime() - 2 * 60 * 60 * 1000) })], now);
    expect(plan.skipped).toEqual(['a', 'b', 'c']);
    expect(plan.send).toEqual([]);
  });

  it('schedules one job per workspace per 30-second window', () => {
    expect(pushDedupeKey('acc', 30_000)).toBe(pushDedupeKey('acc', 59_999));
    expect(pushDedupeKey('acc', 60_000)).not.toBe(pushDedupeKey('acc', 59_999));
  });
});
