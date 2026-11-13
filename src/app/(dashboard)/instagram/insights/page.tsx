'use client';

// Instagram › Insights: the comment funnel per post and per flow (Stage 3),
// with, from Stage 5 (5F), each flow's click-through rate, Instagram contacts
// per day (active, inactive, total), revenue from automations and conversion
// event counts. Counts and amounts only; the numbers come from
// GET /api/analytics/instagram, which any member may read (revenue is for
// agents and above). The Instagram section layout explains a channel that is off.

import { useState } from 'react';
import { useFormatter, useTranslations } from 'next-intl';

import { RangePicker, rangeParams, type RangeValue } from '@/components/analytics/range-picker';
import { ChartWithTable, DataTable, Panel, ReportState, reportQuery, useReport } from '@/components/analytics/shared';
import { BarChart } from '@/components/tremor/bar-chart';
import { Button } from '@/components/ui/button';
import type { ConversionCount } from '@/lib/analytics/conversion-log';
import type { ContactSeriesPoint } from '@/lib/instagram/contact-series';
import type { CommentFunnel, CommentFunnelBy } from '@/lib/instagram/funnel';
import type { InstagramRevenue } from '@/lib/instagram/revenue';

interface InsightsReport {
  range: { startDay: string; endDay: string };
  by: CommentFunnelBy;
  funnel: CommentFunnel;
  /** By flow: whole-percent CTR per flow id (null without a tracked link). */
  ctr?: Record<string, number | null>;
  contacts?: ContactSeriesPoint[];
  revenue?: InstagramRevenue;
  conversions?: ConversionCount[];
}

/** Share of `part` in `whole` as a whole percent, or null without a base. */
const percent = (part: number, whole: number) => (whole > 0 ? Math.round((part / whole) * 100) : null);

export default function InstagramInsightsPage() {
  const t = useTranslations('Instagram.insights');
  const format = useFormatter();
  const [range, setRange] = useState<RangeValue>({ preset: '30d' });
  const [by, setBy] = useState<CommentFunnelBy>('post');
  const report = useReport<InsightsReport>('instagram', reportQuery({ ...rangeParams(range), by }));
  const funnel = report.data?.funnel ?? null;
  const rate = (row: { optIns: number; comments: number }) => {
    const value = percent(row.optIns, row.comments);
    return value == null ? '–' : `${value}%`;
  };
  const ctr = (id: string | null) => {
    const value = id ? report.data?.ctr?.[id] : null;
    return value == null ? '–' : `${value}%`;
  };
  const label = (row: { id: string | null; name: string | null }) =>
    by === 'flow' ? (row.name ?? t('deletedFlow')) : row.id ? `…${row.id.slice(-8)}` : t('untitledPost');
  const columns = [by === 'post' ? t('post') : t('flow'), t('comments'), t('dms'), t('optIns'), t('optInRate'), t('clicks'),
    ...(by === 'flow' ? [t('ctr')] : []), t('leads'), t('follows')];
  return (
    <div className="studio-dashboard space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-[22px] font-bold tracking-tight text-foreground">{t('title')}</h1>
          <p className="mt-2 max-w-xl text-sm leading-relaxed text-muted-foreground">{t('description')}</p>
        </div>
        <div className="flex flex-col items-start gap-2 sm:items-end">
          <RangePicker value={range} onChange={setRange} today={range.preset === 'custom' ? undefined : report.data?.range.endDay} />
          <div role="group" aria-label={t('range')} className="flex gap-1">
            {(['post', 'flow'] as const).map((key) => (
              <Button key={key} size="sm" variant={by === key ? 'default' : 'outline'} aria-pressed={by === key} onClick={() => setBy(key)}>
                {key === 'post' ? t('byPost') : t('byFlow')}
              </Button>
            ))}
          </div>
        </div>
      </div>
      <Panel title={by === 'post' ? t('byPost') : t('byFlow')} description={t('clicksNote')}>
        <ReportState loading={report.loading} error={report.error} onRetry={report.retry} empty={!!funnel && funnel.totals.comments === 0}>
          {funnel && (
            <DataTable
              caption={by === 'post' ? t('byPost') : t('byFlow')}
              columns={columns}
              rows={funnel.rows.map((row) => [
                label(row), format.number(row.comments), format.number(row.dms), format.number(row.optIns), rate(row),
                format.number(row.clicks), ...(by === 'flow' ? [ctr(row.id)] : []), format.number(row.leads), format.number(row.follows),
              ])}
            />
          )}
        </ReportState>
      </Panel>

      <ContactsPanel report={report} />
      <RevenuePanel report={report} />
      <ConversionsPanel report={report} />
    </div>
  );
}

