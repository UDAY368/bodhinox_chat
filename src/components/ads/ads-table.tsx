'use client';

// The Ads tab: campaign, ad set or ad rows for the page's range and ad
// account, with spend, reach (for Meta's fixed ranges), impressions, CTR, the
// result each objective is bought for (chats, leads, link clicks, purchases)
// and its cost, chats Bodhinox saw start, and attributed purchases. Ads show
// their creative. Reads stored insights only (GET /api/meta-ads/ads); "Sync now"
// (admins) queues a refresh. "Retarget" on an ad row opens the segment builder
// prefilled with "clicked this ad".

import { useCallback, useEffect, useState } from 'react';
import { ImageOff, Loader2, RefreshCw, Target } from 'lucide-react';
import { toast } from 'sonner';
import { useTranslations } from 'next-intl';

import { Button } from '@/components/ui/button';
import { SegmentBuilderDialog } from '@/components/contacts/segment-builder-dialog';
import { authFetch } from '@/lib/auth/client';
import type { AudienceCondition } from '@/lib/audience/filter';
import type { AdInsightSummary } from '@/lib/meta-ads/insights';
import { AdDetailDrawer } from './ad-detail-drawer';
import { ctr, formatMoneyValue, formatNumber, formatPercent, ratio, resultKindOf, type AdsRange } from './ads-shared';

export type AdRow = AdInsightSummary;
export type AdsLevel = 'campaign' | 'adset' | 'ad';

/** A Meta figure, or "-" when no insight row is stored for the range. */
export const formatCount = (value: number | null) => formatNumber(value);

/** Amount in the ad account currency when known, else a plain number. */
export function formatSpend(value: number, currency: string | null): string {
  return formatMoneyValue(value, currency);
}

/** The objective's own result for a row, and its label key. */
export function resultOf(row: AdRow): { value: number | null; kind: ReturnType<typeof resultKindOf> } {
  const kind = resultKindOf(row.objective);
  const value = kind === 'leads' ? row.leads : kind === 'link_clicks' ? row.linkClicks : kind === 'purchases' ? row.metaPurchases : row.conversationsStarted;
  return { value, kind };
}

export interface AdsTableProps {
  /** Admins may queue a sync. */
  canManage: boolean;
  /** Agents and above may save a retargeting segment. */
  canSegment: boolean;
  range: AdsRange;
  /** null = every linked ad account. */
  adAccountId: string | null;
}

