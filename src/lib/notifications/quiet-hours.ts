/**
 * Quiet hours (Settings › Notifications): a daily window in the member's own
 * time zone during which email and push stay quiet. In-app notifications still
 * collect. Mentions can be let through. Times are minutes after local midnight;
 * a window whose start is after its end crosses midnight (22:00 to 07:00).
 *
 * Pure helpers, shared by the settings API (validation), the push worker
 * (suppress), the email digest (defer) and the in-tab desktop alerts.
 */
import type { NotificationEvent } from '@/lib/inbox/notify';

export interface QuietHours {
  enabled: boolean;
  /** Minutes after local midnight, 0-1439. */
  start: number;
  end: number;
  /** IANA time zone, e.g. "Asia/Kolkata". */
  time_zone: string;
  /** A mention still reaches the member during quiet hours. */
  allow_mentions: boolean;
}

export const DEFAULT_QUIET_HOURS: QuietHours = {
  enabled: false,
  start: 22 * 60,
  end: 7 * 60,
  time_zone: 'UTC',
  allow_mentions: true,
};

export class QuietHoursError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'QuietHoursError';
  }
}

const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** "22:30" -> 1350; null for anything else. */
export function parseClock(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const match = TIME.exec(value);
  return match ? Number(match[1]) * 60 + Number(match[2]) : null;
}

/** 1350 -> "22:30". */
export function formatClock(minutes: number): string {
  const m = ((Math.trunc(minutes) % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

/** A time zone the runtime knows; never throws. */
export function isTimeZone(value: unknown): value is string {
  if (typeof value !== 'string' || !value || value.length > 64) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

/**
 * Validate a PUT body's quiet_hours: { enabled, start: "HH:MM", end: "HH:MM", time_zone, allow_mentions }.
 * Unknown keys are rejected rather than ignored.
 */
export function parseQuietHours(input: unknown): QuietHours {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new QuietHoursError('Send quiet hours as an object.');
  const { enabled, start, end, time_zone, allow_mentions, ...rest } = input as Record<string, unknown>;
  if (Object.keys(rest).length) throw new QuietHoursError('Unknown quiet hours field.');
  if (typeof enabled !== 'boolean' || typeof allow_mentions !== 'boolean')
    throw new QuietHoursError('Quiet hours switches must be true or false.');
  const from = parseClock(start);
  const to = parseClock(end);
  if (from === null || to === null) throw new QuietHoursError('Use HH:MM times for quiet hours.');
  if (from === to) throw new QuietHoursError('Choose two different times.');
  if (!isTimeZone(time_zone)) throw new QuietHoursError('Unknown time zone.');
  return { enabled, start: from, end: to, time_zone, allow_mentions };
}

/** Minutes after midnight at `now` in `timeZone` (UTC if the zone is unknown). */
export function localMinutes(now: Date, timeZone: string): number {
  const zone = isTimeZone(timeZone) ? timeZone : 'UTC';
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: zone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .formatToParts(now);
  const hour = Number(parts.find((p) => p.type === 'hour')?.value ?? 0);
  const minute = Number(parts.find((p) => p.type === 'minute')?.value ?? 0);
  return (hour % 24) * 60 + minute;
}

/** Whether `now` falls inside the window (start inclusive, end exclusive). */
export function inQuietWindow(quiet: Pick<QuietHours, 'enabled' | 'start' | 'end' | 'time_zone'>, now: Date): boolean {
  if (!quiet.enabled || quiet.start === quiet.end) return false;
  const at = localMinutes(now, quiet.time_zone);
  return quiet.start < quiet.end ? at >= quiet.start && at < quiet.end : at >= quiet.start || at < quiet.end;
}

/**
 * When the quiet window that contains `now` ends (to the minute), or null when `now` is not inside one.
 * Pushes held during quiet hours are released then.
 */
export function quietEndsAt(quiet: Pick<QuietHours, 'enabled' | 'start' | 'end' | 'time_zone'>, now: Date): Date | null {
  if (!inQuietWindow(quiet, now)) return null;
  const at = localMinutes(now, quiet.time_zone);
  const minutes = (quiet.end - at + 1440) % 1440 || 1440;
  return new Date(Math.floor(now.getTime() / 60_000) * 60_000 + minutes * 60_000);
}

/** Whether email and push for `event` are held back at `now`. */
export function isQuietFor(quiet: QuietHours | null | undefined, event: NotificationEvent | string, now: Date): boolean {
  if (!quiet || !inQuietWindow(quiet, now)) return false;
  return !(quiet.allow_mentions && event === 'mention');
}
