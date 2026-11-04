import { describe, expect, it } from 'vitest';
import { AnalyticsRangeError, bucketKeys, localDay, localMidnight, MAX_RANGE_DAYS, parseRange, previousCompletePeriod, weekStart } from './range';

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

  it('resolves calendar presets with weeks starting on Monday in the workspace day', () => {
    // 2026-11-03 is a Tuesday.
    expect(parseRange({ preset: 'this_week' }, 'UTC', now)).toMatchObject({ startDay: '2026-11-02', endDay: '2026-11-03', days: 2 });
    const lastWeek = parseRange({ preset: 'last_week' }, 'UTC', now);
    expect(lastWeek).toMatchObject({ startDay: '2026-10-26', endDay: '2026-11-01', days: 7, bucket: 'day' });
    expect(lastWeek.to.toISOString()).toBe('2026-11-02T00:00:00.000Z');
    expect(parseRange({ preset: 'this_month' }, 'UTC', now)).toMatchObject({ startDay: '2026-11-01', endDay: '2026-11-03', days: 3 });
    expect(parseRange({ preset: 'last_month' }, 'UTC', now)).toMatchObject({ startDay: '2026-10-01', endDay: '2026-10-31', days: 31 });
    // On a Monday, this week is just today and last week ends yesterday.
    const monday = new Date('2026-11-02T12:00:00Z');
    expect(parseRange({ preset: 'this_week' }, 'UTC', monday)).toMatchObject({ startDay: '2026-11-02', days: 1 });
    expect(parseRange({ preset: 'last_week' }, 'UTC', monday)).toMatchObject({ startDay: '2026-10-26', endDay: '2026-11-01' });
    // January: last month is December of the previous year.
    expect(parseRange({ preset: 'last_month' }, 'UTC', new Date('2027-01-15T00:00:00Z'))).toMatchObject({ startDay: '2026-12-01', endDay: '2026-12-31' });
    // The workspace day decides the week: Sunday night in New York is already Monday in UTC.
    expect(parseRange({ preset: 'this_week' }, 'America/New_York', new Date('2026-11-09T02:00:00Z'))).toMatchObject({ startDay: '2026-11-02', endDay: '2026-11-08' });
  });

  it('keeps calendar presets DST-safe', () => {
    // US DST ended on 2026-11-01: last week spans it, so it is 7 days but 169 hours.
    const r = parseRange({ preset: 'last_week' }, 'America/New_York', new Date('2026-11-04T15:00:00Z'));
    expect(r).toMatchObject({ startDay: '2026-10-26', endDay: '2026-11-01', days: 7 });
    expect(r.from.toISOString()).toBe('2026-10-26T04:00:00.000Z');
    expect(r.to.toISOString()).toBe('2026-11-02T05:00:00.000Z');
    // March: this month starts at EST midnight, DST starts on the 8th.
    const march = parseRange({ preset: 'last_month' }, 'America/New_York', new Date('2026-04-02T12:00:00Z'));
    expect(march.from.toISOString()).toBe('2026-03-01T05:00:00.000Z');
    expect(march.to.toISOString()).toBe('2026-04-01T04:00:00.000Z');
  });

  it('gives the previous complete period for each cadence', () => {
    const tz = 'America/New_York';
    const at = new Date('2026-11-04T15:00:00Z');
    expect(previousCompletePeriod('daily', tz, at)).toMatchObject({ startDay: '2026-11-03', endDay: '2026-11-03', days: 1 });
    expect(previousCompletePeriod('daily', tz, at).to.toISOString()).toBe('2026-11-04T05:00:00.000Z');
    expect(previousCompletePeriod('weekly', tz, at)).toMatchObject({ startDay: '2026-10-26', endDay: '2026-11-01' });
    expect(previousCompletePeriod('monthly', tz, at)).toMatchObject({ startDay: '2026-10-01', endDay: '2026-10-31' });
    // Just after local midnight the previous day is complete; just before it, it is not yet.
    expect(previousCompletePeriod('daily', tz, new Date('2026-11-04T05:01:00Z')).startDay).toBe('2026-11-03');
    expect(previousCompletePeriod('daily', tz, new Date('2026-11-04T04:59:00Z')).startDay).toBe('2026-11-02');
    expect(() => previousCompletePeriod('yearly' as 'daily', tz, at)).toThrow(AnalyticsRangeError);
  });
});
