import { expect, it } from 'vitest';

import { previousRange, rangeSummary } from './http';
import { parseRange } from './range';

it('compares "today so far" with yesterday up to the same hour', () => {
  const now = new Date('2026-11-03T09:30:00Z'); // 15:00 in Kolkata
  const today = parseRange({ preset: 'today' }, 'Asia/Kolkata', now);
  const before = previousRange(today);
  expect(rangeSummary(before)).toMatchObject({ startDay: '2026-11-02', endDay: '2026-11-02', days: 1 });
  expect(before.from.toISOString()).toBe('2026-11-01T18:30:00.000Z');
  expect(before.to.toISOString()).toBe('2026-11-02T09:30:00.000Z');
});

it('takes the whole preceding period for a closed custom range, never overlapping it', () => {
  const range = parseRange({ from: '2026-03-01', to: '2026-03-31' }, 'UTC', new Date('2026-11-03T00:00:00Z'));
  const before = previousRange(range);
  expect(rangeSummary(before)).toMatchObject({ startDay: '2026-01-29', endDay: '2026-02-28', days: 31 });
  expect(before.to.getTime()).toBeLessThanOrEqual(range.from.getTime());
});

it('compares last month with the whole previous calendar month', () => {
  const now = new Date('2026-11-04T10:00:00Z');
  const october = previousRange(parseRange({ preset: 'last_month' }, 'UTC', now));
  expect(rangeSummary(october)).toMatchObject({ startDay: '2026-09-01', endDay: '2026-09-30', days: 30 });
  expect(october.to.toISOString()).toBe('2026-10-01T00:00:00.000Z');
  const march = previousRange(parseRange({ preset: 'last_month' }, 'UTC', new Date('2026-04-10T10:00:00Z')));
  expect(rangeSummary(march)).toMatchObject({ startDay: '2026-02-01', endDay: '2026-02-28', days: 28 });
});

it('compares this month so far with the same days of the previous month, up to the same hour', () => {
  const now = new Date('2026-11-04T10:00:00Z');
  const before = previousRange(parseRange({ preset: 'this_month' }, 'UTC', now));
  expect(rangeSummary(before)).toMatchObject({ startDay: '2026-10-01', endDay: '2026-10-04', days: 4 });
  expect(before.to.toISOString()).toBe('2026-10-04T10:00:00.000Z');
  // 31 March so far compares with all of February, never March itself.
  const lateMarch = previousRange(parseRange({ preset: 'this_month' }, 'UTC', new Date('2026-03-31T12:00:00Z')));
  expect(rangeSummary(lateMarch)).toMatchObject({ startDay: '2026-02-01', endDay: '2026-02-28' });
  expect(lateMarch.to.toISOString()).toBe('2026-03-01T00:00:00.000Z');
});

it('compares this week so far with the same weekdays of last week', () => {
  const wednesday = new Date('2026-11-04T10:00:00Z');
  const before = previousRange(parseRange({ preset: 'this_week' }, 'UTC', wednesday));
  expect(rangeSummary(before)).toMatchObject({ startDay: '2026-10-26', endDay: '2026-10-28', days: 3 });
  expect(before.to.toISOString()).toBe('2026-10-28T10:00:00.000Z');
  const lastWeek = previousRange(parseRange({ preset: 'last_week' }, 'UTC', wednesday));
  expect(rangeSummary(lastWeek)).toMatchObject({ startDay: '2026-10-19', endDay: '2026-10-25', days: 7 });
});
