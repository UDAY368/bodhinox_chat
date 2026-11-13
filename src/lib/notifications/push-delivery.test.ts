import { describe, expect, it } from 'vitest';

import { planPushes, pushDedupeKey, PUSH_HOLD_MAX_AGE_MS, type PushEntry } from './push-delivery';
import { quietEndsAt } from './quiet-hours';

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

  it('holds pushes during the member’s quiet hours until they end, except an allowed mention', () => {
    const plan = planPushes([entry({ id: 'a', ...quiet }), entry({ id: 'b', event: 'mention', ...quiet }),
      entry({ id: 'c', event: 'mention', ...quiet, quiet_allow_mentions: false })], now);
    // 22:30 in Kolkata; quiet hours end at 07:00 local = 01:30 UTC the next day.
    const until = new Date('2026-11-14T01:30:00Z');
    expect(plan.hold).toEqual([{ id: 'a', until }, { id: 'c', until }]);
    expect(plan.quiet).toEqual([]);
    expect(plan.send).toEqual([{ userId: 'u1', entryIds: ['b'] }]);
  });

  it('sends a held push once quiet hours end, even after the usual hour', () => {
    const later = new Date('2026-11-14T01:30:00Z');
    const held = entry({ id: 'a', ...quiet, created_at: now, not_before: later });
    expect(planPushes([held], later)).toMatchObject({ send: [{ userId: 'u1', entryIds: ['a'] }], hold: [], quiet: [], skipped: [] });
  });

  it('drops a push the quiet hours would hold for more than 12 hours', () => {
    // Created 6 hours before the window ends 7 hours from now: 13 hours old by then.
    const old = entry({ id: 'a', ...quiet, created_at: new Date(now.getTime() - 6 * 3_600_000 - 30 * 60_000), not_before: now });
    expect(planPushes([old], now)).toMatchObject({ quiet: ['a'], hold: [], send: [] });
    // A held entry released more than 12 hours after it was made is dropped too.
    const release = new Date(now.getTime() + PUSH_HOLD_MAX_AGE_MS + 60_000);
    expect(planPushes([entry({ id: 'b', created_at: now, not_before: release })], release)).toMatchObject({ quiet: ['b'], send: [] });
  });

  it('computes when the quiet window ends, across midnight', () => {
    expect(quietEndsAt({ enabled: true, start: 1320, end: 420, time_zone: 'Asia/Kolkata' }, now)).toEqual(new Date('2026-11-14T01:30:00Z'));
    expect(quietEndsAt({ enabled: true, start: 1320, end: 420, time_zone: 'UTC' }, now)).toBeNull();
    expect(quietEndsAt({ enabled: true, start: 600, end: 1080, time_zone: 'UTC' }, new Date('2026-11-13T10:15:30Z')))
      .toEqual(new Date('2026-11-13T18:00:00Z'));
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
