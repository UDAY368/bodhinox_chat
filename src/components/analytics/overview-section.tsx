'use client';

import { CheckCircle2, Clock, MessageSquare, Timer } from 'lucide-react';
import { useFormatter, useTranslations } from 'next-intl';

import type { ConversationStats } from '@/lib/analytics/queries';
import { BarChart } from '@/components/tremor/bar-chart';
import { MetricCard } from '@/components/dashboard/metric-card';
import { SkeletonCard } from '@/components/dashboard/skeleton';
import { Button } from '@/components/ui/button';
import { ChartWithTable, Panel, ReportState, useDuration } from './shared';

export interface OverviewReport {
  range: { startDay: string; endDay: string; days: number };
  previousRange: { startDay: string; endDay: string };
  current: ConversationStats;
  previous: ConversationStats;
  numbers: { id: string; label: string | null; isDefault: boolean }[];
}

/** Percent change, or null when there is no baseline. */
export function percentChange(current: number | null, previous: number | null): number | null {
  if (current == null || previous == null || previous === 0) return null;
  return Math.round(((current - previous) / previous) * 100);
}

/**
 * The four headline tiles. Skeletons only while loading; a failed report shows
 * its error with a retry when `onRetry` is given, and nothing otherwise.
 */
export function OverviewTiles({
  data,
  loading,
  error = false,
  onRetry,
}: {
  data: OverviewReport | null;
  loading: boolean;
  error?: boolean;
  onRetry?: () => void;
}) {
  const t = useTranslations('Analytics.overview');
  const tAnalytics = useTranslations('Analytics');
  const duration = useDuration();
  const format = useFormatter();
  if (loading)
    return (
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => <SkeletonCard key={i} />)}
      </div>
    );
  if (!data) {
    if (!error || !onRetry) return null;
    return (
      <div role="alert" className="flex flex-wrap items-center gap-3 text-sm text-muted-foreground">
        {tAnalytics('page.overviewFailed')}
        <Button size="sm" variant="outline" onClick={onRetry}>
          {tAnalytics('retry')}
        </Button>
      </div>
    );
  }
  const { current, previous } = data;
  // For durations a drop is an improvement, so the tone follows -change.
  const delta = (now: number | null, before: number | null, lowerIsBetter = false) => {
    const change = percentChange(now, before);
    if (change == null) return { sign: 0, label: t('noBaseline') };
    return {
      sign: lowerIsBetter ? -change : change,
      label: change === 0 ? t('noChange') : t('change', { change: `${change > 0 ? '+' : ''}${change}` }),
    };
  };
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
      <MetricCard
        title={t('started')}
        value={format.number(current.started.total)}
        icon={MessageSquare}
        delta={delta(current.started.total, previous.started.total)}
      />
      <MetricCard
        title={t('firstResponse')}
        value={duration(current.firstResponse.medianSeconds)}
        icon={Clock}
        delta={delta(current.firstResponse.medianSeconds, previous.firstResponse.medianSeconds, true)}
      />
      <MetricCard
        title={t('resolutionTime')}
        value={duration(current.resolution.medianSeconds)}
        icon={Timer}
        delta={delta(current.resolution.medianSeconds, previous.resolution.medianSeconds, true)}
      />
      <MetricCard
        title={t('resolved')}
        value={format.number(current.resolution.resolved)}
        icon={CheckCircle2}
        delta={delta(current.resolution.resolved, previous.resolution.resolved)}
      />
    </div>
  );
}

export function ConversationCharts({
  data,
  loading,
  error,
  onRetry,
}: {
  data: OverviewReport | null;
  loading: boolean;
  error: boolean;
  onRetry: () => void;
}) {
  const t = useTranslations('Analytics.overview');
  const duration = useDuration();
  const format = useFormatter();
  const stats = data?.current;
  const count = t('count');
  const states = stats
    ? (['bot', 'requesting', 'assigned', 'resolved'] as const).map((key) => ({ name: t(`state.${key}`), [count]: stats.byLifecycle[key] }))
    : [];
  const sources = stats
    ? (['inbound', 'business', 'campaignReply', 'ad'] as const).map((key) => ({ name: t(`source.${key}`), [count]: stats.started[key] }))
    : [];
  const minutes = t('minutes');
  const timing = stats
    ? [
        { name: t('firstResponse'), median: stats.firstResponse.medianSeconds, p90: stats.firstResponse.p90Seconds, n: stats.firstResponse.count },
        { name: t('humanFirstResponse'), median: stats.humanFirstResponse.medianSeconds, p90: stats.humanFirstResponse.p90Seconds, n: stats.humanFirstResponse.count },
        { name: t('resolutionTime'), median: stats.resolution.medianSeconds, p90: stats.resolution.p90Seconds, n: stats.resolution.count },
      ]
    : [];
  const median = t('median'), p90 = t('p90');
  const number = (n: number) => format.number(n);

  return (
    <div className="grid grid-cols-1 gap-3.5 lg:grid-cols-2">
      <Panel title={t('byStateTitle')} description={t('byStateDescription')}>
        <ReportState loading={loading} error={error} onRetry={onRetry} empty={!!stats && states.every((s) => s[count] === 0)}>
          <ChartWithTable
            label={t('byStateTitle')}
            chart={<BarChart className="h-56" data={states} index="name" categories={[count]} colors={['chart1']} valueFormatter={number} showLegend={false} allowDecimals={false} />}
            columns={[t('stateColumn'), count]}
            rows={states.map((s) => [s.name, s[count] as number])}
          />
        </ReportState>
      </Panel>
      <Panel title={t('bySourceTitle')} description={t('bySourceDescription')}>
        <ReportState loading={loading} error={error} onRetry={onRetry} empty={!!stats && stats.started.total === 0}>
          <ChartWithTable
            label={t('bySourceTitle')}
            chart={<BarChart className="h-56" data={sources} index="name" categories={[count]} colors={['chart1']} valueFormatter={number} showLegend={false} allowDecimals={false} />}
            columns={[t('sourceColumn'), count]}
            rows={sources.map((s) => [s.name, s[count] as number])}
          />
        </ReportState>
      </Panel>
      <div className="lg:col-span-2">
        <Panel title={t('timingTitle')} description={t('timingDescription')}>
          <ReportState loading={loading} error={error} onRetry={onRetry} empty={!!stats && timing.every((r) => r.n === 0)}>
            <ChartWithTable
              label={t('timingTitle')}
              chart={
                <BarChart
                  className="h-56"
                  data={timing.map((r) => ({ name: r.name, [median]: toMinutes(r.median), [p90]: toMinutes(r.p90) }))}
                  index="name"
                  categories={[median, p90]}
                  colors={['chart1', 'soft']}
                  valueFormatter={(v) => t('minutesValue', { value: format.number(v, { maximumFractionDigits: 1 }) })}
                  yAxisLabel={minutes}
                  yAxisWidth={84}
                />
              }
              columns={[t('metricColumn'), median, p90, t('samples')]}
              rows={timing.map((r) => [r.name, duration(r.median), duration(r.p90), r.n])}
            />
            {stats && stats.firstResponse.unanswered > 0 && (
              <p className="mt-3 text-xs text-muted-foreground">{t('unanswered', { count: stats.firstResponse.unanswered })}</p>
            )}
          </ReportState>
        </Panel>
      </div>
    </div>
  );
}

function toMinutes(seconds: number | null): number {
  return seconds == null ? 0 : Math.round((seconds / 60) * 10) / 10;
}
