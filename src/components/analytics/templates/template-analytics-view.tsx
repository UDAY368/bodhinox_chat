'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useFormatter, useTranslations } from 'next-intl';
import { Loader2 } from 'lucide-react';
import { authFetch } from '@/lib/auth/client';
import { BarChart } from '@/components/tremor/bar-chart';
import type { AvailableChartColorsKeys } from '@/components/tremor/chart-colors';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { cn } from '@/lib/utils';
import { ChartWithTable } from '@/components/analytics/shared';
import {
  RATE_KEYS,
  rateSeries,
  templateRates,
  type TemplateAnalyticsResponse,
  type TemplateCounts,
} from './summarize';

const PRESETS = ['7d', '30d', '90d', 'custom'] as const;
type Preset = (typeof PRESETS)[number];
type Mode = 'counts' | 'rates';

const COUNT_KEYS = ['sent', 'delivered', 'read', 'replied', 'clicked', 'failed'] as const;
const COLORS: Record<(typeof COUNT_KEYS)[number], AvailableChartColorsKeys> = {
  sent: 'blue', delivered: 'cyan', read: 'violet', replied: 'emerald', clicked: 'amber', failed: 'pink',
};
const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Builds the report URL for a template (or the whole workspace) and a range. */
export function templateAnalyticsUrl(templateId: string | null | undefined, preset: Preset, from?: string, to?: string): string {
  const params = new URLSearchParams({ preset });
  if (preset === 'custom' && from && to) {
    params.set('from', from);
    params.set('to', to);
  }
  if (templateId) params.set('templateId', templateId);
  return `/api/analytics/templates?${params.toString()}`;
}

/**
 * Template performance for a range: totals with rates, a per-bucket chart
 * (counts or rates), and, for the whole workspace, a per-template table.
 * Pass `templateId` for one template (its stats cover every language with
 * that name).
 */
