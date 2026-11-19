import { describe, expect, it } from 'vitest';

import { formatDate } from './date';

const now = new Date('2026-11-19T10:00:00Z');
const at = '2026-10-12T09:15:00Z'; // 2:45 pm in Asia/Kolkata
const tz = 'Asia/Kolkata';

describe('formatDate', () => {
  it("'date' omits the year this year and adds it otherwise", () => {
    expect(formatDate(at, { now, timeZone: tz })).toBe('12 Oct');
    expect(formatDate('2025-10-12T09:15:00Z', { now, timeZone: tz })).toBe('12 Oct 2025');
  });

  it("'day', 'time' and 'datetime'", () => {
    expect(formatDate(at, { style: 'day', now, timeZone: tz })).toBe('12 Oct 2026');
    expect(formatDate(at, { style: 'time', timeZone: tz })).toBe('2:45 pm');
    expect(formatDate(at, { style: 'datetime', now, timeZone: tz })).toBe('12 Oct, 2:45 pm');
  });

  it('follows the time zone and the locale', () => {
    expect(formatDate(at, { style: 'time', timeZone: 'UTC' })).toBe('9:15 am');
    expect(formatDate('2026-10-12T20:00:00Z', { style: 'day', timeZone: 'Asia/Tokyo' })).toBe('13 Oct 2026');
    expect(formatDate(at, { style: 'datetime', now, timeZone: 'UTC', locale: 'en-US' })).toBe('Oct 12, 9:15 AM');
  });

  it("'relative' up to a week, then the date", () => {
    const ago = (ms: number) => new Date(now.getTime() - ms);
    expect(formatDate(ago(20_000), { style: 'relative', now })).toBe('now');
    expect(formatDate(ago(5 * 60_000), { style: 'relative', now })).toBe('5 min ago');
    expect(formatDate(ago(26 * 3_600_000), { style: 'relative', now })).toBe('yesterday');
    expect(formatDate(new Date(now.getTime() + 2 * 3_600_000), { style: 'relative', now })).toBe('in 2 hr');
    expect(formatDate(ago(10 * 86_400_000), { style: 'relative', now, timeZone: 'UTC' })).toBe('9 Nov');
  });

  it('is total: invalid input, locale or time zone never throws', () => {
    expect(formatDate('nope')).toBe('');
    expect(formatDate(null)).toBe('');
    expect(formatDate(undefined)).toBe('');
    expect(formatDate('')).toBe('');
    expect(formatDate(new Date(Number.NaN))).toBe('');
    expect(formatDate(at, { style: 'day', locale: 'xx-invalid-!!', timeZone: 'UTC' })).toBe('12 Oct 2026');
    expect(formatDate(at, { style: 'day', timeZone: 'Not/AZone' })).toMatch(/Oct 2026$/);
  });

  it('accepts epoch milliseconds and Date objects', () => {
    const ms = Date.parse(at);
    expect(formatDate(ms, { style: 'day', timeZone: tz })).toBe('12 Oct 2026');
    expect(formatDate(new Date(ms), { style: 'day', timeZone: tz })).toBe('12 Oct 2026');
  });
});
