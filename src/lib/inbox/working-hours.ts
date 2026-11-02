/**
 * Workspace working hours (workspace_inbox_settings.working_hours) evaluated in
 * the workspace's IANA time zone. Pure: no I/O, so the worker, routes and UI
 * share one interpretation.
 *
 * Shape: {"mon":[{"start":"09:00","end":"18:00"}], ...}. Times are local wall
 * clock "HH:MM"; end is exclusive and may be "24:00". A day that is missing or
 * has no ranges is closed. A schedule with no ranges at all means working hours
 * are not configured, which counts as always open (no away message is sent).
 */

export const WEEKDAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;
export type Weekday = (typeof WEEKDAYS)[number];
export interface TimeRange { start: string; end: string }
export type WorkingHours = Partial<Record<Weekday, TimeRange[]>>;

/** Columns of workspace_inbox_settings, as read by the app and worker. */
export interface InboxSettings {
  timezone: string;
  working_hours: WorkingHours;
  away_message_enabled: boolean;
  away_message: string | null;
  auto_resolve_after_hours: number | null;
  sla_first_response_minutes: number | null;
}

/** Values used when a workspace has no settings row yet. */
export const DEFAULT_INBOX_SETTINGS: InboxSettings = {
  timezone: 'UTC',
  working_hours: {},
  away_message_enabled: false,
  away_message: null,
  auto_resolve_after_hours: null,
  sla_first_response_minutes: null,
};

export const MAX_RANGES_PER_DAY = 4;
const TIME = /^([01]\d|2[0-3]):([0-5]\d)$|^24:00$/;
const SUNDAY_FIRST: Weekday[] = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

function minutes(time: string): number {
  const [h, m] = time.split(':').map(Number);
  return h * 60 + m;
}

export function isValidTimeZone(timeZone: unknown): timeZone is string {
  if (typeof timeZone !== 'string' || !timeZone || timeZone.length > 64) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
    return true;
  } catch {
    return false;
  }
}

/**
 * Validate and normalise a working-hours value from a request or the database.
 * Returns null when the shape is invalid (unknown day, bad time, start >= end,
 * overlapping ranges or more than MAX_RANGES_PER_DAY). Ranges come back sorted.
 */
export function parseWorkingHours(value: unknown): WorkingHours | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const out: WorkingHours = {};
  for (const [day, ranges] of Object.entries(value as Record<string, unknown>)) {
    if (!(WEEKDAYS as readonly string[]).includes(day) || !Array.isArray(ranges)) return null;
    if (ranges.length > MAX_RANGES_PER_DAY) return null;
    const parsed: TimeRange[] = [];
    for (const range of ranges) {
      if (!range || typeof range !== 'object') return null;
      const { start, end } = range as Record<string, unknown>;
      if (typeof start !== 'string' || typeof end !== 'string' || !TIME.test(start) || !TIME.test(end)) return null;
      if (start === '24:00' || minutes(start) >= minutes(end)) return null;
      parsed.push({ start, end });
    }
    parsed.sort((a, b) => minutes(a.start) - minutes(b.start));
    for (let i = 1; i < parsed.length; i++) if (minutes(parsed[i].start) < minutes(parsed[i - 1].end)) return null;
    if (parsed.length) out[day as Weekday] = parsed;
  }
  return out;
}

interface LocalTime { date: string; weekdayIndex: number; minute: number }

/** Wall-clock date (YYYY-MM-DD), weekday (0 = Sunday) and minute of day in a zone. */
function localTime(date: Date, timeZone: string): LocalTime {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
    }).formatToParts(date).map((p) => [p.type, p.value]),
  );
  const y = Number(parts.year), m = Number(parts.month), d = Number(parts.day);
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    weekdayIndex: new Date(Date.UTC(y, m - 1, d)).getUTCDay(),
    minute: Number(parts.hour) * 60 + Number(parts.minute),
  };
}

function addDays(date: string, days: number): { date: string; weekdayIndex: number } {
  const [y, m, d] = date.split('-').map(Number);
  const next = new Date(Date.UTC(y, m - 1, d + days));
  return { date: next.toISOString().slice(0, 10), weekdayIndex: next.getUTCDay() };
}

function hasSchedule(hours: WorkingHours): boolean {
  return WEEKDAYS.some((day) => (hours[day]?.length ?? 0) > 0);
}

function zoneOf(settings: Pick<InboxSettings, 'timezone'>): string {
  return isValidTimeZone(settings.timezone) ? settings.timezone : 'UTC';
}

/**
 * Whether `date` falls inside the workspace's working hours. An unconfigured
 * schedule is always open; an invalid time zone falls back to UTC.
 */
export function isWithinWorkingHours(
  settings: Pick<InboxSettings, 'timezone' | 'working_hours'>,
  date: Date = new Date(),
): boolean {
  const hours = parseWorkingHours(settings.working_hours) ?? {};
  if (!hasSchedule(hours)) return true;
  const now = localTime(date, zoneOf(settings));
  return (hours[SUNDAY_FIRST[now.weekdayIndex]] ?? [])
    .some((r) => minutes(r.start) <= now.minute && now.minute < minutes(r.end));
}

/**
 * Identifies the off-hours window that `date` is in, for away_message_sends
 * (one away message per conversation per window). Every moment of one closed
 * stretch maps to the same key: the local wall time at which the workspace
 * next opens, e.g. "open:2026-11-03T09:00". Returns null when `date` is inside
 * working hours (or none are configured). Keys are at most 22 chars; the
 * "closed:<local date>" fallback is defensive (a schedule always reopens).
 */
export function nextWindowKey(
  settings: Pick<InboxSettings, 'timezone' | 'working_hours'>,
  date: Date = new Date(),
): string | null {
  if (isWithinWorkingHours(settings, date)) return null;
  const hours = parseWorkingHours(settings.working_hours) ?? {};
  const now = localTime(date, zoneOf(settings));
  for (let offset = 0; offset <= 7; offset++) {
    const day = offset === 0 ? { date: now.date, weekdayIndex: now.weekdayIndex } : addDays(now.date, offset);
    const opening = (hours[SUNDAY_FIRST[day.weekdayIndex]] ?? [])
      .find((r) => offset > 0 || minutes(r.start) > now.minute);
    if (opening) return `open:${day.date}T${opening.start}`;
  }
  return `closed:${now.date}`;
}
