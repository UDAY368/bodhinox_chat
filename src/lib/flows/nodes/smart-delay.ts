// Smart delay step (Stage 5): wait a duration, or until a date, then
// optionally only continue inside allowed hours and weekdays.
//
// Pure date maths, so the engine (which waits with the durable flow.timer job)
// and the unit tests agree:
//   duration    `amount` `unit`, or the number in custom field
//               `amount_field_id`, at most FLOW_STEP_LIMITS.smartDelayMaxDays.
//   until_date  a fixed `date` or the date in custom field `date_field_id`,
//               plus `offset_minutes`. A date that has already passed stops
//               the run there (the step says so in the builder).
//   send_window moves the wake time to the next allowed minute: `from`–`to`
//               (HH:MM, `to` before `from` crosses midnight, equal means all
//               day) on `weekdays` (0 = Sunday; none = every day), in
//               `timezone` (the workspace's when unset). A window that crosses
//               midnight belongs to the weekday it starts on.
import { isValidTimeZone } from "@/lib/automations/time-of-day";
import { parseDateInput, parseNumberInput } from "../input-formats";
import { FLOW_STEP_LIMITS, type SendWindow, type SmartDelayNodeConfig, type SmartDelayUnit } from "../types";

const CLOCK = /^([01]\d|2[0-3]):([0-5]\d)$/;
const UNIT_MS: Record<SmartDelayUnit, number> = { seconds: 1_000, minutes: 60_000, hours: 3_600_000, days: 86_400_000 };
export const SMART_DELAY_MAX_MS = FLOW_STEP_LIMITS.smartDelayMaxDays * UNIT_MS.days;
/** Longer than this on Instagram, the next send usually finds the 24-hour window closed (publish warning). */
export const INSTAGRAM_LONG_WAIT_MS = 23 * UNIT_MS.hours;
/** Offsets on a date: at most a year either way. */
export const SMART_DELAY_MAX_OFFSET_MINUTES = 525_600;

export function isSmartDelayUnit(value: unknown): value is SmartDelayUnit {
  return typeof value === "string" && Object.hasOwn(UNIT_MS, value);
}

/** Minutes after midnight for "HH:MM", or null. */
export function clockMinutes(value: unknown): number | null {
  const m = typeof value === "string" ? CLOCK.exec(value) : null;
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

/** A well-formed send window, or null. */
export function sendWindowOf(raw: unknown): SendWindow | null {
  if (!raw || typeof raw !== "object") return null;
  const w = raw as Record<string, unknown>;
  if (clockMinutes(w.from) === null || clockMinutes(w.to) === null) return null;
  const weekdays = Array.isArray(w.weekdays) ? w.weekdays : [];
  if (weekdays.length > 7 || weekdays.some((d) => typeof d !== "number" || !Number.isInteger(d) || d < 0 || d > 6)) return null;
  return { from: w.from as string, to: w.to as string, weekdays: [...new Set(weekdays as number[])].sort() };
}

/** The duration in ms for an amount and unit, or null when out of range. */
export function durationMs(amount: unknown, unit: unknown): number | null {
  const n = typeof amount === "number" ? amount : typeof amount === "string" ? parseNumberInput(amount) : null;
  if (n === null || !Number.isFinite(n) || n < 0 || !isSmartDelayUnit(unit)) return null;
  const ms = Math.round(n * UNIT_MS[unit]);
  return ms <= SMART_DELAY_MAX_MS ? ms : null;
}

interface ZonedParts { year: number; month: number; day: number; hour: number; minute: number; weekday: number }

const WEEKDAYS: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

function zonedParts(instant: number, timezone: string): ZonedParts {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", weekday: "short",
  }).formatToParts(new Date(instant));
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "0";
  return {
    year: Number(get("year")), month: Number(get("month")), day: Number(get("day")),
    hour: Number(get("hour")) % 24, minute: Number(get("minute")), weekday: WEEKDAYS[get("weekday")] ?? 0,
  };
}

/** The instant of a local wall-clock time in `timezone` (the earlier one in a DST overlap, shifted forward in a gap). */
export function zonedTimeToUtc(year: number, month: number, day: number, hour: number, minute: number, timezone: string): number {
  const wall = Date.UTC(year, month - 1, day, hour, minute);
  let guess = wall;
  for (let i = 0; i < 3; i += 1) {
    const p = zonedParts(guess, timezone);
    const shown = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);
    const diff = shown - wall;
    if (diff === 0) break;
    guess -= diff;
  }
  return guess;
}

/** Whether `instant` falls inside the window (in `timezone`). */
export function insideWindow(instant: number, window: SendWindow, timezone: string): boolean {
  const from = clockMinutes(window.from)!;
  const to = clockMinutes(window.to)!;
  const p = zonedParts(instant, timezone);
  const minute = p.hour * 60 + p.minute;
  let weekday = p.weekday;
  let inside: boolean;
  if (from === to) inside = true;
  else if (from < to) inside = minute >= from && minute < to;
  else {
    // Crosses midnight: the part after midnight belongs to the day the window started.
    inside = minute >= from || minute < to;
    if (minute < to) weekday = (weekday + 6) % 7;
  }
  return inside && (window.weekdays.length === 0 || window.weekdays.includes(weekday));
}

/**
 * The first allowed instant at or after `instant`. Checks the window start of
 * each of the next 8 local days, so a window with no weekday at all (never
 * stored that way) gives back `instant` unchanged rather than looping.
 */