export function TemplateAnalyticsView({ templateId }: { templateId?: string | null }) {
  const t = useTranslations('Analytics.templates');
  const format = useFormatter();
  const [preset, setPreset] = useState<Preset>('30d');
  const [custom, setCustom] = useState<{ from: string; to: string }>({ from: '', to: '' });
  const [mode, setMode] = useState<Mode>('counts');
  const [data, setData] = useState<TemplateAnalyticsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const customReady = DATE.test(custom.from) && DATE.test(custom.to) && custom.from <= custom.to;
  const url = preset === 'custom' && !customReady ? null : templateAnalyticsUrl(templateId, preset, custom.from, custom.to);

  const load = useCallback(async (target: string, signal: AbortSignal) => {
    setLoading(true);
    setError(null);
    try {
      const res = await authFetch(target, { signal });
      const body = (await res.json().catch(() => null)) as (TemplateAnalyticsResponse & { error?: string }) | null;
      if (signal.aborted) return;
      if (!res.ok || !body) {
        setError(body?.error || t('loadFailed'));
        return;
      }
      setData(body);
    } catch {
      if (!signal.aborted) setError(t('loadFailed'));
    } finally {
      if (!signal.aborted) setLoading(false);
    }
  }, [t]);

  const [reloadKey, setReloadKey] = useState(0);
  useEffect(() => {
    if (!url) return;
    const controller = new AbortController();
    void load(url, controller.signal);
    return () => controller.abort();
  }, [url, load, reloadKey]);

  function choosePreset(next: Preset) {
    if (next === 'custom' && data && !customReady)
      setCustom({ from: data.range.startDay, to: data.range.endDay });
    setPreset(next);
  }

  const label = useCallback((key: (typeof COUNT_KEYS)[number]) => t(`metrics.${key}`), [t]);
  const dayLabel = useCallback((day: string) => {
    const date = new Date(`${day}T00:00:00Z`);
    const text = format.dateTime(date, { month: 'short', day: 'numeric', timeZone: 'UTC' });
    return data?.range.bucket === 'week' ? t('weekOf', { date: text }) : text;
  }, [data?.range.bucket, format, t]);

  const chart = useMemo(() => {
    if (!data) return null;
    const keys = mode === 'counts' ? COUNT_KEYS : RATE_KEYS;
    const source = mode === 'counts' ? data.series : rateSeries(data.series);
    const rows = source.map((point) => {
      const row: Record<string, string | number> = { label: dayLabel(point.day) };
      for (const key of keys) row[label(key)] = (point as unknown as Record<string, number>)[key];
      return row;
    });
    return { rows, categories: keys.map(label), colors: keys.map((k) => COLORS[k]) };
  }, [data, mode, dayLabel, label]);

  const pct = (value: number | null) =>
    value == null ? '—' : format.number(value, { style: 'percent', maximumFractionDigits: 1 });
  const num = (value: number) => format.number(value);
  /** Chart rates are already percentages (0-100). */
  const ratePct = (value: number) => `${format.number(value, { maximumFractionDigits: 1 })}%`;
  const longDay = (day: string) => format.dateTime(new Date(`${day}T00:00:00Z`), { dateStyle: 'medium', timeZone: 'UTC' });

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-2">
        <div className="flex items-center gap-1 rounded-lg bg-muted/60 p-1" role="group" aria-label={t('rangeLabel')}>
          {PRESETS.map((p) => (
            <button
              key={p}
              type="button"
              aria-pressed={preset === p}
              onClick={() => choosePreset(p)}
              className={cn(
                'rounded-md px-2.5 py-1 text-xs font-medium transition-colors',
                preset === p ? 'bg-secondary text-secondary-foreground' : 'text-muted-foreground hover:text-foreground',
              )}
            >
              {t(`presets.${p}`)}
            </button>
          ))}
        </div>
        {preset === 'custom' && (
          <div className="flex flex-wrap items-center gap-2">
            <Input
              type="date"
              aria-label={t('from')}
              value={custom.from}
              max={custom.to || undefined}
              onChange={(e) => setCustom((c) => ({ ...c, from: e.target.value }))}
              className="h-8 w-auto bg-muted border-border text-foreground"
            />
            <span className="text-xs text-muted-foreground">–</span>
            <Input
              type="date"
              aria-label={t('to')}
              value={custom.to}
              min={custom.from || undefined}
              onChange={(e) => setCustom((c) => ({ ...c, to: e.target.value }))}
              className="h-8 w-auto bg-muted border-border text-foreground"
            />
          </div>
        )}
        {loading && <Loader2 className="size-4 animate-spin text-muted-foreground" aria-label={t('loading')} />}
      </div>

      {error ? (
        <div className="flex items-center gap-2 text-sm text-destructive" role="alert">
          {error}
          <Button variant="outline" size="xs" onClick={() => setReloadKey((k) => k + 1)}>
            {t('retry')}
          </Button>
        </div>
      ) : !data ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
          <Loader2 className="size-4 animate-spin" aria-hidden /> {t('loading')}
        </div>
      ) : (
        <>
          <p className="text-xs text-muted-foreground">
            {t('rangeSummary', {
              start: longDay(data.range.startDay),
              end: longDay(data.range.endDay),
              timezone: data.range.timezone,
            })}
          </p>
          <Totals totals={data.totals} pct={pct} num={num} />

          <section className="space-y-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 className="text-sm font-medium text-foreground">
                {data.range.bucket === 'week' ? t('chartTitleWeekly') : t('chartTitleDaily')}
              </h3>
              <div className="flex items-center gap-1 rounded-lg bg-muted/60 p-1" role="group" aria-label={t('modeLabel')}>
                {(['counts', 'rates'] as const).map((m) => (
                  <button
                    key={m}
                    type="button"
                    aria-pressed={mode === m}
                    onClick={() => setMode(m)}
                    className={cn(
                      'rounded-md px-2.5 py-1 text-xs font-medium transition-colors',
                      mode === m ? 'bg-secondary text-secondary-foreground' : 'text-muted-foreground hover:text-foreground',
                    )}
                  >
                    {t(`modes.${m}`)}
                  </button>
                ))}
              </div>
            </div>
            {data.totals.sent === 0 ? (
              <p className="py-8 text-center text-sm text-muted-foreground">{t('empty')}</p>
            ) : (
              chart && (
                <ChartWithTable
                  label={data.range.bucket === 'week' ? t('chartTitleWeekly') : t('chartTitleDaily')}
                  chart={
                    <BarChart
                      className="h-64"
                      data={chart.rows}
                      index="label"
                      categories={chart.categories}
                      colors={chart.colors}
                      valueFormatter={mode === 'rates' ? ratePct : num}
                      allowDecimals={mode === 'rates'}
                      maxValue={mode === 'rates' ? 100 : undefined}
                      yAxisWidth={44}
                      legendPosition="left"
                    />
                  }
                  columns={[t('period'), ...chart.categories]}
                  rows={chart.rows.map((row) => [
                    String(row.label),
                    ...chart.categories.map((c) => {
                      const v = row[c];
                      if (typeof v !== 'number') return '—';
                      return mode === 'rates' ? ratePct(v) : v;
                    }),
                  ])}
                />
              )
            )}
            <p className="text-xs text-muted-foreground">{t('definitions')}</p>
          </section>

          {!templateId && data.templates.length > 0 && (
            <section className="space-y-2">
              <h3 className="text-sm font-medium text-foreground">{t('byTemplate')}</h3>
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>{t('template')}</TableHead>
                      {COUNT_KEYS.map((k) => (
                        <TableHead key={k} className="text-right">{label(k)}</TableHead>
                      ))}
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {data.templates.map((row) => {
                      const rates = templateRates(row);
                      return (
                        <TableRow key={row.templateName}>
                          <TableCell className="font-medium break-all">{row.templateName}</TableCell>
                          <TableCell className="text-right tabular-nums">{num(row.sent)}</TableCell>
                          {RATE_KEYS.map((k) => (
                            <TableCell key={k} className="text-right tabular-nums">
                              {num(row[k])}
                              <span className="ml-1 text-xs text-muted-foreground">{pct(rates[k])}</span>
                            </TableCell>
                          ))}
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </div>
            </section>
          )}
        </>
      )}
    </div>
  );
}

function Totals({
  totals,
  pct,
  num,
}: {
  totals: TemplateCounts;
  pct: (v: number | null) => string;
  num: (v: number) => string;
}) {
  const t = useTranslations('Analytics.templates');
  const rates = templateRates(totals);
  return (
    <dl className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
      <div className="rounded-lg border border-border bg-card p-3">
        <dt className="text-xs text-muted-foreground">{t('metrics.sent')}</dt>
        <dd className="text-lg font-semibold tabular-nums text-foreground">{num(totals.sent)}</dd>
      </div>
      {RATE_KEYS.map((k) => (
        <div key={k} className="rounded-lg border border-border bg-card p-3">
          <dt className="text-xs text-muted-foreground">{t(`rates.${k}`)}</dt>
          <dd className="text-lg font-semibold tabular-nums text-foreground">{pct(rates[k])}</dd>
          <dd className="text-xs text-muted-foreground tabular-nums">{t('ofSent', { count: num(totals[k]) })}</dd>
        </div>
      ))}
    </dl>
  );
}
