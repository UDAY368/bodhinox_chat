'use client';

/**
 * Comparisons on the analytics page (Phase 12 design §5.2): campaigns side by
 * side (pick 2-5 from the period's campaigns), appointment outcomes per
 * service, and top products by net revenue (agent and above; the page passes
 * showProducts only then). Each tab loads its report only while it is open.
 */
import { useState } from 'react';
import { useFormatter, useLocale, useTranslations } from 'next-intl';

import type { ProductStatsRow } from '@/lib/analytics/products';
import type { CampaignFunnel, FunnelCounts } from '@/lib/analytics/queries';
import { formatMoney } from '@/lib/commerce/money';
import { BarChart } from '@/components/tremor/bar-chart';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { ChartWithTable, DataTable, Panel, ReportState, reportQuery, useReport } from './shared';

const MAX_CAMPAIGNS = 5;
const FUNNEL_STAGES = ['sent', 'delivered', 'read', 'replied', 'clicked'] as const;

type Campaign = CampaignFunnel['broadcasts'][number];

interface ServiceRow {
  serviceId: string;
  name: string;
  booked: number;
  confirmed: number;
  cancelled: number;
  completed: number;
  noShow: number;
  noShowRate: number | null;
}

/** Share of sent as a whole percent, or null without sends. */
export function shareOfSent(counts: FunnelCounts, stage: (typeof FUNNEL_STAGES)[number]): number | null {
  return counts.sent > 0 ? Math.round((counts[stage] / counts.sent) * 1000) / 10 : null;
}

/**
 * The picked campaigns still listed for the current range. Ids the range no
 * longer lists stay out of the report and the cap, so they can never lock
 * the visible checkboxes.
 */
export function visibleSelection(selected: readonly string[], campaigns: readonly { id: string }[]): string[] {
  return selected.filter((id) => campaigns.some((campaign) => campaign.id === id));
}

/** Chart labels, one per row: a repeated campaign name gets its position, so two series never merge. */
export function uniqueLabels(names: readonly string[]): string[] {
  return names.map((name, i) => (names.indexOf(name) === i ? name : `${name} (${i + 1})`));
}

export function CompareSection({
  query,
  campaigns,
  showProducts,
}: {
  /** The page's range query string (reportQuery(rangeParams(range))). */
  query: string;
  /** The period's campaigns, from the campaign funnel report, to pick from. */
  campaigns: Campaign[];
  showProducts: boolean;
}) {
  const t = useTranslations('Analytics.compare');
  const [tab, setTab] = useState('campaigns');
  return (
    <Panel title={t('title')} description={t('description')}>
      <Tabs value={tab} onValueChange={(value) => setTab(String(value))}>
        <TabsList>
          <TabsTrigger value="campaigns">{t('tabs.campaigns')}</TabsTrigger>
          <TabsTrigger value="services">{t('tabs.services')}</TabsTrigger>
          {showProducts && <TabsTrigger value="products">{t('tabs.products')}</TabsTrigger>}
        </TabsList>
        <TabsContent value="campaigns" className="pt-4">
          {tab === 'campaigns' && <CampaignCompare campaigns={campaigns} />}
        </TabsContent>
        <TabsContent value="services" className="pt-4">
          {tab === 'services' && <ServiceCompare query={query} />}
        </TabsContent>
        {showProducts && (
          <TabsContent value="products" className="pt-4">
            {tab === 'products' && <ProductCompare query={query} />}
          </TabsContent>
        )}
      </Tabs>
    </Panel>
  );
}

