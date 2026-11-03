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
