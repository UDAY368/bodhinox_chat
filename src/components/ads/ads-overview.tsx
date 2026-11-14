'use client';

// The Ads Overview tab: KPI tiles for the selected range and ad account, the
// daily trend (switchable metric), the split by platform and the top
// campaigns. Reads GET /api/meta-ads/overview (stored rows only).

import { useCallback, useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { authFetch } from '@/lib/auth/client';
import { cn } from '@/lib/utils';
import type { AdsOverview as Overview } from '@/lib/meta-ads/overview';
import {
  cpm, ctr, formatMoneyValue, formatNumber, formatPercent, PLATFORM_COLOR, PLATFORM_ORDER, ratio, type AdsRange, type PlatformKey,
} from './ads-shared';

type TrendMetric = 'spend' | 'conversationsStarted' | 'leads' | 'linkClicks' | 'impressions';
const TREND: TrendMetric[] = ['spend', 'conversationsStarted', 'leads', 'linkClicks', 'impressions'];

export function AdsOverview({ range, adAccountId }: { range: AdsRange; adAccountId: string | null }) {
  const t = useTranslations('Ads.overview');
  const tAds = useTranslations('Ads');
  const tPlatform = useTranslations('Ads.platforms');
  const [data, setData] = useState<Overview | null>(null);
  const [failed, setFailed] = useState(false);
  const [metric, setMetric] = useState<TrendMetric>('spend');

  const load = useCallback(async () => {
    setFailed(false);
    setData(null);
    try {
      const params = new URLSearchParams({ from: range.from, to: range.to, adAccountId: adAccountId ?? 'all' });
      const res = await authFetch(`/api/meta-ads/overview?${params.toString()}`, { cache: 'no-store' });
      if (!res.ok) throw new Error();
      setData((await res.json()) as Overview);
    } catch {
      setFailed(true);
    }
  }, [range.from, range.to, adAccountId]);

  useEffect(() => { void load(); }, [load]);

  if (failed) {
    return (
      <div className="flex items-center gap-2 text-sm text-destructive">
        {tAds('loadFailed')}
        <Button type="button" variant="outline" size="sm" onClick={() => void load()}>{tAds('retry')}</Button>
      </div>
    );
  }
  if (!data) return <Loader2 className="size-5 animate-spin text-primary" aria-label={t('loading')} />;

  const { totals } = data;
  // One currency: show it; several (accounts billing differently): the spend tile lists each.
  const currency = data.spendByCurrency.length === 1 ? data.spendByCurrency[0].currency : null;
  const mixed = data.spendByCurrency.length > 1;
  const money = (v: number | null) => (mixed ? '-' : formatMoneyValue(v, currency));
  const empty = totals.impressions === 0 && totals.spend === 0 && data.conversationsInBodhinox === 0;

  const tiles: { key: string; label: string; value: string; hint?: string }[] = [
    { key: 'spend', label: t('spend'), value: mixed ? data.spendByCurrency.map((c) => formatMoneyValue(c.spend, c.currency)).join(' · ') : money(totals.spend) },
    { key: 'reach', label: t('reach'), value: formatNumber(data.reach), hint: data.reach === null ? t('reachHint') : data.frequency !== null ? t('frequency', { value: data.frequency.toFixed(2) }) : undefined },
    { key: 'impressions', label: t('impressions'), value: formatNumber(totals.impressions) },
    { key: 'ctr', label: t('ctr'), value: formatPercent(ctr(totals.clicks, totals.impressions)), hint: t('clicks', { count: totals.clicks }) },
    { key: 'conversations', label: t('conversations'), value: formatNumber(totals.conversationsStarted), hint: t('inBodhinox', { count: data.conversationsInBodhinox }) },
    { key: 'costPerConversation', label: t('costPerConversation'), value: money(ratio(totals.spend, totals.conversationsStarted)) },
    { key: 'leads', label: t('leads'), value: formatNumber(totals.leads), hint: totals.leads ? t('costPer', { value: money(ratio(totals.spend, totals.leads)) }) : undefined },
    { key: 'linkClicks', label: t('linkClicks'), value: formatNumber(totals.linkClicks), hint: t('cpm', { value: money(cpm(totals.spend, totals.impressions)) }) },
  ];

  const values = data.daily.map((d) => d[metric]);
  const max = Math.max(1, ...values);
  const fmt = (v: number) => (metric === 'spend' ? money(v) : v.toLocaleString());
  const platformTotal = data.platforms.reduce((sum, p) => sum + p.impressions, 0);
  const platforms = PLATFORM_ORDER.map((key) => data.platforms.find((p) => p.platform === key)).filter((p): p is Overview['platforms'][number] => !!p);

  return (
    <div className="space-y-6" data-testid="ads-overview">
      {empty && <p className="rounded-xl border border-dashed border-border bg-card px-4 py-6 text-center text-sm text-muted-foreground">{t('empty')}</p>}

      <dl className="grid grid-cols-2 gap-3 md:grid-cols-4">
        {tiles.map((tile) => (
          <div key={tile.key} className="rounded-xl border border-border bg-card p-4">
            <dt className="text-xs font-medium text-muted-foreground">{tile.label}</dt>
            <dd className="mt-1 break-words text-xl font-bold tabular-nums text-foreground">{tile.value}</dd>
            {tile.hint && <dd className="mt-0.5 text-xs text-muted-foreground">{tile.hint}</dd>}
          </div>
        ))}
      </dl>

      <section aria-labelledby="ads-trend-title" className="rounded-xl border border-border bg-card p-4">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <h2 id="ads-trend-title" className="text-sm font-semibold text-foreground">{t('trend')}</h2>
          <div role="tablist" aria-label={t('metric')} className="flex flex-wrap gap-0.5 rounded-xl bg-muted p-[3px]">
            {TREND.map((m) => (
              <button key={m} type="button" role="tab" aria-selected={metric === m} onClick={() => setMetric(m)}
                className={cn('h-7 rounded-[9px] px-2.5 text-xs font-medium outline-none transition-colors duration-150 focus-visible:ring-2 focus-visible:ring-ring',
                  metric === m ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground')}>
                {t(`metrics.${m}`)}
              </button>
            ))}
          </div>
        </div>
        <figure className="space-y-1.5">
          <div className="flex h-40 items-end gap-[2px]" role="img"
            aria-label={t('trendLabel', { metric: t(`metrics.${metric}`), total: fmt(values.reduce((a, b) => a + b, 0)) })}>
            {data.daily.map((d) => (
              <div key={d.day} className="flex h-full min-w-0 flex-1 flex-col justify-end" title={`${d.day}: ${fmt(d[metric])}`}>
                <div className="rounded-t-[3px] bg-primary/80" style={{ height: `${Math.max(d[metric] > 0 ? 3 : 0, (d[metric] / max) * 100)}%` }} />
              </div>
            ))}
          </div>
          <figcaption className="flex justify-between text-[11px] tabular-nums text-muted-foreground">
            <span>{data.daily[0]?.day}</span>
            <span>{data.daily[data.daily.length - 1]?.day}</span>
          </figcaption>
        </figure>
      </section>

      <div className="grid gap-6 lg:grid-cols-2">
        <section aria-labelledby="ads-platforms-title" className="rounded-xl border border-border bg-card p-4">
          <h2 id="ads-platforms-title" className="text-sm font-semibold text-foreground">{t('platforms')}</h2>
          <p className="mt-0.5 text-xs text-muted-foreground">{t('platformsHint')}</p>
          {platforms.length === 0 ? (
            <p className="mt-4 text-sm text-muted-foreground">{t('noPlatforms')}</p>
          ) : (
            <>
              <div className="mt-4 flex h-3 overflow-hidden rounded-full bg-muted" aria-hidden>
                {platforms.map((p) => (
                  <div key={p.platform} className={PLATFORM_COLOR[p.platform as PlatformKey]} style={{ width: `${platformTotal ? (p.impressions / platformTotal) * 100 : 0}%` }} />
                ))}
              </div>
              <table className="mt-4 w-full text-sm">
                <thead className="text-left text-xs text-muted-foreground">
                  <tr>
                    <th className="pb-2 font-medium">{t('platform')}</th>
                    <th className="pb-2 text-right font-medium">{t('spend')}</th>
                    <th className="pb-2 text-right font-medium">{t('impressions')}</th>
                    <th className="pb-2 text-right font-medium">{t('results')}</th>
                  </tr>
                </thead>
                <tbody>
                  {platforms.map((p) => (
                    <tr key={p.platform} className="border-t border-border/70">
                      <td className="py-2">
                        <span className="flex items-center gap-2">
                          <span className={cn('size-2.5 rounded-full', PLATFORM_COLOR[p.platform as PlatformKey])} aria-hidden />
                          {tPlatform(p.platform)}
                        </span>
                      </td>
                      <td className="py-2 text-right tabular-nums">{money(p.spend)}</td>
                      <td className="py-2 text-right tabular-nums">{formatNumber(p.impressions)}</td>
                      <td className="py-2 text-right tabular-nums">{formatNumber(p.conversationsStarted + p.leads)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}
        </section>

        <section aria-labelledby="ads-top-title" className="rounded-xl border border-border bg-card p-4">
          <h2 id="ads-top-title" className="text-sm font-semibold text-foreground">{t('topCampaigns')}</h2>
          {data.topCampaigns.length === 0 ? (
            <p className="mt-4 text-sm text-muted-foreground">{t('noCampaigns')}</p>
          ) : (
            <ol className="mt-3 space-y-2">
              {data.topCampaigns.map((c) => {
                const results = c.conversationsStarted + c.leads;
                return (
                  <li key={c.id} className="flex items-center justify-between gap-3 rounded-lg border border-border/70 px-3 py-2">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium text-foreground">{c.name ?? c.id}</p>
                      <p className="text-xs text-muted-foreground">
                        {t('campaignResults', { results, cost: formatMoneyValue(ratio(c.spend, results), c.currency) })}
                      </p>
                    </div>
                    <span className="shrink-0 text-sm font-semibold tabular-nums">{formatMoneyValue(c.spend, c.currency)}</span>
                  </li>
                );
              })}
            </ol>
          )}
        </section>
      </div>

      <p className="text-xs text-muted-foreground">
        {data.insightsSyncedAt ? t('syncedAt', { time: new Date(data.insightsSyncedAt).toLocaleString() }) : t('neverSynced')}
      </p>
    </div>
  );
}