export function nextAllowedInstant(instant: number, window: SendWindow, timezone: string): number {
  if (insideWindow(instant, window, timezone)) return instant;
  const from = clockMinutes(window.from)!;
  const start = zonedParts(instant, timezone);
  for (let offset = -1; offset <= 8; offset += 1) {
    const day = new Date(Date.UTC(start.year, start.month - 1, start.day + offset));
    const candidate = zonedTimeToUtc(day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate(), Math.floor(from / 60), from % 60, timezone);
    if (candidate >= instant && insideWindow(candidate, window, timezone)) return candidate;
  }
  return instant;
}

/** What a smart delay step decides for a run. */
export type SmartDelayPlan =
  /** Continue now (zero wait, or the window is already open). */
  | { kind: "continue" }
  /** Wait until `until`. */
  | { kind: "wait"; until: Date }
  /** The date has passed: the run stops here. */
  | { kind: "date_passed" }
  /** The step cannot be planned (bad config or an unreadable field): the run fails here. */
  | { kind: "invalid"; reason: "smart_delay_invalid" | "smart_delay_field_empty" };

/**
 * Plans the wait. `fieldValue` is the stored custom field value when the step
 * reads one (`amount_field_id` or `date_field_id`); `timezone` is the step's or
 * the workspace's.
 */
export function planSmartDelay(cfg: Partial<SmartDelayNodeConfig>, input: { now: Date; timezone: string; fieldValue?: string | null }): SmartDelayPlan {
  const now = input.now.getTime();
  const timezone = isValidTimeZone(cfg.timezone) ? cfg.timezone : isValidTimeZone(input.timezone) ? input.timezone : "UTC";
  let wake: number;
  if (cfg.mode === "duration") {
    const usesField = typeof cfg.amount_field_id === "string" && cfg.amount_field_id !== "";
    if (usesField && (input.fieldValue === undefined || input.fieldValue === null || input.fieldValue.trim() === "")) {
      return { kind: "invalid", reason: "smart_delay_field_empty" };
    }
    const ms = durationMs(usesField ? input.fieldValue : cfg.amount, cfg.unit);
    if (ms === null) return { kind: "invalid", reason: "smart_delay_invalid" };
    wake = now + ms;
  } else if (cfg.mode === "until_date") {
    const usesField = typeof cfg.date_field_id === "string" && cfg.date_field_id !== "";
    const raw = usesField ? input.fieldValue : cfg.date;
    if (usesField && (raw === undefined || raw === null || raw.trim() === "")) return { kind: "invalid", reason: "smart_delay_field_empty" };
    const at = dateInstant(raw, timezone);
    if (at === null) return { kind: "invalid", reason: "smart_delay_invalid" };
    const offset = cfg.offset_minutes ?? 0;
    if (typeof offset !== "number" || !Number.isInteger(offset) || Math.abs(offset) > SMART_DELAY_MAX_OFFSET_MINUTES) {
      return { kind: "invalid", reason: "smart_delay_invalid" };
    }
    wake = at + offset * 60_000;
    if (wake < now) return { kind: "date_passed" };
    if (wake - now > SMART_DELAY_MAX_MS) return { kind: "invalid", reason: "smart_delay_invalid" };
  } else {
    return { kind: "invalid", reason: "smart_delay_invalid" };
  }
  const window = cfg.send_window === undefined || cfg.send_window === null ? null : sendWindowOf(cfg.send_window);
  if (cfg.send_window && !window) return { kind: "invalid", reason: "smart_delay_invalid" };
  if (window) wake = nextAllowedInstant(wake, window, timezone);
  return wake - now < 1_000 ? { kind: "continue" } : { kind: "wait", until: new Date(wake) };
}

/**
 * A stored date as an instant: a full ISO timestamp as written, or a calendar
 * date (YYYY-MM-DD or DD/MM/YYYY) at midnight in `timezone`.
 */
export function dateInstant(raw: unknown, timezone: string): number | null {
  if (typeof raw !== "string" || !raw.trim()) return null;
  const value = raw.trim();
  // A date and time without a zone (the builder's date-time picker) is wall-clock time in `timezone`.
  const local = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::\d{2})?$/.exec(value);
  if (local) {
    const [y, mo, d, h, mi] = local.slice(1).map(Number);
    if (parseDateInput(`${local[1]}-${local[2]}-${local[3]}`) === null || h > 23 || mi > 59) return null;
    return zonedTimeToUtc(y, mo, d, h, mi, timezone);
  }
  if (/^\d{4}-\d{2}-\d{2}T/.test(value)) {
    const t = Date.parse(value);
    return Number.isFinite(t) ? t : null;
  }
  const day = parseDateInput(value);
  if (!day) return null;
  const [y, m, d] = day.split("-").map(Number);
  return zonedTimeToUtc(y, m, d, 0, 0, timezone);
}

/** The longest the step can wait, for the Instagram 24-hour warning; null when it reads a field or a date. */
export function maxWaitMs(cfg: Partial<SmartDelayNodeConfig>): number | null {
  if (cfg.mode === "duration" && !cfg.amount_field_id) {
    const ms = durationMs(cfg.amount, cfg.unit);
    if (ms === null) return null;
    // A send window can push the wake time up to a week further.
    return cfg.send_window ? ms + 7 * UNIT_MS.days : ms;
  }
  return null;
}
