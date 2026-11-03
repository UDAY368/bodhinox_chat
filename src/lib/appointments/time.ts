/**
 * Wall-clock time in an IANA zone, for booking. Pure, no dependency.
 *
 * Rules (Phase 7 design section 2):
 *   - A local wall time inside a DST gap does not exist: zonedWallToUtc
 *     returns null and the slot is skipped.
 *   - A local wall time inside a DST fold exists twice: the earlier instant wins.
 *   - Weekdays come from the local date string, never from the UTC instant,
 *     so "Monday only" holds across date boundaries.
 *   - Ranges stay within one local day; "24:00" is next-day 00:00.
 */
import type { IsoWeekday } from './types';

export { isValidTimeZone } from '@/lib/inbox/working-hours';
export { addDays, localDay } from '@/lib/analytics/range';

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$|^24:00$/;
const DAY_MS = 86_400_000;

function zonedParts(instant: number, timeZone: string) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date(instant));
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  return { y: get('year'), m: get('month'), d: get('day'), h: get('hour'), min: get('minute'), s: get('second') };
}

/** Offset of the zone from UTC at an instant, in ms (east positive). Same logic as analytics/range.ts. */
function offsetAt(instant: number, timeZone: string): number {
  const p = zonedParts(instant, timeZone);
  return Date.UTC(p.y, p.m - 1, p.d, p.h, p.min, p.s) - Math.floor(instant / 1000) * 1000;
}

const pad = (n: number) => String(n).padStart(2, '0');

/**
 * A real calendar date YYYY-MM-DD between 1970 and 2100. The regex alone lets
 * 2026-02-30 through, which Postgres refuses on a ::date cast (a 500).
 */
export function isCalendarDate(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const m = DATE.exec(value);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const t = new Date(Date.UTC(y, mo - 1, d));
  return y >= 1970 && y <= 2100 && t.getUTCMonth() === mo - 1 && t.getUTCDate() === d;
}

/** ISO weekday (1 = Monday) of a YYYY-MM-DD date string. */
export function isoWeekday(localDate: string): IsoWeekday {
  const m = DATE.exec(localDate);
  if (!m) throw new RangeError('Invalid date');
  const sunday0 = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))).getUTCDay();
  return (sunday0 === 0 ? 7 : sunday0) as IsoWeekday;
}

/** Working-hours key (mon..sun) of a YYYY-MM-DD date string. */
export function weekdayKey(localDate: string): 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun' {
  return (['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const)[isoWeekday(localDate) - 1];
}

export interface LocalParts {
  /** YYYY-MM-DD */
  date: string;
  /** HH:MM, 24-hour */
  hhmm: string;
  isoWeekday: IsoWeekday;
}

/** Local date, time and weekday of an instant in a zone. */
export function localParts(instant: Date, timeZone: string): LocalParts {
  const p = zonedParts(instant.getTime(), timeZone);
  const date = `${p.y}-${pad(p.m)}-${pad(p.d)}`;
  return { date, hhmm: `${pad(p.h)}:${pad(p.min)}`, isoWeekday: isoWeekday(date) };
}

/**
 * The UTC instant of a local wall time, or null inside a DST gap. In a fold
 * the earlier instant is returned. "24:00" is the next local day's 00:00.
 */
export function zonedWallToUtc(localDate: string, hhmm: string, timeZone: string): Date | null {
  const d = DATE.exec(localDate);
  const t = HHMM.exec(hhmm);
  if (!d || !t) return null;
  if (hhmm === '24:00') {
    const next = new Date(Date.UTC(Number(d[1]), Number(d[2]) - 1, Number(d[3]) + 1)).toISOString().slice(0, 10);
    return zonedWallToUtc(next, '00:00', timeZone);
  }
  const guess = Date.UTC(Number(d[1]), Number(d[2]) - 1, Number(d[3]), Number(t[1]), Number(t[2]));
  const candidates = new Set([guess - offsetAt(guess - DAY_MS, timeZone), guess - offsetAt(guess + DAY_MS, timeZone)]);
  // Offsets either side of the date cover every transition within a day; add the
  // offset at the guess itself for zones that changed twice in two days.
  candidates.add(guess - offsetAt(guess, timeZone));
  const matches = [...candidates]
    .filter((instant) => {
      const p = localParts(new Date(instant), timeZone);
      return p.date === localDate && p.hhmm === hhmm;
    })
    .sort((a, b) => a - b);
  return matches.length ? new Date(matches[0]) : null;
}

/** Minutes since local midnight for "HH:MM" (or "24:00" = 1440). */
export function minutesOf(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

/** "HH:MM" for minutes since local midnight (0..1440). */
export function hhmmOf(minutes: number): string {
  return `${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`;
}

/** Short zone label for display, e.g. "GMT+5:30" or "EDT", at an instant. */
export function zoneLabel(instant: Date, timeZone: string, locale = 'en-US'): string {
  const part = new Intl.DateTimeFormat(locale, { timeZone, timeZoneName: 'short' })
    .formatToParts(instant)
    .find((p) => p.type === 'timeZoneName');
  return part?.value ?? timeZone;
}
