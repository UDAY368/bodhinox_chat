'use client';

// The detail drawer of one campaign or ad on the Ads tab (Campaigns redesign):
// KPI tiles for the selected range and a 14-day chart that switches between
// spend, clicks and conversations started, Meta's own preview of an ad (on
// request) and the split by age, region, device and placement. Read-only: it shows stored
// insights; pausing, budgets and edits stay in the Campaigns tab (behind its
// confirmation) and in Meta Ads Manager.

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { ExternalLink, Loader2 } from 'lucide-react';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { authFetch } from '@/lib/auth/client';
import type { AdDailySeries } from '@/lib/meta-ads/daily';
import { cn } from '@/lib/utils';
import { formatCount, formatSpend, resultOf, type AdRow, type AdsLevel } from './ads-table';
import { ctr, formatMoneyValue, formatPercent, ratio, type AdsRange } from './ads-shared';
import { AdsBreakdowns } from './ads-breakdowns';

/** Meta's preview formats (the same list the preview route accepts). */
const PREVIEW_FORMATS = ['MOBILE_FEED_STANDARD', 'INSTAGRAM_STANDARD', 'INSTAGRAM_STORY', 'FACEBOOK_STORY_MOBILE'] as const;

type Metric = 'spend' | 'clicks' | 'conversations' | 'leads';
const METRICS: Metric[] = ['conversations', 'leads', 'clicks', 'spend'];

/** Meta's own rendering of the ad, loaded when asked for (a live read). */
function MetaPreview({ adId }: { adId: string }) {
  const t = useTranslations('Campaigns.adDrawer');
  const [format, setFormat] = useState<(typeof PREVIEW_FORMATS)[number] | null>(null);
  const [state, setState] = useState<{ key: string; src: string | null; failed: boolean } | null>(null);
  useEffect(() => {
    if (!format) return;
    let cancelled = false;
    const key = `${adId}:${format}`;
    authFetch(`/api/meta-ads/preview?${new URLSearchParams({ adId, format }).toString()}`, { cache: 'no-store' })
      .then(async (res) => {
        if (!res.ok) throw new Error();
        const body = (await res.json()) as { src: string | null };
        if (!cancelled) setState({ key, src: body.src, failed: false });
      })
      .catch(() => { if (!cancelled) setState({ key, src: null, failed: true }); });
    return () => { cancelled = true; };
  }, [adId, format]);
  const current = format && state?.key === `${adId}:${format}` ? state : null;
  return (
    <section aria-labelledby="ad-preview-title" className="space-y-2" data-testid="ad-meta-preview">
      <h3 id="ad-preview-title" className="text-sm font-semibold text-foreground">{t('previewTitle')}</h3>
      <div className="flex flex-wrap gap-1.5">
        {PREVIEW_FORMATS.map((f) => (
          <button key={f} type="button" aria-pressed={format === f} onClick={() => setFormat(f)}
            className={cn('rounded-full border px-2.5 py-1 text-xs', format === f ? 'border-primary bg-primary/10 text-primary' : 'border-border text-muted-foreground hover:bg-muted')}>
            {t(`previewFormats.${f}`)}
          </button>
        ))}
      </div>
      {format && !current && <p className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" />{t('loading')}</p>}
      {current?.failed && <p className="text-sm text-destructive">{t('previewFailed')}</p>}
      {current && !current.failed && !current.src && <p className="text-sm text-muted-foreground">{t('previewNone')}</p>}
      {current?.src && (
        <iframe src={current.src} title={t('previewTitle')} className="h-[34rem] w-full rounded-xl border border-border bg-white"
          sandbox="allow-scripts allow-same-origin allow-popups" referrerPolicy="no-referrer" loading="lazy" />
      )}
    </section>
  );
}

export function AdDetailDrawer({ row, level, adAccountId, range, onClose }: {
  row: AdRow | null;
  level: AdsLevel;
  /** For the "Open in Ads Manager" link. */
  adAccountId?: string | null;
  /** The table's range, for the split by age, region, device and placement. */
  range?: AdsRange;
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
      <SheetContent size="md" className="w-full overflow-y-auto">
        {row && (
          <>
            <SheetHeader className="pr-12">
              <SheetTitle className="break-words text-lg font-semibold">{row.name ?? row.id}</SheetTitle>
              <SheetDescription className="text-xs text-muted-foreground">
                {(level === 'ad' ? t('ad') : level === 'adset' ? t('adset') : t('campaign'))} · {row.status ?? '-'} · {row.id}
              </SheetDescription>
            </SheetHeader>
            <div className="space-y-5 px-4 pb-6">
              {row.thumbnailUrl && (
                // Meta's signed creative URL (refreshed by each sync).
                // eslint-disable-next-line @next/next/no-img-element
                <img src={row.thumbnailUrl} alt={t('creativeAlt')} className="max-h-64 w-full rounded-xl border border-border object-contain" referrerPolicy="no-referrer" />
              )}
              <p className="text-xs text-muted-foreground">{t('rangeNote')}</p>
              <dl className="grid grid-cols-2 gap-2">
                {[
                  [t('spend'), row.spend == null ? formatCount(null) : formatSpend(row.spend, row.currency)],
                  [t('results'), formatCount(resultOf(row).value)],
                  [t('costPerResult'), formatMoneyValue(ratio(row.spend, resultOf(row).value), row.currency)],
                  [t('ctr'), formatPercent(ctr(row.clicks, row.impressions))],
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

              {level === 'ad' && <MetaPreview adId={row.id} />}
              {range && <AdsBreakdowns range={range} adAccountId={adAccountId ?? null} objectId={row.id} compact />}

              {adAccountId && (
                <a
                  href={`https://adsmanager.facebook.com/adsmanager/manage/${level === 'ad' ? 'ads' : level === 'adset' ? 'adsets' : 'campaigns'}?act=${encodeURIComponent(adAccountId)}`}
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
