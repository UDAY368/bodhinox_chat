/**
 * The standard date formatter for every screen (Batch 2 design foundation). New code formats dates
 * and times with formatDate; older ad-hoc toLocaleString / date-fns calls are migrated by later batches.
 *
 * Styles (examples in the default en-IN locale):
 *   'date'     "12 Oct"            (adds the year when it is not this year: "12 Oct 2025")
 *   'day'      "12 Oct 2026"       (always with the year)
 *   'time'     "2:45 pm"
 *   'datetime' "12 Oct, 2:45 pm"   (year added when not this year)
 *   'relative' "5 min ago", "in 2 hr", "yesterday"; after 7 days it falls back to 'date'
 *
 * Pure and total: invalid input gives ''. Without a locale it uses en-IN, never the runtime default,
 * so server and browser render the same text; pass the next-intl locale and the account time zone
 * where known. `now` is injectable for tests and for 'relative'.
 */

export type DateStyle = 'date' | 'time' | 'datetime' | 'day' | 'relative';

export interface DateFormatOptions {
  style?: DateStyle;
  /** BCP 47 locale, e.g. the next-intl locale. Defaults to en-IN. */
  locale?: string;
  /** IANA time zone, e.g. "Asia/Kolkata". Defaults to the runtime's zone. */
  timeZone?: string;
  /** The current time, for "this year" and 'relative'. Defaults to new Date(). */
  now?: Date;
}

const DEFAULT_LOCALE = 'en-IN';

function toDate(value: Date | string | number | null | undefined): Date | null {
  if (value === null || value === undefined || value === '') return null;
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function dateTimeFormat(locale: string | undefined, timeZone: string | undefined, options: Intl.DateTimeFormatOptions) {
  try {
    return new Intl.DateTimeFormat(locale ?? DEFAULT_LOCALE, { ...options, timeZone });
  } catch {
    try {
      return new Intl.DateTimeFormat(DEFAULT_LOCALE, { ...options, timeZone });
    } catch {
      return new Intl.DateTimeFormat(DEFAULT_LOCALE, options); // unknown time zone
    }
  }
}

function yearIn(date: Date, timeZone: string | undefined): string {
  return dateTimeFormat('en', timeZone, { year: 'numeric' }).format(date);
}

const MINUTE = 60;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

function relative(date: Date, now: Date, locale: string | undefined): string | null {
  const seconds = Math.round((date.getTime() - now.getTime()) / 1000);
  const abs = Math.abs(seconds);
  if (abs >= 7 * DAY) return null;
  let format: Intl.RelativeTimeFormat;
  try {
    format = new Intl.RelativeTimeFormat(locale ?? DEFAULT_LOCALE, { numeric: 'auto', style: 'short' });
  } catch {
    format = new Intl.RelativeTimeFormat(DEFAULT_LOCALE, { numeric: 'auto', style: 'short' });
  }
  if (abs < MINUTE) return format.format(0, 'second');
  if (abs < HOUR) return format.format(Math.trunc(seconds / MINUTE), 'minute');
  if (abs < DAY) return format.format(Math.trunc(seconds / HOUR), 'hour');
  return format.format(Math.round(seconds / DAY), 'day');
}

export function formatDate(value: Date | string | number | null | undefined, options: DateFormatOptions = {}): string {
  const date = toDate(value);
  if (!date) return '';
  const { style = 'date', locale, timeZone } = options;
  const now = options.now ?? new Date();
  if (style === 'relative') {
    const text = relative(date, now, locale);
    if (text !== null) return text;
  }
  if (style === 'time') return dateTimeFormat(locale, timeZone, { hour: 'numeric', minute: '2-digit' }).format(date);
  const withYear = style === 'day' || yearIn(date, timeZone) !== yearIn(now, timeZone);
  const day: Intl.DateTimeFormatOptions = { day: 'numeric', month: 'short', ...(withYear ? { year: 'numeric' } : {}) };
  if (style === 'datetime') return dateTimeFormat(locale, timeZone, { ...day, hour: 'numeric', minute: '2-digit' }).format(date);
  return dateTimeFormat(locale, timeZone, day).format(date);
}
