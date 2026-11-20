import { describe, expect, it } from 'vitest';
import { scheduleLocalToUtc } from './schedule-time';

describe('campaign schedule in the workspace time zone', () => {
  it('reads the picked time in the workspace zone, whatever zone this machine is in', () => {
    // India has no daylight saving: 09:30 IST is 04:00 UTC.
    expect(scheduleLocalToUtc('2026-12-01T09:30', 'Asia/Kolkata')?.toISOString()).toBe('2026-12-01T04:00:00.000Z');
    // New York in summer (EDT, UTC-4) and in winter (EST, UTC-5).
    expect(scheduleLocalToUtc('2026-07-01T09:00', 'America/New_York')?.toISOString()).toBe('2026-07-01T13:00:00.000Z');
    expect(scheduleLocalToUtc('2026-12-01T09:00', 'America/New_York')?.toISOString()).toBe('2026-12-01T14:00:00.000Z');
    // UTC+14 crosses the date line: 08:00 on the 2nd is 18:00 UTC on the 1st.
    expect(scheduleLocalToUtc('2026-12-02T08:00', 'Pacific/Kiritimati')?.toISOString()).toBe('2026-12-01T18:00:00.000Z');
  });

  it('does not depend on the browser zone', () => {
    // Whatever zone runs this test, the same wall time in two zones 5h30m apart is 5h30m apart.
    const india = scheduleLocalToUtc('2026-12-01T09:30', 'Asia/Kolkata')!.getTime();
    const utc = scheduleLocalToUtc('2026-12-01T09:30', 'UTC')!.getTime();
    expect(utc - india).toBe(5.5 * 3_600_000);
  });

  it('accepts seconds and refuses an unreadable value, an unknown zone and a daylight-saving gap', () => {
    expect(scheduleLocalToUtc('2026-12-01T09:30:00', 'UTC')?.toISOString()).toBe('2026-12-01T09:30:00.000Z');
    expect(scheduleLocalToUtc('', 'UTC')).toBeNull();
    expect(scheduleLocalToUtc('2026-12-01 09:30', 'UTC')).toBeNull();
    expect(scheduleLocalToUtc('2026-12-01T09:30', 'Not/AZone')).toBeNull();
    // 02:30 on 8 March 2026 never happens in New York (clocks jump from 02:00 to 03:00).
    expect(scheduleLocalToUtc('2026-03-08T02:30', 'America/New_York')).toBeNull();
  });
});
