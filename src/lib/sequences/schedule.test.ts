import { describe, expect, it } from 'vitest';
import {
  delayMs,
  dueAt,
  exceedsInstagramWindow,
  moveItem,
  parseDelay,
  ratePercent,
  reorderPositions,
  SEQUENCE_MAX_DELAY_MINUTES,
} from './schedule';

describe('sequence schedule maths', () => {
  it('counts minutes, hours and days from the given moment', () => {
    const from = new Date('2026-11-11T23:30:00.000Z');
    expect(dueAt(from, { amount: 0, unit: 'minutes' }).toISOString()).toBe('2026-11-11T23:30:00.000Z');
    expect(dueAt(from, { amount: 45, unit: 'minutes' }).toISOString()).toBe('2026-11-12T00:15:00.000Z');
    expect(dueAt(from, { amount: 2, unit: 'hours' }).toISOString()).toBe('2026-11-12T01:30:00.000Z');
    expect(dueAt(from, { amount: 3, unit: 'days' }).toISOString()).toBe('2026-11-14T23:30:00.000Z');
  });

  it('accepts whole delays from 0 up to 365 days only', () => {
    expect(parseDelay(0, 'minutes')).toEqual({ amount: 0, unit: 'minutes' });
    expect(parseDelay(365, 'days')).toEqual({ amount: 365, unit: 'days' });
    expect(parseDelay(SEQUENCE_MAX_DELAY_MINUTES, 'minutes')).not.toBeNull();
    expect(parseDelay(366, 'days')).toBeNull();
    expect(parseDelay(8761, 'hours')).toBeNull();
    for (const [amount, unit] of [[-1, 'days'], [1.5, 'hours'], ['2', 'days'], [1, 'weeks'], [null, 'days']] as const)
      expect(parseDelay(amount, unit), `${amount} ${unit}`).toBeNull();
  });

  it('flags delays that can outlast the Instagram 24-hour window', () => {
    expect(exceedsInstagramWindow({ amount: 24, unit: 'hours' })).toBe(false);
    expect(exceedsInstagramWindow({ amount: 1, unit: 'days' })).toBe(false);
    expect(exceedsInstagramWindow({ amount: 1441, unit: 'minutes' })).toBe(true);
    expect(exceedsInstagramWindow({ amount: 2, unit: 'days' })).toBe(true);
    expect(delayMs({ amount: 1, unit: 'days' })).toBe(86_400_000);
  });

  it('reorders only when every message is named exactly once', () => {
    expect([...reorderPositions(['a', 'b', 'c'], ['c', 'a', 'b'])!]).toEqual([['c', 0], ['a', 1], ['b', 2]]);
    expect(reorderPositions(['a', 'b'], ['a'])).toBeNull();
    expect(reorderPositions(['a', 'b'], ['a', 'a'])).toBeNull();
    expect(reorderPositions(['a', 'b'], ['a', 'x'])).toBeNull();
    expect(reorderPositions(['a'], 'a')).toBeNull();
    expect(reorderPositions([], [])).toEqual(new Map());
  });

  it('moves one item up or down for keyboard reordering', () => {
    expect(moveItem(['a', 'b', 'c'], 1, -1)).toEqual(['b', 'a', 'c']);
    expect(moveItem(['a', 'b', 'c'], 1, 1)).toEqual(['a', 'c', 'b']);
    expect(moveItem(['a', 'b'], 0, -1)).toEqual(['a', 'b']);
    expect(moveItem(['a', 'b'], 1, 1)).toEqual(['a', 'b']);
  });

  it('shows a rate only when something was counted', () => {
    expect(ratePercent(0, 0)).toBeNull();
    expect(ratePercent(1, 3)).toBe(33);
    expect(ratePercent(2, 3)).toBe(67);
    expect(ratePercent(5, 4)).toBe(100);
  });
});
