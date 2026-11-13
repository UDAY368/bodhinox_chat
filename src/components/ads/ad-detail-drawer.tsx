'use client';

// The detail drawer of one campaign or ad on the Ads tab (Campaigns redesign):
// KPI tiles for the selected range and a 14-day chart that switches between
// spend, clicks and conversations started. Read-only: it shows stored
// insights; pausing, budgets and edits stay in the Campaigns tab (behind its
// confirmation) and in Meta Ads Manager.

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { ExternalLink, Loader2 } from 'lucide-react';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { authFetch } from '@/lib/auth/client';
import type { AdDailySeries } from '@/lib/meta-ads/daily';
import { cn } from '@/lib/utils';
import { formatCount, formatSpend, type AdRow } from './ads-table';

type Metric = 'spend' | 'clicks' | 'conversations';
const METRICS: Metric[] = ['conversations', 'clicks', 'spend'];

export function AdDetailDrawer({ row, level, adAccountId, onClose }: {
  row: AdRow | null;
  level: 'campaign' | 'ad';
  /** For the "Open in Ads Manager" link. */
  adAccountId?: string | null;
  onClose: () => void;
}) {
  const t = useTranslations('Campaigns.adDrawer');
  // Keyed by the object it belongs to, so a previous object's figures never show for the next one.
  const [loaded, setLoaded] = useState<{ key: string; series: AdDailySeries | null } | null>(null);
  const [metric, setMetric] = useState<Metric>('conversations');
  const key = row ? `${level}:${row.id}` : '';

  useEffect(() => {
    if (!row) return;
    let cancelled = false;
    const params = new URLSearchParams({ level, id: row.id });
    authFetch(`/api/meta-ads/ads/daily?${params.toString()}`, { cache: 'no-store' })
      .then(async (res) => {
        if (!res.ok) throw new Error();
        const body = (await res.json()) as AdDailySeries;
        if (!cancelled) setLoaded({ key: `${level}:${row.id}`, series: body });
      })
      .catch(() => { if (!cancelled) setLoaded({ key: `${level}:${row.id}`, series: null }); });
    return () => { cancelled = true; };
  }, [row, level]);
  const current = loaded?.key === key ? loaded : null;
  const series = current?.series ?? null;
  const failed = current !== null && current.series === null;

  const currency = series?.currency ?? row?.currency ?? null;
  const points = series?.points ?? [];
  const values = points.map((p) => p[metric]);
  const max = Math.max(1, ...values);
  const fmt = (m: Metric, v: number) => (m === 'spend' ? formatSpend(v, currency) : v.toLocaleString());
  const total = values.reduce((a, b) => a + b, 0);

  return (
    <Sheet open={row !== null} onOpenChange={(open) => { if (!open) onClose(); }}>
      <SheetContent className="w-full overflow-y-auto sm:max-w-md">
        {row && (
          <>
            <SheetHeader className="pr-12">
              <SheetTitle className="break-words text-lg font-semibold">{row.name ?? row.id}</SheetTitle>
              <SheetDescription className="text-xs text-muted-foreground">
                {(level === 'ad' ? t('ad') : t('campaign'))} · {row.status ?? '-'} · {row.id}
              </SheetDescription>
            </SheetHeader>
            <div className="space-y-5 px-4 pb-6">
              <p className="text-xs text-muted-foreground">{t('rangeNote')}</p>
              <dl className="grid grid-cols-2 gap-2">
                {[
                  [t('spend'), row.spend == null ? formatCount(null) : formatSpend(row.spend, row.currency)],
                  [t('clicks'), formatCount(row.clicks)],
                  [t('conversations'), formatCount(row.conversationsStarted)],
                  [t('purchases'), row.purchases.toLocaleString()],
                ].map(([label, value]) => (
                  <div key={label} className="rounded-xl border border-border bg-card p-3">
                    <dt className="text-xs text-muted-foreground">{label}</dt>
                    <dd className="mt-0.5 text-lg font-bold tabular-nums text-foreground">{value}</dd>
                  </div>
                ))}
              </dl>

              <section aria-labelledby="ad-chart-title" className="space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h3 id="ad-chart-title" className="text-sm font-semibold text-foreground">{t('last14')}</h3>
                  <div role="tablist" aria-label={t('metric')} className="flex gap-0.5 rounded-xl bg-muted p-[3px]">
                    {METRICS.map((m) => (
                      <button
                        key={m}
                        type="button"
                        role="tab"
                        aria-selected={metric === m}
                        onClick={() => setMetric(m)}
                        className={cn(
                          'h-7 rounded-[9px] px-2.5 text-xs font-medium transition-colors duration-150 outline-none focus-visible:ring-2 focus-visible:ring-ring',
                          metric === m ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground',
                        )}
                      >
                        {t(m)}
                      </button>
                    ))}
                  </div>
                </div>
                {failed ? (
                  <p className="text-sm text-destructive">{t('loadFailed')}</p>
                ) : !series ? (
                  <p className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" />{t('loading')}</p>
                ) : (
                  <figure className="space-y-1.5">
                    <div className="flex h-36 items-end gap-1" role="img" aria-label={t('chartLabel', { metric: t(metric), total: fmt(metric, total) })}>
                      {points.map((p) => (
                        <div key={p.day} className="flex h-full min-w-0 flex-1 flex-col justify-end" title={`${p.day}: ${fmt(metric, p[metric])}`}>
                          <div className="rounded-t-[3px] bg-primary/80" style={{ height: `${Math.max(p[metric] > 0 ? 3 : 0, (p[metric] / max) * 100)}%` }} />
                        </div>
                      ))}
                    </div>
                    <figcaption className="flex justify-between text-[11px] tabular-nums text-muted-foreground">
                      <span>{points[0]?.day.slice(5)}</span>
                      <span>{t('total', { total: fmt(metric, total) })}</span>
                      <span>{points[points.length - 1]?.day.slice(5)}</span>
                    </figcaption>
                  </figure>
                )}
              </section>

              {adAccountId && (
                <a
                  href={`https://adsmanager.facebook.com/adsmanager/manage/${level === 'ad' ? 'ads' : 'campaigns'}?act=${encodeURIComponent(adAccountId)}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex h-9 items-center gap-1.5 rounded-full border border-border px-4 text-sm font-medium text-foreground transition-colors duration-150 hover:bg-muted"
                >
                  {t('openInAdsManager')} <ExternalLink className="size-3.5" />
                </a>
              )}
            </div>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}