export function AdsTable({ canManage, canSegment, range, adAccountId }: AdsTableProps) {
  const t = useTranslations('Ads.table');
  const tAds = useTranslations('Ads');
  const [level, setLevel] = useState<AdsLevel>('campaign');
  const [rows, setRows] = useState<AdRow[] | null>(null);
  const [syncedAt, setSyncedAt] = useState<string | null>(null);
  const [showReach, setShowReach] = useState(false);
  const [failed, setFailed] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [retarget, setRetarget] = useState<AudienceCondition[] | null>(null);
  const [opened, setOpened] = useState<AdRow | null>(null);

  const load = useCallback(async () => {
    setFailed(false);
    setRows(null);
    try {
      const params = new URLSearchParams({ level, from: range.from, to: range.to, adAccountId: adAccountId ?? 'all' });
      const res = await authFetch(`/api/meta-ads/ads?${params.toString()}`, { cache: 'no-store' });
      if (!res.ok) throw new Error();
      const body = (await res.json()) as { rows: AdRow[]; insightsSyncedAt: string | null; reachPreset: string | null };
      setRows(body.rows);
      setSyncedAt(body.insightsSyncedAt);
      setShowReach(body.reachPreset !== null);
    } catch {
      setFailed(true);
    }
  }, [level, range.from, range.to, adAccountId]);

  useEffect(() => {
    void load();
  }, [load]);

  const sync = async () => {
    setSyncing(true);
    try {
      const res = await authFetch('/api/meta-ads/ads/sync', { method: 'POST' });
      if (!res.ok) throw new Error();
      toast.success(t('syncQueued'));
    } catch {
      toast.error(t('syncFailed'));
    } finally {
      setSyncing(false);
    }
  };

  const nameHeader = level === 'ad' ? t('ad') : level === 'adset' ? t('adset') : t('campaign');
  const th = 'px-3.5 py-2.5 font-semibold';
  const num = 'px-3.5 py-3 text-right tabular-nums';

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <div role="radiogroup" aria-label={t('level')} className="flex gap-0.5 rounded-xl bg-muted p-[3px]">
          {(['campaign', 'adset', 'ad'] as const).map((value) => (
            <button key={value} type="button" role="radio" aria-checked={level === value} onClick={() => setLevel(value)}
              className={`h-8 rounded-[9px] px-3 text-xs font-medium outline-none transition-colors duration-150 focus-visible:ring-2 focus-visible:ring-ring ${level === value ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'}`}>
              {value === 'campaign' ? t('levelCampaign') : value === 'adset' ? t('levelAdset') : t('levelAd')}
            </button>
          ))}
        </div>
        <div className="ml-auto flex items-center gap-3 text-xs text-muted-foreground">
          <span>{syncedAt ? t('syncedAt', { time: new Date(syncedAt).toLocaleString() }) : t('neverSynced')}</span>
          {canManage && (
            <Button type="button" variant="outline" size="sm" onClick={() => void sync()} disabled={syncing}>
              {syncing ? <Loader2 className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />} {t('sync')}
            </Button>
          )}
        </div>
      </div>

      {!rows && !failed && <Loader2 className="size-4 animate-spin text-primary" />}
      {failed && (
        <div className="flex items-center gap-2 text-sm text-destructive">
          {tAds('loadFailed')}
          <Button type="button" variant="outline" size="sm" onClick={() => void load()}>{tAds('retry')}</Button>
        </div>
      )}
      {rows && rows.length === 0 && <p className="rounded-xl border border-border bg-card px-4 py-12 text-center text-sm text-muted-foreground">{t('empty')}</p>}
      {rows && rows.length > 0 && (
        <div className="overflow-x-auto rounded-xl border border-border bg-card">
          <table className="w-full min-w-[980px] text-sm">
            <thead className="bg-muted text-left text-xs text-muted-foreground">
              <tr>
                <th className={th}>{nameHeader}</th>
                <th className={th}>{t('status')}</th>
                <th className={`${th} text-right`}>{t('spend')}</th>
                {showReach && <th className={`${th} text-right`}>{t('reach')}</th>}
                <th className={`${th} text-right`}>{t('impressions')}</th>
                <th className={`${th} text-right`}>{t('ctr')}</th>
                <th className={`${th} text-right`}>{t('results')}</th>
                <th className={`${th} text-right`}>{t('costPerResult')}</th>
                <th className={`${th} text-right`}>{t('conversationsInBodhinox')}</th>
                <th className={`${th} text-right`}>{t('purchases')}</th>
                {level === 'ad' && canSegment && <th className="px-3 py-2"><span className="sr-only">{tAds('retarget')}</span></th>}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const result = resultOf(row);
                return (
                  <tr key={row.id} className="border-t border-border/70 transition-colors duration-150 hover:bg-muted/60">
                    <td className="px-3.5 py-3">
                      <div className="flex items-center gap-3">
                        {level === 'ad' && (
                          row.thumbnailUrl
                            // Meta's signed creative URL (refreshed by each sync); a plain img keeps it off our image proxy.
                            // eslint-disable-next-line @next/next/no-img-element
                            ? <img src={row.thumbnailUrl} alt="" className="size-10 shrink-0 rounded-md border border-border object-cover" loading="lazy" referrerPolicy="no-referrer" />
                            : <span className="flex size-10 shrink-0 items-center justify-center rounded-md border border-dashed border-border text-muted-foreground"><ImageOff className="size-4" /></span>
                        )}
                        <div className="min-w-0">
                          {/* Opens the detail drawer: KPIs and the last 14 days. */}
                          <button
                            type="button"
                            onClick={() => setOpened(row)}
                            aria-label={t('openDetails', { name: row.name ?? row.id })}
                            className="rounded-sm text-left font-semibold text-foreground outline-none transition-colors duration-150 hover:text-primary focus-visible:ring-2 focus-visible:ring-ring"
                          >
                            {row.name ?? row.id}
                          </button>
                          <div className="text-xs text-muted-foreground">{row.id}</div>
                        </div>
                      </div>
                    </td>
                    <td className="px-3.5 py-3 text-muted-foreground">{row.status ?? '-'}</td>
                    <td className={num}>{row.spend == null ? formatCount(null) : formatSpend(row.spend, row.currency)}</td>
                    {showReach && <td className={num}>{formatCount(row.reach)}</td>}
                    <td className={num}>{formatCount(row.impressions)}</td>
                    <td className={num}>{formatPercent(ctr(row.clicks, row.impressions))}</td>
                    <td className={num}>
                      {formatCount(result.value)}
                      <div className="text-[11px] font-normal text-muted-foreground">{t(`resultKinds.${result.kind}`)}</div>
                    </td>
                    <td className={num}>{formatMoneyValue(ratio(row.spend, result.value), row.currency)}</td>
                    <td className={num}>{row.conversationsInBodhinox.toLocaleString()}</td>
                    <td className={num}>{row.purchases.toLocaleString()}</td>
                    {level === 'ad' && canSegment && (
                      <td className="px-3.5 py-3 text-right">
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          onClick={() => setRetarget([{ field: 'ad', op: 'clicked_any', adIds: [row.id] }])}
                        >
                          <Target className="size-3.5" /> {tAds('retarget')}
                        </Button>
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <AdDetailDrawer row={opened} level={level} adAccountId={opened?.adAccountId ?? adAccountId} onClose={() => setOpened(null)} />

      <SegmentBuilderDialog
        open={retarget !== null}
        onOpenChange={(open) => {
          if (!open) setRetarget(null);
        }}
        segment={null}
        tags={[]}
        lists={[]}
        campaigns={[]}
        customFields={[]}
        initialConditions={retarget ?? undefined}
        onSaved={() => toast.success(t('retargetSaved'))}
      />
    </div>
  );
}
