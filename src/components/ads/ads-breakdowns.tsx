'use client';

// "Who saw your ads": one range's results split by age and gender, region,
// device or placement. Each view is read from Meta on demand (GET
// /api/meta-ads/breakdowns, cached there for 15 minutes), so it loads only
// when the section is opened or the split is changed. Used on the Overview
// (the ad account) and in an ad's detail drawer (objectId).

import { useCallback, useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { authFetch } from '@/lib/auth/client';
import { cn } from '@/lib/utils';
import type { MetaBreakdownRow } from '@/lib/meta-ads/graph';
import { formatMoneyValue, formatNumber, ratio, type AdsRange } from './ads-shared';
import { LoadingRows } from './ads-ui';

const SPLITS = ['age_gender', 'region', 'device', 'placement'] as const;
type Split = (typeof SPLITS)[number];

/** Results that count for any objective: chats, leads, link clicks and purchases together. */
const resultsOf = (r: MetaBreakdownRow) => r.conversationsStarted + r.leads + r.purchases;

export function AdsBreakdowns({ range, adAccountId, objectId = null, compact = false }: {
  range: AdsRange; adAccountId: string | null; objectId?: string | null; compact?: boolean;
}) {
  const t = useTranslations('Ads.breakdowns');
  const tAds = useTranslations('Ads');
  const [open, setOpen] = useState(compact);
  const [split, setSplit] = useState<Split>('age_gender');
  const [data, setData] = useState<{ currency: string | null; rows: MetaBreakdownRow[] } | null>(null);
  const [failed, setFailed] = useState<string | null>(null);

  const load = useCallback(async () => {
    setFailed(null);
    setData(null);
    try {
      const params = new URLSearchParams({ from: range.from, to: range.to, breakdown: split });
      if (adAccountId) params.set('adAccountId', adAccountId);
      if (objectId) params.set('objectId', objectId);
      const res = await authFetch(`/api/meta-ads/breakdowns?${params.toString()}`, { cache: 'no-store' });
      const body = (await res.json().catch(() => ({}))) as { currency?: string | null; rows?: MetaBreakdownRow[]; error?: string };
      if (!res.ok || !body.rows) throw new Error(body.error ?? 'generic');
      setData({ currency: body.currency ?? null, rows: body.rows });
    } catch (error) {
      setFailed(error instanceof Error ? error.message : 'generic');
    }
  }, [range.from, range.to, split, adAccountId, objectId]);

  useEffect(() => {
    if (open) void load();
  }, [open, load]);

  const label = (r: MetaBreakdownRow) => {
    if (split === 'age_gender') return `${r.dims[0]} · ${t.has(`genders.${r.dims[1]}`) ? t(`genders.${r.dims[1]}`) : r.dims[1]}`;
    if (split === 'device') return r.dims[0].replace(/_/g, ' ');
    if (split === 'placement') return r.dims.map((d) => d.replace(/_/g, ' ')).join(' · ');
    return r.dims[0];
  };
  const maxSpend = Math.max(1, ...(data?.rows ?? []).map((r) => r.spend));

  const body = (
    <div className="space-y-3">
      <div role="radiogroup" aria-label={t('split')} className="inline-flex flex-wrap gap-0.5 rounded-xl bg-muted p-[3px]">
        {SPLITS.map((s) => (
          <button key={s} type="button" role="radio" aria-checked={split === s} onClick={() => setSplit(s)}
            className={cn('h-7 rounded-[9px] px-2.5 text-xs font-medium outline-none transition-colors duration-150 focus-visible:ring-2 focus-visible:ring-ring',
              split === s ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground')}>
            {t(`splits.${s}`)}
          </button>
        ))}
      </div>
      {!data && !failed && <LoadingRows rows={4} />}
      {failed && (
        <div className="flex flex-wrap items-center gap-2 text-sm text-destructive">
          {t.has(`errors.${failed}`) ? t(`errors.${failed}`) : tAds('loadFailed')}
          <Button type="button" variant="outline" size="sm" onClick={() => void load()}>{tAds('retry')}</Button>
        </div>
      )}
      {data && data.rows.length === 0 && <p className="text-sm text-muted-foreground">{t('empty')}</p>}
      {data && data.rows.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[520px] text-sm">
            <thead className="text-left text-xs text-muted-foreground">
              <tr>
                <th className="py-1.5 pr-3 font-medium">{t(`splits.${split}`)}</th>
                <th className="py-1.5 pr-3 font-medium">{t('spend')}</th>
                <th className="py-1.5 pr-3 text-right font-medium">{t('impressions')}</th>
                <th className="py-1.5 pr-3 text-right font-medium">{t('results')}</th>
                <th className="py-1.5 text-right font-medium">{t('costPerResult')}</th>
              </tr>
            </thead>
            <tbody>
              {data.rows.slice(0, compact ? 8 : 25).map((r) => (
                <tr key={r.dims.join('|')} className="border-t border-border/70">
                  <td className="py-2 pr-3 capitalize text-foreground">{label(r)}</td>
                  <td className="w-[30%] py-2 pr-3">
                    <div className="flex items-center gap-2">
                      <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted" aria-hidden>
                        <div className="h-full rounded-full bg-primary" style={{ width: `${(r.spend / maxSpend) * 100}%` }} />
                      </div>
                      <span className="w-20 text-right tabular-nums">{formatMoneyValue(r.spend, data.currency)}</span>
                    </div>
                  </td>
                  <td className="py-2 pr-3 text-right tabular-nums">{formatNumber(r.impressions)}</td>
                  <td className="py-2 pr-3 text-right tabular-nums">{formatNumber(resultsOf(r))}</td>
                  <td className="py-2 text-right tabular-nums">{formatMoneyValue(ratio(r.spend, resultsOf(r)), data.currency)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="text-xs text-muted-foreground">{t('note')}</p>
    </div>
  );

  if (compact) return <section aria-label={t('title')} className="space-y-2"><h3 className="text-sm font-semibold text-foreground">{t('title')}</h3>{body}</section>;
  return (
    <details className="rounded-xl border border-border bg-card" open={open} onToggle={(e) => setOpen(e.currentTarget.open)} data-testid="ads-breakdowns">
      <summary className="flex cursor-pointer items-center justify-between gap-2 rounded-xl p-4 outline-none hover:bg-muted/40 focus-visible:ring-2 focus-visible:ring-ring">
        <span>
          <span className="block text-sm font-semibold text-foreground">{t('title')}</span>
          <span className="block text-xs text-muted-foreground">{t('blurb')}</span>
        </span>
      </summary>
      <div className="border-t border-border p-4">{body}</div>
    </details>
  );
}
