'use client';

/**
 * Analytics > Analytics (the prototype's Overview): six headline cards that
 * open the tab explaining them, new and resolved conversations over time,
 * what needs attention now, the channel split (pick a channel to filter every
 * tab) and the busiest hours. The workspace's commerce and AI sections follow
 * for members who can see them.
 */

import { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, ChevronRight, Clock, Inbox, Lock, Workflow, UserRound } from 'lucide-react';
import Link from 'next/link';
import { useFormatter, useTranslations } from 'next-intl';

import { useAuth } from '@/hooks/use-auth';
import { hasMinRole } from '@/lib/auth/roles';
import type { AttentionCounts, TrendReport } from '@/lib/analytics/insights';
import type { AiStats } from '@/lib/analytics/queries';
import { AiSection } from '@/components/analytics/ai-section';
import { AiInsightsPanel } from '@/components/analytics/ai-insights';
import { CommerceCard } from '@/components/analytics/commerce-card';
import type { OverviewReport } from '@/components/analytics/overview-section';
import { useDuration, useReport } from '@/components/analytics/shared';
import { cn } from '@/lib/utils';
import { CHART_COLORS, Donut, DonutWithKey, Heatmap, KeyRow, Legend, XYChart } from './charts';
import { useAnalyticsFilters } from './context';
import { useBucketLabels, useDelta, useHourLabel } from './format';
import { Grid, InsightCard, Loadable, StatRow } from './parts';

export interface TrendsResponse {
  range: { startDay: string; endDay: string; days: number; timezone: string };
  previousRange: { startDay: string; endDay: string };
  trend: TrendReport;
  previousMessages: { msgs: number; failed: number };
}

/** Loads the overview and trend reports and publishes the shown range and number list to the header. */
export function useConversationReports() {
  const { query, setShown, setNumbers } = useAnalyticsFilters();
  const overview = useReport<OverviewReport>('overview', query);
  const trends = useReport<TrendsResponse>('trends', query);
  const data = overview.data;
  useEffect(() => {
    if (data) {
      setShown({ range: data.range, previousRange: data.previousRange });
      if (data.numbers.length) setNumbers(data.numbers);
    }
  }, [data, setShown, setNumbers]);
  return { overview, trends };
}

export function OverviewTab() {
  const t = useTranslations('Analytics.insights.overview');
  const tc = useTranslations('Analytics.channel');
  const format = useFormatter();
  const duration = useDuration();
  const delta = useDelta();
  const hourLabel = useHourLabel();
  const labels = useBucketLabels();
  const { accountRole } = useAuth();
  const { channel, setChannel, query, range, rangeQuery } = useAnalyticsFilters();
  const { overview, trends } = useConversationReports();
  const attention = useReport<{ attention: AttentionCounts }>('attention', query);
  const canSeeAi = accountRole ? hasMinRole(accountRole, 'agent') : false;
  const ai = useReport<{ stats: AiStats }>('ai', rangeQuery, canSeeAi);
  const [hidden, setHidden] = useState<Set<string>>(new Set());

  const o = overview.data, tr = trends.data;
  const n = (v: number) => format.number(v);
  const stats = [
    { label: t('stats.new'), value: o ? n(o.current.started.total) : '–', delta: o && delta(o.current.started.total, o.previous.started.total), href: '/analytics/conversations' },
    { label: t('stats.resolved'), value: o ? n(o.current.resolution.resolved) : '–', delta: o && delta(o.current.resolution.resolved, o.previous.resolution.resolved), href: '/analytics/conversations' },
    { label: t('stats.firstResponse'), value: o ? duration(o.current.firstResponse.medianSeconds) : '–', delta: o && delta(o.current.firstResponse.medianSeconds, o.previous.firstResponse.medianSeconds, true), href: '/analytics/conversations' },
    { label: t('stats.resolution'), value: o ? duration(o.current.resolution.medianSeconds) : '–', delta: o && delta(o.current.resolution.medianSeconds, o.previous.resolution.medianSeconds, true), href: '/analytics/conversations' },
    { label: t('stats.messages'), value: tr ? n(tr.trend.totals.msgs) : '–', delta: tr && delta(tr.trend.totals.msgs, tr.previousMessages.msgs), href: '/analytics/campaigns' },
    { label: t('stats.teamReply'), value: o ? duration(o.current.humanFirstResponse.medianSeconds) : '–', delta: o && delta(o.current.humanFirstResponse.medianSeconds, o.previous.humanFirstResponse.medianSeconds, true), href: '/analytics/team' },
  ];

  const series = useMemo(() => tr ? [
    { key: 'new', name: t('series.new'), color: CHART_COLORS.primary, area: true, values: tr.trend.points.map((p) => p.newC) },
    { key: 'resolved', name: t('series.resolved'), color: CHART_COLORS.secondary, dash: true, values: tr.trend.points.map((p) => p.resolved) },
  ] : [], [tr, t]);
  const bucket = tr?.trend.bucket ?? 'day';
  const split = tr ? tr.trend.channels.map((c) => ({ key: c.key, name: tc(c.key as 'whatsapp' | 'instagram'), color: c.key === 'whatsapp' ? CHART_COLORS.whatsapp : CHART_COLORS.instagram, value: c.newC })) : [];
  const splitSum = split.reduce((a, s) => a + s.value, 0);
  const hours = tr?.trend.hours ?? [];
  const busiest = hours.length ? hours.indexOf(Math.max(...hours)) : 0;
  const pick = (key: string) => setChannel(channel === key ? '' : (key as 'whatsapp' | 'instagram'));

  return (
    <div className="space-y-4">
      <StatRow stats={stats} loading={overview.loading} />
      <Grid>
        <InsightCard span={8} title={t('trendTitle')} sub={t('trendSub', { bucket: labels.word(bucket).toLowerCase() })}
          tools={series.length > 0 && <Legend series={series} hidden={hidden} onToggle={(k) => setHidden((h) => { const next = new Set(h); if (next.has(k)) next.delete(k); else next.add(k); return next; })} />}>
          <Loadable loading={trends.loading} error={trends.error} onRetry={trends.retry} height="h-[250px]">
            {tr && (
              <XYChart label={t('trendTitle')} height={250} labels={tr.trend.points.map((p) => labels.short(p.key, bucket))}
                long={tr.trend.points.map((p) => labels.long(p.key, bucket))} series={series.filter((s) => !hidden.has(s.key))}
                format={(v) => n(v ?? 0)} />
            )}
          </Loadable>
        </InsightCard>
        <InsightCard span={4} title={t('attentionTitle')} sub={t('attentionSub')}>
          <Loadable loading={attention.loading} error={attention.error} onRetry={attention.retry} height="h-40">
            {attention.data && <AttentionList counts={attention.data.attention} />}
          </Loadable>
        </InsightCard>
        <InsightCard span={4} title={t('splitTitle')} sub={t('splitSub')}>
          <Loadable loading={trends.loading} error={trends.error} onRetry={trends.retry} height="h-40">
            <DonutWithKey donut={<Donut label={t('splitTitle')} segments={split} centre={n(splitSum)} sub={t('conversations')} format={n} onPick={pick} />}>
              {split.map((s) => (
                <KeyRow key={s.key} color={s.color} name={s.name} value={n(s.value)} share={splitSum ? `${Math.round((s.value / splitSum) * 100)}%` : '0%'}
                  pressed={channel === s.key} onClick={() => pick(s.key)} />
              ))}
            </DonutWithKey>
          </Loadable>
        </InsightCard>
        <InsightCard span={8} title={t('busiestTitle')}
          sub={tr && tr.trend.totals.newC ? t('busiestSub', { hour: hourLabel(busiest) }) : t('busiestNone')}>
          <Loadable loading={trends.loading} error={trends.error} onRetry={trends.retry} height="h-16">
            <Heatmap values={hours.length ? hours : Array(24).fill(0)} hourLabel={hourLabel}
              describe={(h, v) => t('busiestCell', { from: hourLabel(h), to: hourLabel(h + 1), count: v })} />
          </Loadable>
        </InsightCard>
      </Grid>
      {canSeeAi && channel !== 'instagram' && <CommerceCard query={rangeQuery} />}
      {canSeeAi && <AiSection stats={ai.data?.stats ?? null} loading={ai.loading} error={ai.error} onRetry={ai.retry} />}
      {canSeeAi && <AiInsightsPanel range={range} />}
    </div>
  );
}

