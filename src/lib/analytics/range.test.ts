import { describe, expect, it } from 'vitest';
import { AnalyticsRangeError, bucketKeys, localDay, localMidnight, MAX_RANGE_DAYS, parseRange, weekStart } from './range';

const now = new Date('2026-11-03T10:30:00Z');

describe('analytics range', () => {
  it('resolves presets to local midnights and ends at now', () => {
    const r = parseRange({ preset: '7d' }, 'Asia/Kolkata', now);
    expect(r).toMatchObject({ preset: '7d', startDay: '2026-10-28', endDay: '2026-11-03', days: 7, bucket: 'day' });
    expect(r.from.toISOString()).toBe('2026-10-27T18:30:00.000Z');
    expect(r.to).toEqual(now);
    expect(parseRange({ preset: 'today' }, 'UTC', now)).toMatchObject({ startDay: '2026-11-03', days: 1 });
    expect(parseRange({}, 'UTC', now)).toMatchObject({ preset: '30d', days: 30 });
  });

  it('uses the workspace day, not the UTC day', () => {
    // 10:30 UTC is already the next day in Auckland.
    expect(parseRange({ preset: 'today' }, 'Pacific/Auckland', new Date('2026-11-03T12:30:00Z')).startDay).toBe('2026-11-04');
  });

  it('handles DST changes in local midnight', () => {
    expect(localMidnight('2026-03-08', 'America/New_York').toISOString()).toBe('2026-03-08T05:00:00.000Z');
    expect(localMidnight('2026-03-09', 'America/New_York').toISOString()).toBe('2026-03-09T04:00:00.000Z');
    expect(localDay(new Date('2026-03-09T03:59:00Z'), 'America/New_York')).toBe('2026-03-08');
  });

  it('accepts custom days, pulls future ends back and clamps long spans', () => {
    const past = parseRange({ from: '2026-01-01', to: '2026-01-31' }, 'UTC', now);
    expect(past).toMatchObject({ preset: 'custom', days: 31, startDay: '2026-01-01', endDay: '2026-01-31' });
    expect(past.to.toISOString()).toBe('2026-02-01T00:00:00.000Z');
    expect(parseRange({ preset: 'custom', from: '2026-11-01', to: '2026-12-31' }, 'UTC', now)).toMatchObject({ endDay: '2026-11-03', days: 3 });
    const long = parseRange({ preset: 'custom', from: '2020-01-01', to: '2026-11-03' }, 'UTC', now);
    expect(long.days).toBe(MAX_RANGE_DAYS);
    expect(long.endDay).toBe('2026-11-03');
    expect(long.bucket).toBe('week');
  });

  it('rejects bad input', () => {
    for (const input of [{ preset: 'year' }, { preset: 'custom', from: '2026-02-30', to: '2026-03-01' }, { from: '2026-05-02', to: '2026-05-01' },
      { from: '2027-01-01', to: '2027-01-02' }, { preset: '7d', bucket: 'month' }, { preset: 'custom', from: '2026-01-01' }])
      expect(() => parseRange(input, 'UTC', now)).toThrow(AnalyticsRangeError);
    expect(() => parseRange({}, 'Mars/Base', now)).toThrow(AnalyticsRangeError);
  });

  it('lists zero-fill bucket keys by day and by ISO week', () => {
    expect(bucketKeys({ startDay: '2026-10-30', endDay: '2026-11-02', bucket: 'day' })).toEqual(['2026-10-30', '2026-10-31', '2026-11-01', '2026-11-02']);
    expect(weekStart('2026-11-01')).toBe('2026-10-26');
    expect(bucketKeys({ startDay: '2026-10-28', endDay: '2026-11-10', bucket: 'week' })).toEqual(['2026-10-26', '2026-11-02', '2026-11-09']);
  });
});
