// Analytics date ranges: a preset or a custom pair of local dates, resolved to
// UTC instants in the workspace timezone and clamped so no report scans more
// than MAX_RANGE_DAYS. Every analytics query takes the [from, to) instants this
// produces, so its time predicate always hits a (account_id, <time>) index.

import type { TenantTransaction } from '@/lib/db/tenant';

export const RANGE_PRESETS = ['today', '7d', '30d', '90d', 'custom'] as const;
export type RangePreset = (typeof RANGE_PRESETS)[number];
export type RangeBucket = 'day' | 'week';
export const MAX_RANGE_DAYS = 366;

export interface AnalyticsRange {
  preset: RangePreset;
  /** Inclusive start: local midnight of the first day, as a UTC instant. */
  from: Date;
  /** Exclusive end: local midnight after the last day, or now when the range ends today. */
  to: Date;
  /** First and last local day, YYYY-MM-DD. */
  startDay: string;
  endDay: string;
  days: number;
  timezone: string;
  bucket: RangeBucket;
}

export interface RangeInput {
  preset?: string | null;
  from?: string | null;
  to?: string | null;
  bucket?: string | null;
}

export class AnalyticsRangeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AnalyticsRangeError';
  }
}

const DAY_MS = 86_400_000;
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const PRESET_DAYS: Record<Exclude<RangePreset, 'custom'>, number> = { today: 1, '7d': 7, '30d': 30, '90d': 90 };

export function isValidTimezone(timezone: string): boolean {
  if (!timezone || timezone.length > 64) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}

/** The workspace timezone from inbox settings; UTC when unset or invalid. */
export async function workspaceTimezone(tx: TenantTransaction, accountId: string): Promise<string> {
  const rows = await tx.$queryRaw<{ timezone: string }[]>`
    SELECT timezone FROM workspace_inbox_settings WHERE account_id=${accountId}::uuid`;
  const tz = rows[0]?.timezone;
  return tz && isValidTimezone(tz) ? tz : 'UTC';
}

function zonedParts(instant: number, timezone: string) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date(instant));
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  return { y: get('year'), m: get('month'), d: get('day'), h: get('hour'), min: get('minute'), s: get('second') };
}

/** Offset of the zone from UTC at an instant, in ms (east positive). */
function offsetAt(instant: number, timezone: string): number {
  const p = zonedParts(instant, timezone);
  return Date.UTC(p.y, p.m - 1, p.d, p.h, p.min, p.s) - Math.floor(instant / 1000) * 1000;
}

/** The UTC instant of local midnight starting a local day (DST-safe). */
export function localMidnight(day: string, timezone: string): Date {
  const match = DATE.exec(day);
  if (!match) throw new AnalyticsRangeError('Invalid date');
  const guess = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  let instant = guess - offsetAt(guess, timezone);
  instant = guess - offsetAt(instant, timezone);
  return new Date(instant);
}

/** The local calendar day (YYYY-MM-DD) of an instant. */
export function localDay(instant: Date, timezone: string): string {
  const p = zonedParts(instant.getTime(), timezone);
  return `${p.y}-${String(p.m).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`;
}

/** Adds whole calendar days to a YYYY-MM-DD day. */
export function addDays(day: string, days: number): string {
  const match = DATE.exec(day);
  if (!match) throw new AnalyticsRangeError('Invalid date');
  return new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]) + days)).toISOString().slice(0, 10);
}

function validDay(day: string | null | undefined): day is string {
  const match = day ? DATE.exec(day) : null;
  if (!match) return false;
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return date.toISOString().slice(0, 10) === day;
}

function dayCount(startDay: string, endDay: string): number {
  return Math.round((Date.parse(`${endDay}T00:00:00Z`) - Date.parse(`${startDay}T00:00:00Z`)) / DAY_MS) + 1;
}

/**
 * Resolves a preset or custom range in a timezone. Custom ranges take local
 * days (inclusive); an end in the future is pulled back to today, and a span
 * longer than MAX_RANGE_DAYS keeps its end and moves its start. Bucket defaults
 * to day, or week for ranges over 90 days. Throws AnalyticsRangeError.
 */
export function parseRange(input: RangeInput, timezone: string, now: Date = new Date()): AnalyticsRange {
  if (!isValidTimezone(timezone)) throw new AnalyticsRangeError('Invalid timezone');
  const preset = (input.preset || (input.from || input.to ? 'custom' : '30d')) as RangePreset;
  if (!RANGE_PRESETS.includes(preset)) throw new AnalyticsRangeError('Invalid preset');
  const today = localDay(now, timezone);
  let startDay: string, endDay: string;
  if (preset === 'custom') {
    if (!validDay(input.from) || !validDay(input.to)) throw new AnalyticsRangeError('Invalid date');
    if (input.from > input.to) throw new AnalyticsRangeError('Start is after end');
    if (input.from > today) throw new AnalyticsRangeError('Range is in the future');
    endDay = input.to > today ? today : input.to;
    startDay = dayCount(input.from, endDay) > MAX_RANGE_DAYS ? addDays(endDay, 1 - MAX_RANGE_DAYS) : input.from;
  } else {
    endDay = today;
    startDay = addDays(today, 1 - PRESET_DAYS[preset]);
  }
  const days = dayCount(startDay, endDay);
  const bucket = input.bucket ?? (days > 90 ? 'week' : 'day');
  if (bucket !== 'day' && bucket !== 'week') throw new AnalyticsRangeError('Invalid bucket');
  const from = localMidnight(startDay, timezone);
  const dayEnd = localMidnight(addDays(endDay, 1), timezone);
  const to = endDay === today && now < dayEnd ? now : dayEnd;
  return { preset, from, to, startDay, endDay, days, timezone, bucket };
}

/** Range input from a query string (?preset=&from=&to=&bucket=). */
export function rangeInputFromSearchParams(params: URLSearchParams): RangeInput {
  return { preset: params.get('preset'), from: params.get('from'), to: params.get('to'), bucket: params.get('bucket') };
}

/** Bucket keys covering the range, for zero-filling series: each day, or each ISO week's Monday. */
export function bucketKeys(range: Pick<AnalyticsRange, 'startDay' | 'endDay' | 'bucket'>): string[] {
  const first = range.bucket === 'week' ? weekStart(range.startDay) : range.startDay;
  const step = range.bucket === 'week' ? 7 : 1;
  const keys: string[] = [];
  for (let day = first; day <= range.endDay; day = addDays(day, step)) keys.push(day);
  return keys;
}

/** Monday of the ISO week containing a day (matches PostgreSQL date_trunc('week')). */
export function weekStart(day: string): string {
  const dow = new Date(`${day}T00:00:00Z`).getUTCDay();
  return addDays(day, -((dow + 6) % 7));
}