const ATTENTION = [
  { key: 'unowned', icon: UserRound, tone: 'warn', href: '/inbox?filter=unassigned' },
  { key: 'unread', icon: Inbox, tone: '', href: '/inbox?filter=unread' },
  { key: 'closingSoon', icon: Clock, tone: 'warn', href: '/inbox?filter=expiring-soon' },
  { key: 'needsTemplate', icon: Lock, tone: '', href: '/inbox?filter=waiting' },
  { key: 'failedToday', icon: AlertTriangle, tone: 'bad', href: '/inbox?filter=failed' },
  { key: 'switchedOff', icon: Workflow, tone: '', href: '/automation' },
] as const;

function AttentionList({ counts }: { counts: AttentionCounts }) {
  const t = useTranslations('Analytics.insights.attention');
  const format = useFormatter();
  const items = ATTENTION.filter((a) => counts[a.key] > 0);
  if (!items.length) return <p className="py-5 text-center text-sm text-muted-foreground">{t('allClear')}</p>;
  return (
    <ul className="-mx-1.5 -my-1 grid grid-cols-1 gap-0.5">
      {items.map((a) => {
        const count = counts[a.key];
        const shown = count > 999 ? '999+' : format.number(count);
        const Icon = a.icon;
        return (
          <li key={a.key}>
            <Link href={a.href} className="flex w-full items-center gap-3 rounded-lg px-2 py-2 text-left text-muted-foreground transition-colors duration-150 outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring/50">
              <span className={cn('inline-flex size-[34px] shrink-0 items-center justify-center rounded-[10px]',
                a.tone === 'warn' ? 'bg-amber-500/15 text-amber-700 dark:text-amber-400' : a.tone === 'bad' ? 'bg-destructive/12 text-destructive' : 'bg-primary-soft text-primary')}>
                <Icon className="size-4" aria-hidden />
              </span>
              <span className="min-w-0 flex-1">
                <strong className="block text-sm font-semibold text-foreground">{t(`${a.key}.title`, { count, shown })}</strong>
                <small className="block truncate text-xs">{a.key === 'switchedOff' && counts.switchedOffNames.length ? counts.switchedOffNames.join(', ') : t(`${a.key}.sub`)}</small>
              </span>
              <ChevronRight className="size-4 shrink-0" aria-hidden />
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