type Report = ReturnType<typeof useReport<InsightsReport>>;

/** Minor units (paise, cents) to the currency's major unit, by its own number of decimals. */
function toMajor(minor: number, currency: string): number {
  let digits = 2;
  try {
    digits = new Intl.NumberFormat('en', { style: 'currency', currency }).resolvedOptions().maximumFractionDigits ?? 2;
  } catch {
    // An unknown code keeps two decimals.
  }
  return minor / 10 ** digits;
}

function ContactsPanel({ report }: { report: Report }) {
  const t = useTranslations('Instagram.insights.contacts');
  const format = useFormatter();
  const series = report.data?.contacts ?? [];
  const last = series.at(-1);
  const active = t('active');
  const inactive = t('inactive');
  const data = series.map((point) => ({ day: point.day.slice(5), [active]: point.active, [inactive]: point.inactive }));
  return (
    <Panel title={t('title')} description={t('activeHelp')}>
      <ReportState loading={report.loading} error={report.error} onRetry={report.retry} empty={!last || last.total === 0}>
        <ChartWithTable
          label={t('title')}
          chart={<BarChart className="h-56" data={data} index="day" categories={[active, inactive]} colors={['emerald', 'gray']}
            type="stacked" valueFormatter={(value: number) => format.number(value)} allowDecimals={false} />}
          columns={[t('title'), active, inactive, t('total')]}
          rows={series.map((point) => [point.day, point.active, point.inactive, point.total])}
        />
      </ReportState>
    </Panel>
  );
}

function RevenuePanel({ report }: { report: Report }) {
  const t = useTranslations('Instagram.insights.revenue');
  const tFlows = useTranslations('Instagram.insights');
  const format = useFormatter();
  const revenue = report.data?.revenue;
  // A viewer cannot read payment links (agents and above): the panel is left out.
  if (revenue && !revenue.visible) return null;
  const main = revenue?.currencies[0];
  const money = (minor: number | null, currency: string) =>
    minor == null ? '–' : format.number(toMajor(minor, currency), { style: 'currency', currency });
  const earned = t('earned');
  return (
    <Panel title={t('title')}>
      <ReportState loading={report.loading} error={report.error} onRetry={report.retry} empty={!main}>
        {main && (
          <div className="space-y-5">
            <dl className="grid grid-cols-2 gap-3 sm:grid-cols-5">
              {([
                [earned, money(main.earned, main.currency)],
                [t('sales'), format.number(main.sales)],
                [t('buyers'), format.number(main.buyers)],
                [t('perBuyer'), money(main.perBuyer, main.currency)],
                [t('perContact'), money(main.perContact, main.currency)],
              ] as const).map(([name, value]) => (
                <div key={name} className="rounded-lg border border-border p-3">
                  <dt className="text-xs text-muted-foreground">{name}</dt>
                  <dd className="mt-1 text-lg font-semibold tabular-nums text-foreground">{value}</dd>
                </div>
              ))}
            </dl>
            <ChartWithTable
              label={t('chart')}
              chart={<BarChart className="h-48" data={main.series.map((point) => ({ day: point.day.slice(5), [earned]: toMajor(point.earned, main.currency) }))}
                index="day" categories={[earned]} colors={['emerald']} showLegend={false}
                valueFormatter={(value: number) => format.number(value, { style: 'currency', currency: main.currency })} />}
              columns={[t('chart'), earned]}
              rows={main.series.map((point) => [point.day, money(point.earned, main.currency)])}
            />
            <DataTable
              caption={t('perFlow')}
              captionHidden={false}
              columns={[tFlows('flow'), earned, t('sales')]}
              rows={main.byFlow.map((flow) => [flow.name ?? tFlows('deletedFlow'), money(flow.earned, main.currency), format.number(flow.sales)])}
            />
            {revenue.currencies.length > 1 && (
              <DataTable
                caption={t('title')}
                columns={['', earned, t('sales')]}
                rows={revenue.currencies.slice(1).map((other) => [other.currency, money(other.earned, other.currency), format.number(other.sales)])}
              />
            )}
          </div>
        )}
      </ReportState>
    </Panel>
  );
}

function ConversionsPanel({ report }: { report: Report }) {
  const t = useTranslations('Instagram.insights.conversions');
  const format = useFormatter();
  const counts = report.data?.conversions ?? [];
  return (
    <Panel title={t('title')}>
      <ReportState loading={report.loading} error={report.error} onRetry={report.retry} empty={counts.every((row) => row.count === 0)}>
        <DataTable
          caption={t('title')}
          columns={[t('event'), t('count')]}
          rows={counts.map((row) => [row.name, format.number(row.count)])}
        />
      </ReportState>
    </Panel>
  );
}
