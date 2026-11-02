import { describe, expect, it } from 'vitest';
import { isValidTimeZone, isWithinWorkingHours, nextWindowKey, parseWorkingHours } from './working-hours';

// 2026-11-02 is a Monday.
const weekdays = { mon: [{ start: '09:00', end: '18:00' }], tue: [{ start: '09:00', end: '18:00' }] };
const kolkata = { timezone: 'Asia/Kolkata', working_hours: weekdays };

describe('parseWorkingHours', () => {
  it('accepts and sorts valid ranges, dropping empty days', () => {
    expect(parseWorkingHours({ mon: [{ start: '14:00', end: '24:00' }, { start: '09:00', end: '12:00' }], sun: [] }))
      .toEqual({ mon: [{ start: '09:00', end: '12:00' }, { start: '14:00', end: '24:00' }] });
  });
  it.each([
    [null], [[]], [{ funday: [] }], [{ mon: [{ start: '9:00', end: '18:00' }] }],
    [{ mon: [{ start: '18:00', end: '09:00' }] }], [{ mon: [{ start: '09:00', end: '12:00' }, { start: '11:00', end: '13:00' }] }],
    [{ mon: [{ start: '24:00', end: '24:00' }] }], [{ mon: Array(5).fill({ start: '01:00', end: '02:00' }) }],
  ])('rejects %j', (value) => expect(parseWorkingHours(value)).toBeNull());
});

describe('isWithinWorkingHours', () => {
  it('evaluates the local wall clock of the workspace zone', () => {
    // 03:00 UTC = 08:30 IST (closed); 04:00 UTC = 09:30 IST (open).
    expect(isWithinWorkingHours(kolkata, new Date('2026-11-02T03:00:00Z'))).toBe(false);
    expect(isWithinWorkingHours(kolkata, new Date('2026-11-02T04:00:00Z'))).toBe(true);
    // 12:30 UTC = 18:00 IST: end is exclusive.
    expect(isWithinWorkingHours(kolkata, new Date('2026-11-02T12:30:00Z'))).toBe(false);
  });
  it('treats an unconfigured schedule as always open', () => {
    expect(isWithinWorkingHours({ timezone: 'UTC', working_hours: {} }, new Date('2026-11-01T03:00:00Z'))).toBe(true);
  });
  it('treats a missing day as closed and falls back to UTC for a bad zone', () => {
    expect(isWithinWorkingHours({ timezone: 'Not/AZone', working_hours: weekdays }, new Date('2026-11-04T10:00:00Z'))).toBe(false);
    expect(isWithinWorkingHours({ timezone: 'Not/AZone', working_hours: weekdays }, new Date('2026-11-02T10:00:00Z'))).toBe(true);
  });
  it('handles a range ending at midnight', () => {
    const late = { timezone: 'UTC', working_hours: { mon: [{ start: '22:00', end: '24:00' }] } };
    expect(isWithinWorkingHours(late, new Date('2026-11-02T23:59:00Z'))).toBe(true);
    expect(isWithinWorkingHours(late, new Date('2026-11-03T00:00:00Z'))).toBe(false);
  });
});

describe('nextWindowKey', () => {
  it('is null inside working hours', () => {
    expect(nextWindowKey(kolkata, new Date('2026-11-02T05:00:00Z'))).toBeNull();
  });
  it('gives every moment of one closed stretch the same key', () => {
    const evening = nextWindowKey(kolkata, new Date('2026-11-02T13:00:00Z'));
    const night = nextWindowKey(kolkata, new Date('2026-11-02T22:00:00Z'));
    expect(evening).toBe('open:2026-11-03T09:00');
    expect(night).toBe(evening);
    expect(nextWindowKey(kolkata, new Date('2026-11-02T03:00:00Z'))).toBe('open:2026-11-02T09:00');
  });
  it('skips closed days, across the week', () => {
    expect(nextWindowKey(kolkata, new Date('2026-11-03T13:00:00Z'))).toBe('open:2026-11-09T09:00');
  });
  it('wraps to the same weekday next week', () => {
    const odd = { timezone: 'UTC', working_hours: { mon: [{ start: '00:00', end: '01:00' }] } };
    expect(nextWindowKey(odd, new Date('2026-11-02T12:00:00Z'))).toBe('open:2026-11-09T00:00');
  });
});

describe('isValidTimeZone', () => {
  it('accepts IANA zones and rejects junk', () => {
    expect(isValidTimeZone('Asia/Kolkata')).toBe(true);
    expect(isValidTimeZone('Mars/Base')).toBe(false);
    expect(isValidTimeZone(42)).toBe(false);
  });
});
