import { describe, expect, it } from 'vitest';

import { formatClock, inQuietWindow, isQuietFor, localMinutes, parseClock, parseQuietHours, QuietHoursError } from './quiet-hours';
import { heldByQuietHours } from './digest';

const overnight = { enabled: true, start: 22 * 60, end: 7 * 60, time_zone: 'Asia/Kolkata', allow_mentions: true };
// 2026-11-13 17:00Z is 22:30 in Kolkata (UTC+5:30); 02:00Z is 07:30.
const lateEvening = new Date('2026-11-13T17:00:00Z');
const morning = new Date('2026-11-13T02:00:00Z');

describe('quiet hours', () => {
  it('parses and formats HH:MM clocks', () => {
    expect(parseClock('22:30')).toBe(1350);
    expect(parseClock('24:00')).toBeNull();
    expect(parseClock('7:00')).toBeNull();
    expect(formatClock(1350)).toBe('22:30');
    expect(formatClock(0)).toBe('00:00');
  });

  it('reads local time in the member’s own time zone', () => {
    expect(localMinutes(lateEvening, 'Asia/Kolkata')).toBe(22 * 60 + 30);
    expect(localMinutes(lateEvening, 'UTC')).toBe(17 * 60);
    expect(localMinutes(lateEvening, 'Not/AZone')).toBe(17 * 60);
  });

  it('handles a window that crosses midnight', () => {
    expect(inQuietWindow(overnight, lateEvening)).toBe(true);
    expect(inQuietWindow(overnight, morning)).toBe(false);
    expect(inQuietWindow({ ...overnight, enabled: false }, lateEvening)).toBe(false);
  });

  it('handles a same-day window', () => {
    const lunch = { ...overnight, start: 22 * 60, end: 23 * 60 };
    expect(inQuietWindow(lunch, lateEvening)).toBe(true);
    expect(inQuietWindow({ ...lunch, start: 23 * 60, end: 23 * 60 + 30 }, lateEvening)).toBe(false);
  });

  it('lets mentions through only when the member allows it', () => {
    expect(isQuietFor(overnight, 'mention', lateEvening)).toBe(false);
    expect(isQuietFor(overnight, 'assigned_message', lateEvening)).toBe(true);
    expect(isQuietFor({ ...overnight, allow_mentions: false }, 'mention', lateEvening)).toBe(true);
    expect(isQuietFor(null, 'assigned_message', lateEvening)).toBe(false);
  });

  it('validates a saved window strictly', () => {
    expect(parseQuietHours({ enabled: true, start: '22:00', end: '07:00', time_zone: 'Asia/Kolkata', allow_mentions: false }))
      .toEqual({ enabled: true, start: 1320, end: 420, time_zone: 'Asia/Kolkata', allow_mentions: false });
    for (const bad of [
      null, [], { enabled: true, start: '22:00', end: '22:00', time_zone: 'UTC', allow_mentions: true },
      { enabled: 'yes', start: '22:00', end: '07:00', time_zone: 'UTC', allow_mentions: true },
      { enabled: true, start: '22:00', end: '07:00', time_zone: 'x'.repeat(65), allow_mentions: true },
      { enabled: true, start: '22:00', end: '07:00', time_zone: 'UTC', allow_mentions: true, extra: 1 },
    ]) expect(() => parseQuietHours(bad), JSON.stringify(bad)).toThrow(QuietHoursError);
  });

  it('holds email digest entries back during quiet hours, except allowed mentions', () => {
    const row = { quiet_enabled: true, quiet_start: 1320, quiet_end: 420, quiet_time_zone: 'Asia/Kolkata', quiet_allow_mentions: true };
    expect(heldByQuietHours({ ...row, event: 'sla_breach' }, lateEvening)).toBe(true);
    expect(heldByQuietHours({ ...row, event: 'mention' }, lateEvening)).toBe(false);
    expect(heldByQuietHours({ ...row, event: 'sla_breach' }, morning)).toBe(false);
    expect(heldByQuietHours({ event: 'sla_breach' }, lateEvening)).toBe(false);
  });
});