function CampaignCompare({ campaigns }: { campaigns: Campaign[] }) {
  const t = useTranslations('Analytics.compare');
  const stageT = useTranslations('Analytics.campaigns.stage');
  const format = useFormatter();
  const [picked, setSelected] = useState<string[]>([]);
  const selected = visibleSelection(picked, campaigns);
  const ready = selected.length >= 2;
  const report = useReport<{ campaigns: Campaign[] }>('compare/campaigns', reportQuery({ ids: selected.join(',') }), ready);
  const rows = report.data?.campaigns ?? [];
  const labels = uniqueLabels(rows.map((row) => row.name));
  const toggle = (id: string) =>
    setSelected((current) => {
      const visible = visibleSelection(current, campaigns);
      return visible.includes(id) ? visible.filter((x) => x !== id) : visible.length < MAX_CAMPAIGNS ? [...visible, id] : visible;
    });
  const percent = (value: number | null) => (value === null ? '–' : t('percent', { value: format.number(value) }));

  if (campaigns.length < 2) return <p className="text-sm text-muted-foreground">{t('campaigns.needTwo')}</p>;
  return (
    <div className="space-y-4">
      <fieldset className="space-y-2">
        <legend className="text-xs text-muted-foreground">{t('campaigns.pick', { max: MAX_CAMPAIGNS })}</legend>
        <div className="flex max-h-40 flex-wrap gap-2 overflow-y-auto">
          {campaigns.map((campaign) => {
            const checked = selected.includes(campaign.id);
            return (
              <label
                key={campaign.id}
                className="flex items-center gap-2 rounded-md border border-border px-2 py-1 text-sm has-[:disabled]:opacity-50"
              >
                <input
                  type="checkbox"
                  checked={checked}
                  disabled={!checked && selected.length >= MAX_CAMPAIGNS}
                  onChange={() => toggle(campaign.id)}
                />
                <span className="max-w-48 truncate">{campaign.name}</span>
              </label>
            );
          })}
        </div>
      </fieldset>
      {!ready ? (
        <p className="text-sm text-muted-foreground">{t('campaigns.selectMore')}</p>
      ) : (
        <ReportState loading={report.loading} error={report.error} onRetry={report.retry} empty={rows.length === 0}>
          <ChartWithTable
            label={t('campaigns.chartLabel')}
            chart={
              <BarChart
                className="h-72"
                data={FUNNEL_STAGES.map((stage) => ({
                  stage: stageT(stage),
                  ...Object.fromEntries(rows.map((row, i) => [labels[i], shareOfSent(row, stage) ?? 0])),
                }))}
                index="stage"
                categories={labels}
                valueFormatter={(n) => t('percent', { value: format.number(n) })}
                allowDecimals={false}
              />
            }
            columns={[t('campaigns.campaign'), t('campaigns.recipients'), ...FUNNEL_STAGES.map((stage) => stageT(stage))]}
            rows={rows.map((row, i) => [
              labels[i],
              row.recipients,
              format.number(row.sent),
              ...FUNNEL_STAGES.slice(1).map((stage) => percent(shareOfSent(row, stage))),
            ])}
          />
          <p className="text-xs text-muted-foreground">{t('campaigns.hint')}</p>
        </ReportState>
      )}
    </div>
  );
}

function ServiceCompare({ query }: { query: string }) {
  const t = useTranslations('Analytics.compare');
  const format = useFormatter();
  const report = useReport<{ services: ServiceRow[] }>('compare/services', query);
  const rows = report.data?.services ?? [];
  const booked = t('services.booked');
  const completed = t('services.completed');
  const noShow = t('services.noShow');
  return (
    <ReportState loading={report.loading} error={report.error} onRetry={report.retry} empty={!!report.data && rows.length === 0}>
      <ChartWithTable
        label={t('services.chartLabel')}
        chart={
          <BarChart
            className="h-72"
            data={rows.slice(0, 12).map((row) => ({ service: row.name, [booked]: row.booked, [completed]: row.completed, [noShow]: row.noShow }))}
            index="service"
            categories={[booked, completed, noShow]}
            valueFormatter={(n) => format.number(n)}
            allowDecimals={false}
          />
        }
        columns={[t('services.service'), booked, t('services.confirmed'), t('services.cancelled'), completed, noShow, t('services.noShowRate')]}
        rows={rows.map((row) => [
          row.name,
          row.booked,
          row.confirmed,
          row.cancelled,
          row.completed,
          row.noShow,
          row.noShowRate === null ? t('notApplicable') : t('percent', { value: format.number(Math.round(row.noShowRate * 1000) / 10) }),
        ])}
      />
    </ReportState>
  );
}

function ProductCompare({ query }: { query: string }) {
  const t = useTranslations('Analytics.compare');
  const locale = useLocale();
  const format = useFormatter();
  const report = useReport<{ products: ProductStatsRow[] }>('compare/products', query);
  const rows = report.data?.products ?? [];
  const currencies = [...new Set(rows.map((row) => row.currency))];
  const label = (row: ProductStatsRow) => row.name || row.key;
  return (
    <ReportState loading={report.loading} error={report.error} onRetry={report.retry} empty={!!report.data && rows.length === 0}>
      <div className="space-y-6">
        {currencies.map((currency) => {
          const inCurrency = rows.filter((row) => row.currency === currency);
          const money = (minor: number) => formatMoney(minor, currency, locale);
          const net = t('products.net');
          return (
            <section key={currency} aria-label={currency} className="space-y-3">
              {currencies.length > 1 && <h3 className="text-xs font-semibold text-muted-foreground">{currency}</h3>}
              <div role="img" aria-label={t('products.chartLabel')}>
                <BarChart
                  className="h-72"
                  layout="vertical"
                  data={inCurrency.slice(0, 12).map((row) => ({ product: label(row), [net]: row.netMinor }))}
                  index="product"
                  categories={[net]}
                  valueFormatter={(n) => money(n)}
                  showLegend={false}
                  yAxisWidth={160}
                />
              </div>
              <DataTable
                caption={t('products.chartLabel')}
                columns={[t('products.product'), t('products.orders'), t('products.units'), t('products.gross'), t('products.discounts'), t('products.refunds'), net]}
                rows={inCurrency.map((row) => [
                  label(row),
                  format.number(row.orders),
                  format.number(row.units),
                  money(row.grossMinor),
                  money(row.discountsMinor),
                  money(row.refundsMinor),
                  money(row.netMinor),
                ])}
              />
            </section>
          );
        })}
        <p className="text-xs text-muted-foreground">{t('products.hint')}</p>
      </div>
    </ReportState>
  );
}
