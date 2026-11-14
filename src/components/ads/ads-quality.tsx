'use client';

// "From ad to customer": for each ad, the chats it started in Bodhinox, how
// many your team or a bot answered, the deals opened afterwards and the deals
// won, with cost per chat and per won deal. From Bodhinox's own records
// (GET /api/meta-ads/quality), beside the ad's stored spend.

import { useCallback, useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { authFetch } from '@/lib/auth/client';
import type { ChatQualityRow } from '@/lib/meta-ads/reports';
import { formatMoneyValue, formatPercent, ratio, type AdsRange } from './ads-shared';
import { LoadingRows, MetricHeader } from './ads-ui';

export function AdsQuality({ range, adAccountId }: { range: AdsRange; adAccountId: string | null }) {
  const t = useTranslations('Ads.quality');
  const tAds = useTranslations('Ads');
  const [rows, setRows] = useState<ChatQualityRow[] | null>(null);
  const [failed, setFailed] = useState(false);

  const load = useCallback(async () => {
    setFailed(false);
    setRows(null);
    try {
      const params = new URLSearchParams({ from: range.from, to: range.to });
      if (adAccountId) params.set('adAccountId', adAccountId);
      const res = await authFetch(`/api/meta-ads/quality?${params.toString()}`, { cache: 'no-store' });
      if (!res.ok) throw new Error();
      setRows(((await res.json()) as { rows: ChatQualityRow[] }).rows);
    } catch {
      setFailed(true);
    }
  }, [range.from, range.to, adAccountId]);

  useEffect(() => { void load(); }, [load]);

  const shown = (rows ?? []).filter((r) => r.chats > 0 || r.spend > 0).slice(0, 15);
  const pct = (part: number, whole: number) => formatPercent(whole > 0 ? (part / whole) * 100 : null);

  return (
    <section aria-labelledby="ads-quality-title" className="rounded-xl border border-border bg-card p-4" data-testid="ads-quality">
      <h2 id="ads-quality-title" className="text-sm font-semibold text-foreground">{t('title')}</h2>
      <p className="mt-0.5 text-xs text-muted-foreground">{t('blurb')}</p>
      <div className="mt-3">
        {!rows && !failed && <LoadingRows rows={3} />}
        {failed && (
          <div className="flex items-center gap-2 text-sm text-destructive">
            {tAds('loadFailed')}
            <Button type="button" variant="outline" size="sm" onClick={() => void load()}>{tAds('retry')}</Button>
          </div>
        )}
        {rows && shown.length === 0 && <p className="text-sm text-muted-foreground">{t('empty')}</p>}
        {shown.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[720px] text-sm">
              <thead className="text-left text-xs text-muted-foreground">
                <tr>
                  <th className="py-1.5 pr-3 font-medium">{t('ad')}</th>
                  <th className="py-1.5 pr-3 text-right font-medium">{t('spend')}</th>
                  <th className="py-1.5 pr-3 text-right font-medium"><MetricHeader label={t('chats')} help={t('help.chats')} /></th>
                  <th className="py-1.5 pr-3 text-right font-medium"><MetricHeader label={t('replied')} help={t('help.replied')} /></th>
                  <th className="py-1.5 pr-3 text-right font-medium"><MetricHeader label={t('deals')} help={t('help.deals')} /></th>
                  <th className="py-1.5 pr-3 text-right font-medium">{t('won')}</th>
                  <th className="py-1.5 pr-3 text-right font-medium">{t('costPerChat')}</th>
                  <th className="py-1.5 text-right font-medium">{t('costPerWon')}</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((r) => (
                  <tr key={r.adId} className="border-t border-border/70">
                    <td className="max-w-[16rem] py-2 pr-3"><span className="block truncate font-medium text-foreground">{r.name ?? r.adId}</span></td>
                    <td className="py-2 pr-3 text-right tabular-nums">{r.spend ? formatMoneyValue(r.spend, r.currency) : '-'}</td>
                    <td className="py-2 pr-3 text-right tabular-nums">{r.chats.toLocaleString()}</td>
                    <td className="py-2 pr-3 text-right tabular-nums">{r.replied.toLocaleString()} <span className="text-xs text-muted-foreground">{pct(r.replied, r.chats)}</span></td>
                    <td className="py-2 pr-3 text-right tabular-nums">{r.deals.toLocaleString()}</td>
                    <td className="py-2 pr-3 text-right font-semibold tabular-nums">{r.won.toLocaleString()}</td>
                    <td className="py-2 pr-3 text-right tabular-nums">{formatMoneyValue(ratio(r.spend || null, r.chats), r.currency)}</td>
                    <td className="py-2 text-right tabular-nums">{formatMoneyValue(ratio(r.spend || null, r.won), r.currency)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </section>
  );
}
