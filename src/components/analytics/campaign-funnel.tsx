'use client';

import { useFormatter, useTranslations } from 'next-intl';

import type { CampaignFunnel as Funnel, FunnelCounts } from '@/lib/analytics/queries';
import { BarChart } from '@/components/tremor/bar-chart';
import { ChartWithTable, DataTable, Panel, ReportState } from './shared';

const STAGES = ['sent', 'delivered', 'read', 'replied', 'clicked'] as const;

/** Share of `part` in `whole` as a whole percent, or null without a base. */
export function rate(part: number, whole: number): number | null {
  return whole > 0 ? Math.round((part / whole) * 100) : null;
}

export function CampaignFunnel({
  funnel,
  loading,
  error,
  onRetry,
}: {
  funnel: Funnel | null;
  loading: boolean;
  error: boolean;
  onRetry: () => void;
}) {
  const t = useTranslations('Analytics.campaigns');
  const format = useFormatter();
  const count = t('recipients');
  const totals: FunnelCounts | undefined = funnel?.totals;
  const stages = totals ? STAGES.map((stage) => ({ name: t(`stage.${stage}`), [count]: totals[stage] })) : [];
  const percent = (part: number, whole: number) => {
    const value = rate(part, whole);
    return value == null ? '–' : t('percent', { value });
  };
  return (
    <Panel title={t('title')} description={t('description')}>
      <ReportState loading={loading} error={error} onRetry={onRetry} empty={!!totals && totals.recipients === 0}>
        {totals && (
          <div className="space-y-5">
            <ChartWithTable
              label={t('funnelLabel')}
              chart={
                <BarChart className="h-56" data={stages} index="name" categories={[count]} colors={['chart1']}
                  valueFormatter={(n) => format.number(n)} showLegend={false} allowDecimals={false} />
              }
              columns={[t('stageColumn'), count, t('ofSent')]}
              rows={stages.map((s) => [s.name, s[count] as number, percent(s[count] as number, totals.sent)])}
            />
            {totals.failed > 0 && <p className="text-xs text-muted-foreground">{t('failed', { count: totals.failed })}</p>}
            <DataTable
              caption={t('perCampaign')}
              captionHidden={false}
              columns={[t('campaign'), count, t('stage.delivered'), t('stage.read'), t('stage.replied'), t('stage.clicked'), t('stage.failed')]}
              rows={(funnel?.broadcasts ?? []).map((b) => [
                <span key="name" className="flex flex-col">
                  <span>{b.name}</span>
                  <span className="text-xs text-muted-foreground">{b.templateName}</span>
                </span>,
                format.number(b.recipients),
                percent(b.delivered, b.sent),
                percent(b.read, b.sent),
                percent(b.replied, b.sent),
                percent(b.clicked, b.sent),
                format.number(b.failed),
              ])}
            />
          </div>
        )}
      </ReportState>
    </Panel>
  );
}
