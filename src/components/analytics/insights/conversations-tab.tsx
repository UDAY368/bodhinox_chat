'use client';

/**
 * Analytics > Conversations: how fast customers get a reply and how chats
 * end. First-response median and 90th percentile over time, open and closed,
 * the resolution-time spread, by channel, by label, and a sortable breakdown
 * by hour, day or week with CSV export. The existing state, source and timing
 * panels follow.
 */

import { useMemo, useState } from 'react';
import { Download } from 'lucide-react';
import { useFormatter, useTranslations } from 'next-intl';

import { Button } from '@/components/ui/button';
import { ConversationCharts } from '@/components/analytics/overview-section';
import { useDuration } from '@/components/analytics/shared';
import { BarList, CHART_COLORS, Donut, DonutWithKey, KeyRow, Legend, XYChart } from './charts';
import { useAnalyticsFilters } from './context';
import { downloadCsv } from './csv';
import { useBucketLabels, useDelta } from './format';
import { useConversationReports } from './overview-tab';
import { Grid, InsightCard, Loadable, SortableTable, StatRow, type Column } from './parts';
import type { GroupRow } from '@/lib/analytics/insights';

const LABEL_COLORS: Record<string, string> = {
  gray: '#8e8e93', red: '#ff453a', orange: '#ff9f0a', amber: '#f5a524', green: '#30d158', teal: '#40c8e0',
  blue: '#0a84ff', violet: '#bf5af2', pink: '#ff375f',
};

