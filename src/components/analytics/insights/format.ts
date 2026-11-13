'use client';

import { useFormatter, useTranslations } from 'next-intl';

/** Change against the previous period: text and tone (good, bad or neutral). */
export interface Delta {
  text: string;
  tone: 'good' | 'bad' | 'neutral';
}

/**
 * Percent change of `current` against `previous`. Null when either is unknown;
 * "new" when there was nothing before. For durations a drop is good.
 */
export function deltaOf(current: number | null | undefined, previous: number | null | undefined, lowerIsBetter = false):
  { kind: 'none' } | { kind: 'new' } | { kind: 'same' } | { kind: 'change'; percent: number; good: boolean } {
  if (current == null || previous == null) return { kind: 'none' };
  if (!previous) return current ? { kind: 'new' } : { kind: 'same' };
  const change = ((current - previous) / previous) * 100;
  if (Math.abs(change) < 0.5) return { kind: 'same' };
  return { kind: 'change', percent: change, good: lowerIsBetter ? change < 0 : change > 0 };
}

export function useDelta() {
  const t = useTranslations('Analytics.insights.delta');
  const format = useFormatter();
  return (current: number | null | undefined, previous: number | null | undefined, lowerIsBetter = false): Delta | null => {
    const d = deltaOf(current, previous, lowerIsBetter);
    if (d.kind === 'none') return null;
    if (d.kind === 'new') return { text: t('new'), tone: 'neutral' };
    if (d.kind === 'same') return { text: t('same'), tone: 'neutral' };
    const abs = Math.abs(d.percent);
    const value = format.number(abs < 10 ? Math.round(abs * 10) / 10 : Math.round(abs));
    return { text: d.percent > 0 ? t('up', { value }) : t('down', { value }), tone: d.good ? 'good' : 'bad' };
  };
}

/** Local hour of day as a short label (12 am, 1 pm), in the reader's locale. */
export function useHourLabel() {
  const format = useFormatter();
  return (hour: number) => format.dateTime(new Date(Date.UTC(2026, 0, 1, hour % 24)), { hour: 'numeric', timeZone: 'UTC' });
}

/** Labels for a bucket key: YYYY-MM-DDTHH (hour), or YYYY-MM-DD (day or week start). */
export function useBucketLabels() {
  const format = useFormatter();
  const t = useTranslations('Analytics.insights');
  const date = (key: string) => new Date(`${key.slice(0, 10)}T00:00:00Z`);
  return {
    short(key: string, bucket: 'hour' | 'day' | 'week') {
      if (bucket === 'hour') return format.dateTime(new Date(Date.UTC(2026, 0, 1, Number(key.slice(11, 13)))), { hour: 'numeric', timeZone: 'UTC' });
      return format.dateTime(date(key), { day: 'numeric', month: 'short', timeZone: 'UTC' });
    },
    long(key: string, bucket: 'hour' | 'day' | 'week') {
      if (bucket === 'hour') {
        const h = Number(key.slice(11, 13));
        const at = (hour: number) => format.dateTime(new Date(Date.UTC(2026, 0, 1, hour % 24)), { hour: 'numeric', timeZone: 'UTC' });
        return t('hourSpan', { day: format.dateTime(date(key), { day: 'numeric', month: 'short', timeZone: 'UTC' }), from: at(h), to: at(h + 1) });
      }
      if (bucket === 'week') {
        const end = new Date(date(key).getTime() + 6 * 86_400_000);
        return t('weekSpan', {
          from: format.dateTime(date(key), { day: 'numeric', month: 'short', timeZone: 'UTC' }),
          to: format.dateTime(end, { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }),
        });
      }
      return format.dateTime(date(key), { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
    },
    word(bucket: 'hour' | 'day' | 'week') {
      return t(`bucket.${bucket}`);
    },
  };
}
