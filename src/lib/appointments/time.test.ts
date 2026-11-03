import { describe, expect, it } from 'vitest';
import { hhmmOf, isCalendarDate, isoWeekday, localParts, minutesOf, weekdayKey, zonedWallToUtc } from './time';

const iso = (d: Date | null) => d?.toISOString() ?? null;

describe('zonedWallToUtc', () => {
  it('Asia/Kolkata: Monday 00:30 IST is Sunday 19:00 UTC and counts as Monday', () => {
    const at = zonedWallToUtc('2026-11-09', '00:30', 'Asia/Kolkata');
    expect(iso(at)).toBe('2026-11-08T19:00:00.000Z');
    expect(new Date(at!).getUTCDay()).toBe(0); // Sunday in UTC
    expect(localParts(at!, 'Asia/Kolkata')).toEqual({ date: '2026-11-09', hhmm: '00:30', isoWeekday: 1 });
  });

  it('America/Sao_Paulo has no DST (UTC-3 all year)', () => {
    expect(iso(zonedWallToUtc('2026-01-15', '10:00', 'America/Sao_Paulo'))).toBe('2026-01-15T13:00:00.000Z');
    expect(iso(zonedWallToUtc('2026-07-15', '10:00', 'America/Sao_Paulo'))).toBe('2026-07-15T13:00:00.000Z');
  });

  it('America/New_York spring-forward gap returns null', () => {
    expect(zonedWallToUtc('2026-03-08', '02:30', 'America/New_York')).toBeNull();
    expect(iso(zonedWallToUtc('2026-03-08', '03:00', 'America/New_York'))).toBe('2026-03-08T07:00:00.000Z');
  });

  it('America/New_York fall-back fold returns the earlier instant', () => {
    expect(iso(zonedWallToUtc('2026-11-01', '01:30', 'America/New_York'))).toBe('2026-11-01T05:30:00.000Z');
  });

  it('Europe/London fall-back fold returns the earlier instant (BST)', () => {
    expect(iso(zonedWallToUtc('2026-10-25', '01:30', 'Europe/London'))).toBe('2026-10-25T00:30:00.000Z');
  });

  it('Pacific/Kiritimati (+14): local Monday is the UTC Sunday', () => {
    const at = zonedWallToUtc('2026-11-09', '09:00', 'Pacific/Kiritimati')!;
    expect(at.toISOString()).toBe('2026-11-08T19:00:00.000Z');
    expect(localParts(at, 'Pacific/Kiritimati').isoWeekday).toBe(1);
  });

  it('Pacific/Pago_Pago (-11): local Monday evening is the UTC Tuesday', () => {
    const at = zonedWallToUtc('2026-11-09', '20:00', 'Pacific/Pago_Pago')!;
    expect(at.toISOString()).toBe('2026-11-10T07:00:00.000Z');
    expect(at.getUTCDay()).toBe(2);
    expect(localParts(at, 'Pacific/Pago_Pago').isoWeekday).toBe(1);
  });

  it('24:00 is the next local day 00:00', () => {
    expect(iso(zonedWallToUtc('2026-11-09', '24:00', 'Asia/Kolkata'))).toBe(iso(zonedWallToUtc('2026-11-10', '00:00', 'Asia/Kolkata')));
  });

  it('rejects malformed input', () => {
    expect(zonedWallToUtc('2026-13-40x', '10:00', 'UTC')).toBeNull();
    expect(zonedWallToUtc('2026-11-09', '25:00', 'UTC')).toBeNull();
  });

  it('a 24h reminder across a DST change is exactly 86 400 000 ms before start', () => {
    // Start Sunday 2026-03-08 10:00 EDT; 24h earlier in absolute time is Saturday 09:00 EST.
    const start = zonedWallToUtc('2026-03-08', '10:00', 'America/New_York')!;
    const reminder = new Date(start.getTime() - 24 * 3600_000);
    expect(start.getTime() - reminder.getTime()).toBe(86_400_000);
    expect(localParts(reminder, 'America/New_York')).toMatchObject({ date: '2026-03-07', hhmm: '09:00' });
  });
});

describe('weekday helpers', () => {
  it('reads the weekday from the local date string', () => {
    expect(isoWeekday('2026-11-09')).toBe(1);
    expect(isoWeekday('2026-11-15')).toBe(7);
    expect(weekdayKey('2026-11-09')).toBe('mon');
    expect(weekdayKey('2026-11-15')).toBe('sun');
  });

  it('converts minutes', () => {
    expect(minutesOf('09:30')).toBe(570);
    expect(minutesOf('24:00')).toBe(1440);
    expect(hhmmOf(570)).toBe('09:30');
  });
});

describe('isCalendarDate', () => {
  it('accepts real dates and refuses impossible or out-of-range ones', async () => {
    expect(isCalendarDate('2026-02-28')).toBe(true);
    expect(isCalendarDate('2028-02-29')).toBe(true);
    expect(isCalendarDate('2026-02-29')).toBe(false);
    expect(isCalendarDate('2026-02-30')).toBe(false);
    expect(isCalendarDate('2026-13-01')).toBe(false);
    expect(isCalendarDate('2026-00-10')).toBe(false);
    expect(isCalendarDate('9999-12-31')).toBe(false);
    expect(isCalendarDate('1969-12-31')).toBe(false);
    expect(isCalendarDate('2026-1-01')).toBe(false);
    expect(isCalendarDate(undefined)).toBe(false);
  });
});
