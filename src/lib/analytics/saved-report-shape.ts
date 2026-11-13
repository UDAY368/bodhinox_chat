// Saved report definitions (analytics_saved_reports): the allowed values and
// input validation. Pure (no database or server imports), so the Reports UI
// and the server validate the same way.

export const SAVED_METRICS = ['new', 'resolved', 'first_response', 'resolution', 'messages', 'failed'] as const;
export type SavedMetric = (typeof SAVED_METRICS)[number];
export const SAVED_GROUPS = ['day', 'week', 'channel', 'agent', 'label'] as const;
export type SavedGroup = (typeof SAVED_GROUPS)[number];
export const SAVED_CHANNELS = ['all', 'whatsapp', 'instagram'] as const;
export type SavedChannel = (typeof SAVED_CHANNELS)[number];
export const SAVED_RANGES = ['today', '7d', '30d', '90d', 'this_week', 'last_week', 'this_month', 'last_month', 'custom'] as const;
export type SavedRange = (typeof SAVED_RANGES)[number];
export const SAVED_FORMATS = ['csv', 'pdf'] as const;
export type SavedFormat = (typeof SAVED_FORMATS)[number];

export const SAVED_REPORT_NAME_MAX = 60;
/** Saved reports a workspace may keep. */
export const MAX_SAVED_REPORTS = 50;
/** A custom range spans at most this many days (as every analytics range). */
export const SAVED_RANGE_MAX_DAYS = 366;

/** Metrics shown in seconds (medians); the rest are counts. */
export const DURATION_METRICS: readonly SavedMetric[] = ['first_response', 'resolution'];

export interface SavedReportDefinition {
  name: string;
  /** In SAVED_METRICS order, no repeats. */
  metrics: SavedMetric[];
  group: SavedGroup;
  channel: SavedChannel;
  range: { preset: SavedRange; from: string | null; to: string | null };
  format: SavedFormat;
}

/** What a scheduled run snapshots into report_runs.params.report. */
export interface SavedReportSnapshot {
  name: string;
  metrics: SavedMetric[];
  group: SavedGroup;
  channel: SavedChannel;
}

export type SavedReportIssue = 'name' | 'metrics' | 'group' | 'channel' | 'range' | 'dates' | 'format';

const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;
const isOneOf = <T extends string>(list: readonly T[], value: unknown): value is T =>
  typeof value === 'string' && (list as readonly string[]).includes(value);

function validDay(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const match = DAY.exec(value);
  if (!match) return false;
  return new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]))).toISOString().slice(0, 10) === value;
}

/** Days from `from` to `to` inclusive. */
export function spanDays(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000) + 1;
}

/** Today's date (YYYY-MM-DD) on this device's clock: the custom date inputs' max. */
export function deviceToday(now: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/**
 * The latest calendar date anywhere on Earth at `now` (UTC+14): the server's "today" for a custom range, so
 * a member whose local day is already tomorrow in UTC terms is never refused, and no later day passes.
 */
export function latestToday(now: Date = new Date()): string {
  return new Date(now.getTime() + 14 * 3_600_000).toISOString().slice(0, 10);
}

/**
 * Why a custom range is refused, or null when it is fine: both days needed,
 * start not after end, end not after `today`, at most SAVED_RANGE_MAX_DAYS.
 */
export function customRangeIssue(from: string | null | undefined, to: string | null | undefined, today?: string):
  'missing' | 'order' | 'future' | 'too_long' | null {
  if (!validDay(from) || !validDay(to)) return 'missing';
  if (from > to) return 'order';
  if (today && to > today) return 'future';
  if (spanDays(from, to) > SAVED_RANGE_MAX_DAYS) return 'too_long';
  return null;
}

/**
 * Validates and normalises a definition from a request body ({ name, metrics,
 * group, channel, preset, from?, to?, format }). Returns the definition or the
 * first problem found. Names are trimmed and whitespace-collapsed.
 */
export function parseSavedReport(input: unknown, now: Date = new Date()): { ok: true; value: SavedReportDefinition } | { ok: false; issue: SavedReportIssue } {
  const body = input && typeof input === 'object' && !Array.isArray(input) ? (input as Record<string, unknown>) : {};
  const name = typeof body.name === 'string' ? body.name.replace(/\s+/g, ' ').trim() : '';
  if (!name || name.length > SAVED_REPORT_NAME_MAX) return { ok: false, issue: 'name' };
  if (!Array.isArray(body.metrics) || body.metrics.length < 1 || body.metrics.length > SAVED_METRICS.length
    || !body.metrics.every((m) => isOneOf(SAVED_METRICS, m)) || new Set(body.metrics).size !== body.metrics.length)
    return { ok: false, issue: 'metrics' };
  const metrics = SAVED_METRICS.filter((m) => (body.metrics as unknown[]).includes(m));
  if (!isOneOf(SAVED_GROUPS, body.group)) return { ok: false, issue: 'group' };
  const channel = body.channel === undefined ? 'all' : body.channel;
  if (!isOneOf(SAVED_CHANNELS, channel)) return { ok: false, issue: 'channel' };
  if (!isOneOf(SAVED_RANGES, body.preset)) return { ok: false, issue: 'range' };
  const format = body.format === undefined ? 'csv' : body.format;
  if (!isOneOf(SAVED_FORMATS, format)) return { ok: false, issue: 'format' };
  let range: SavedReportDefinition['range'] = { preset: body.preset, from: null, to: null };
  if (body.preset === 'custom') {
    if (customRangeIssue(body.from as string, body.to as string, latestToday(now))) return { ok: false, issue: 'dates' };
    range = { preset: 'custom', from: body.from as string, to: body.to as string };
  }
  return { ok: true, value: { name, metrics, group: body.group, channel, range, format } };
}

/** The snapshot stored with a scheduled run, or null when params.report is not a valid one. */
export function parseSnapshot(value: unknown): SavedReportSnapshot | null {
  const s = value && typeof value === 'object' ? (value as Record<string, unknown>) : null;
  if (!s || typeof s.name !== 'string' || !s.name || s.name.length > SAVED_REPORT_NAME_MAX) return null;
  if (!Array.isArray(s.metrics) || s.metrics.length < 1 || !s.metrics.every((m) => isOneOf(SAVED_METRICS, m))) return null;
  if (!isOneOf(SAVED_GROUPS, s.group) || !isOneOf(SAVED_CHANNELS, s.channel)) return null;
  return { name: s.name, metrics: SAVED_METRICS.filter((m) => (s.metrics as unknown[]).includes(m)), group: s.group, channel: s.channel };
}

/** A copy's name: "<name> copy", then "<name> copy 2", ... within the length limit and unused. */
export function copyName(name: string, taken: readonly string[]): string {
  const used = new Set(taken.map((n) => n.toLowerCase()));
  for (let i = 1; i < 1000; i++) {
    const suffix = i === 1 ? ' copy' : ` copy ${i}`;
    const candidate = `${name.slice(0, SAVED_REPORT_NAME_MAX - suffix.length).trimEnd()}${suffix}`;
    if (!used.has(candidate.toLowerCase())) return candidate;
  }
  return name.slice(0, SAVED_REPORT_NAME_MAX);
}

/** A file name stem from a report name: lowercase letters, digits and dashes. */
export function fileStem(name: string): string {
  return name.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'report';
}
