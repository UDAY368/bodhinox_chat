'use client';

/**
 * Commerce revenue on the analytics page (design §3 Revenue, PRD :204-208):
 * gross and net merchandise revenue, tax, shipping, collected, refunds and
 * average order value for the selected range, from order snapshots and
 * customer_refunds (external refunds included). Loads
 * /api/analytics/commerce (agent and above; the page mounts it only then).
 */
import { Banknote, Receipt, RotateCcw, ShoppingBag, Wallet } from 'lucide-react';
import { useFormatter, useLocale, useTranslations } from 'next-intl';

import type { CommerceCurrencyStats, CommerceStats } from '@/lib/analytics/commerce';
import { formatMoney } from '@/lib/commerce/money';
import { MetricCard } from '@/components/dashboard/metric-card';
import { Panel, ReportState, useReport } from './shared';

export interface CommerceCardProps {
  /** The page's range query string (reportQuery(rangeParams(range))). */
  query: string;
}

/** True when the range has no orders, payments or refunds at all. */
export function commerceEmpty(stats: CommerceStats | null): boolean {
  return !!stats && stats.currencies.every((c) => c.paidOrders === 0 && c.collectedMinor === 0 && c.refundsMinor === 0);
}

export function CommerceCard({ query }: CommerceCardProps) {
  const t = useTranslations('Analytics.commerce');
  const report = useReport<{ stats: CommerceStats }>('commerce', query);
  const stats = report.data?.stats ?? null;
  return (
    <Panel title={t('title')} description={t('description')}>
      <ReportState loading={report.loading} error={report.error} onRetry={report.retry} empty={commerceEmpty(stats)}>
        {stats && (
          <div className="space-y-5">
            {stats.currencies.map((c) => <CurrencyBlock key={c.currency} stats={c} showCode={stats.currencies.length > 1} />)}
          </div>
        )}
      </ReportState>
    </Panel>
  );
}

function CurrencyBlock({ stats, showCode }: { stats: CommerceCurrencyStats; showCode: boolean }) {
  const t = useTranslations('Analytics.commerce');
  const locale = useLocale();
  const format = useFormatter();
  const money = (minor: number) => formatMoney(minor, stats.currency, locale);
  return (
    <section aria-label={stats.currency} className="space-y-3">
      {showCode && <h3 className="text-xs font-semibold text-muted-foreground">{stats.currency}</h3>}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <MetricCard
          title={t('netMerchandise')}
          value={money(stats.netMerchandiseMinor)}
          icon={ShoppingBag}
          subtitle={t('grossSubtitle', { gross: money(stats.grossMerchandiseMinor), discounts: money(stats.discountsMinor) })}
        />
        <MetricCard
          title={t('averageOrderValue')}
          value={stats.averageOrderValueMinor === null ? '–' : money(stats.averageOrderValueMinor)}
          icon={Receipt}
          subtitle={t('paidOrders', { count: stats.paidOrders })}
        />
        <MetricCard
          title={t('collected')}
          value={money(stats.collectedMinor)}
          icon={Wallet}
          subtitle={t('collectedSubtitle', { gateway: money(stats.gatewayCollectedMinor), offline: money(stats.offlineCollectedMinor) })}
        />
        <MetricCard
          title={t('netCollected')}
          value={money(stats.netCollectedMinor)}
          icon={Banknote}
          subtitle={t('refundsSubtitle', { refunds: money(stats.refundsMinor), external: money(stats.externalRefundsMinor) })}
        />
      </div>
      <dl className="grid grid-cols-2 gap-x-6 gap-y-1 text-xs text-muted-foreground sm:grid-cols-4">
        <div className="flex justify-between gap-2"><dt>{t('tax')}</dt><dd className="tabular-nums text-foreground">{money(stats.taxMinor)}</dd></div>
        <div className="flex justify-between gap-2"><dt>{t('shipping')}</dt><dd className="tabular-nums text-foreground">{money(stats.shippingMinor)}</dd></div>
        <div className="flex justify-between gap-2">
          <dt className="flex items-center gap-1"><RotateCcw className="h-3 w-3" aria-hidden />{t('merchandiseRefunds')}</dt>
          <dd className="tabular-nums text-foreground">{money(stats.merchandiseRefundsMinor)}</dd>
        </div>
        <div className="flex justify-between gap-2"><dt>{t('orders')}</dt><dd className="tabular-nums text-foreground">{format.number(stats.paidOrders)}</dd></div>
      </dl>
    </section>
  );
}
