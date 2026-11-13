'use client';

import { useFormatter, useTranslations } from 'next-intl';

import type { FlowStats } from '@/lib/analytics/queries';
import { BarChart } from '@/components/tremor/bar-chart';
import { quietSelect } from '@/components/dashboard/segmented';
import { ChartWithTable, Panel, ReportState } from './shared';

/** Drop-off rows drawn in the chart; the table lists all of them. */
const CHART_ROWS = 12;
const OUTCOMES = ['started', 'completed', 'handedOff', 'timedOut', 'failed', 'cancelled', 'active'] as const;

export function FlowDropOff({
  stats,
  flows,
  flowId,
  onFlowChange,
  loading,
  error,
  onRetry,
}: {
  stats: FlowStats | null;
  flows: { id: string; name: string }[];
  flowId: string;
  onFlowChange: (id: string) => void;
  loading: boolean;
  error: boolean;
  onRetry: () => void;
}) {
  const t = useTranslations('Analytics.flows');
  const format = useFormatter();
  const names = new Map(flows.map((flow) => [flow.id, flow.name]));
  const runs = t('runs');
  const node = (row: FlowStats['dropOff'][number]) =>
    `${flowId ? '' : `${names.get(row.flowId) ?? t('unknownFlow')} · `}${row.nodeKey}${row.nodeType ? ` (${row.nodeType})` : ''}`;
  const filter = (
    <label className="flex items-center gap-2 text-[13px]">
      <span className="text-muted-foreground">{t('filter')}</span>
      <select
        className={`${quietSelect} max-w-56`}
        value={flowId}
        onChange={(e) => onFlowChange(e.target.value)}
      >
        <option value="">{t('allFlows')}</option>
        {flows.map((flow) => (
          <option key={flow.id} value={flow.id}>
            {flow.name}
          </option>
        ))}
      </select>
    </label>
  );
  return (
    <Panel title={t('title')} description={t('description')} actions={flows.length > 0 ? filter : undefined}>
      <ReportState loading={loading} error={error} onRetry={onRetry} empty={!!stats && stats.started === 0}>
        {stats && (
          <div className="space-y-5">
            <dl className="grid grid-cols-2 gap-2.5 sm:grid-cols-4 lg:grid-cols-7">
              {OUTCOMES.map((key) => (
                <div key={key} className="rounded-xl bg-muted/60 px-3 py-2.5">
                  <dt className="text-xs text-muted-foreground">{t(`outcome.${key}`)}</dt>
                  <dd className="text-xl font-bold tracking-tight tabular-nums">{format.number(stats[key])}</dd>
                </div>
              ))}
            </dl>
            {stats.dropOff.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t('noDropOff')}</p>
            ) : (
              <>
                <ChartWithTable
                  label={t('dropOffTitle')}
                  chart={
                    <BarChart
                      className="h-72"
                      layout="vertical"
                      data={stats.dropOff.slice(0, CHART_ROWS).map((row) => ({ node: node(row), [runs]: row.runs }))}
                      index="node"
                      categories={[runs]}
                      colors={['chart1']}
                      valueFormatter={(n) => format.number(n)}
                      showLegend={false}
                      allowDecimals={false}
                      yAxisWidth={180}
                    />
                  }
                  columns={[t('node'), runs]}
                  rows={stats.dropOff.map((row) => [node(row), row.runs])}
                />
                <p className="text-xs text-muted-foreground">{t('dropOffHint')}</p>
              </>
            )}
          </div>
        )}
      </ReportState>
    </Panel>
  );
}