export function ConversationsTab() {
  const t = useTranslations('Analytics.insights.conversations');
  const tc = useTranslations('Analytics.channel');
  const format = useFormatter();
  const duration = useDuration();
  const delta = useDelta();
  const labels = useBucketLabels();
  const { channel } = useAnalyticsFilters();
  const { overview, trends } = useConversationReports();
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [all, setAll] = useState(false);
  const o = overview.data, tr = trends.data;
  const n = (v: number) => format.number(v);
  const minutes = (s: number | null) => (s == null ? 0 : Math.round((s / 60) * 10) / 10);
  const rate = (g: GroupRow | undefined) => (g && g.newC ? (g.closed / g.newC) * 100 : null);
  const bucket = tr?.trend.bucket ?? 'day';

  const stats = [
    { label: t('stats.firstResponse'), value: o ? duration(o.current.firstResponse.medianSeconds) : '–', delta: o && delta(o.current.firstResponse.medianSeconds, o.previous.firstResponse.medianSeconds, true) },
    { label: t('stats.p90'), value: o ? duration(o.current.firstResponse.p90Seconds) : '–', delta: o && delta(o.current.firstResponse.p90Seconds, o.previous.firstResponse.p90Seconds, true) },
    { label: t('stats.resolution'), value: o ? duration(o.current.resolution.medianSeconds) : '–', delta: o && delta(o.current.resolution.medianSeconds, o.previous.resolution.medianSeconds, true) },
    { label: t('stats.rate'), value: tr && rate(tr.trend.totals) != null ? `${Math.round(rate(tr.trend.totals)!)}%` : '–' },
  ];

  const response = useMemo(() => tr ? [
    { key: 'median', name: t('median'), color: CHART_COLORS.primary, area: true, values: tr.trend.points.map((p) => minutes(p.frtMedian)) },
    { key: 'p90', name: t('p90'), color: CHART_COLORS.secondary, dash: true, values: tr.trend.points.map((p) => minutes(p.frtP90)) },
  ] : [], [tr, t]);
  const perChannel = tr ? tr.trend.channels.filter((c) => !channel || c.key === channel) : [];
  const spreadLabels = [t('spread.under1h'), t('spread.1to4h'), t('spread.4to12h'), t('spread.12to24h'), t('spread.overDay')];
  const totals = tr?.trend.totals;
  const closed = totals?.closed ?? 0, open = (totals?.newC ?? 0) - closed;
  const labelRows = (tr?.trend.labels ?? []).slice().sort((a, b) => b.newC - a.newC).map((l) => ({
    key: l.id, name: l.id === 'none' ? t('noLabel') : l.name, value: l.newC, text: n(l.newC),
    color: l.id === 'none' ? CHART_COLORS.secondary : LABEL_COLORS[l.color ?? ''] ?? CHART_COLORS.primary,
  }));

  type Row = GroupRow & { label: string; index: number };
  const rows: Row[] = (tr?.trend.points ?? []).map((p, index) => ({ ...p, index, label: labels.long(p.key, bucket) }));
  const word = labels.word(bucket);
  const columns: Column<Row>[] = [
    { key: 'index', label: word, sort: (r) => r.index, cell: (r) => r.label },
    { key: 'newC', label: t('cols.new'), numeric: true, sort: (r) => r.newC, cell: (r) => n(r.newC) },
    { key: 'resolved', label: t('cols.resolved'), numeric: true, sort: (r) => r.resolved, cell: (r) => n(r.resolved) },
    { key: 'frt', label: t('cols.firstResponse'), numeric: true, sort: (r) => r.frtMedian ?? -1, cell: (r) => duration(r.frtMedian) },
    { key: 'res', label: t('cols.resolution'), numeric: true, sort: (r) => r.resMedian ?? -1, cell: (r) => duration(r.resMedian) },
    { key: 'failed', label: t('cols.failed'), numeric: true, sort: (r) => r.failed, cell: (r) => n(r.failed) },
  ];
  const exportRows = () => downloadCsv(`${t('fileName')} ${o?.range.startDay ?? ''} ${o?.range.endDay ?? ''}`,
    [word, t('cols.new'), t('cols.resolved'), t('cols.firstResponseSeconds'), t('cols.resolutionSeconds'), t('cols.failed')],
    rows.map((r) => [r.label, r.newC, r.resolved, r.frtMedian ?? '', r.resMedian ?? '', r.failed]));

  return (
    <div className="space-y-4">
      <StatRow stats={stats} loading={overview.loading} />
      <Grid>
        <InsightCard span={8} title={t('responseTitle')} sub={t('responseSub')}
          tools={response.length > 0 && <Legend series={response} hidden={hidden} onToggle={(k) => setHidden((h) => { const next = new Set(h); if (next.has(k)) next.delete(k); else next.add(k); return next; })} />}>
          <Loadable loading={trends.loading} error={trends.error} onRetry={trends.retry} height="h-[220px]">
            {tr && (
              <XYChart label={t('responseTitle')} labels={tr.trend.points.map((p) => labels.short(p.key, bucket))}
                long={tr.trend.points.map((p) => labels.long(p.key, bucket))} series={response.filter((s) => !hidden.has(s.key))}
                integer={false} format={(v) => t('minutesValue', { value: format.number(v ?? 0, { maximumFractionDigits: 1 }) })}
                axisFormat={(v) => t('minutesAxis', { value: format.number(v, { maximumFractionDigits: 1 }) })} />
            )}
          </Loadable>
        </InsightCard>
        <InsightCard span={4} title={t('openTitle')} sub={t('openSub')}>
          <Loadable loading={trends.loading} error={trends.error} onRetry={trends.retry} height="h-40">
            <DonutWithKey donut={
              <Donut label={t('openTitle')} format={n} centre={rate(totals) == null ? '–' : `${Math.round(rate(totals)!)}%`} sub={t('closedWord')}
                segments={[{ key: 'closed', name: t('closed'), color: CHART_COLORS.primary, value: closed }, { key: 'open', name: t('open'), color: CHART_COLORS.secondary, value: Math.max(0, open) }]} />
            }>
              <KeyRow color={CHART_COLORS.primary} name={t('closed')} value={n(closed)} />
              <KeyRow color={CHART_COLORS.secondary} name={t('open')} value={n(Math.max(0, open))} />
            </DonutWithKey>
          </Loadable>
        </InsightCard>
        <InsightCard span={6} title={t('spreadTitle')} sub={t('spreadSub')}>
          <Loadable loading={trends.loading} error={trends.error} onRetry={trends.retry} height="h-[200px]">
            {tr && <XYChart type="bars" height={200} label={t('spreadTitle')} labels={spreadLabels}
              series={[{ key: 'n', name: t('conversations'), color: CHART_COLORS.primary, values: tr.trend.resolutionSpread }]} format={(v) => n(v ?? 0)} />}
          </Loadable>
        </InsightCard>
        <InsightCard span={6} title={t('channelTitle')} sub={t('channelSub')}>
          <Loadable loading={trends.loading} error={trends.error} onRetry={trends.retry} height="h-[200px]">
            {tr && <XYChart type="bars" height={200} label={t('channelTitle')} labels={perChannel.map((c) => tc(c.key as 'whatsapp' | 'instagram'))}
              series={[
                { key: 'new', name: t('cols.new'), color: CHART_COLORS.primary, values: perChannel.map((c) => c.newC) },
                { key: 'resolved', name: t('cols.resolved'), color: CHART_COLORS.secondary, values: perChannel.map((c) => c.resolved) },
              ]} format={(v) => n(v ?? 0)} />}
          </Loadable>
        </InsightCard>
        <InsightCard title={t('labelTitle')} sub={t('labelSub')}>
          <Loadable loading={trends.loading} error={trends.error} onRetry={trends.retry} height="h-24">
            <BarList label={t('labelTitle')} rows={labelRows} />
          </Loadable>
        </InsightCard>
        <InsightCard title={t('breakdownTitle', { bucket: word.toLowerCase() })} sub={t('breakdownSub')}
          tools={<Button size="sm" variant="outline" onClick={exportRows} disabled={!rows.length}><Download aria-hidden />{t('exportCsv')}</Button>}>
          <Loadable loading={trends.loading} error={trends.error} onRetry={trends.retry}>
            <SortableTable caption={t('breakdownTitle', { bucket: word.toLowerCase() })} columns={columns} rows={rows} rowKey={(r) => r.key}
              initial={{ key: 'index', dir: 1 }} limit={all ? undefined : 10} />
            {rows.length > 10 && (
              <div className="mt-3 flex justify-center">
                <Button size="sm" variant="ghost" onClick={() => setAll((v) => !v)} aria-expanded={all}>
                  {all ? t('showFewer') : t('showAll', { count: rows.length })}
                </Button>
              </div>
            )}
          </Loadable>
        </InsightCard>
      </Grid>
      <ConversationCharts data={o} loading={overview.loading} error={overview.error} onRetry={overview.retry} />
    </div>
  );
}
