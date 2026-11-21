'use client';

// The Ads tab: campaign, ad set or ad rows for the page's range and ad
// account, with spend, reach (for Meta's fixed ranges), impressions, CTR, the
// result each objective is bought for (chats, leads, link clicks, purchases)
// and its cost, chats Bodhinox saw start, and attributed purchases. Ads show
// their creative. Reads stored insights only (GET /api/meta-ads/ads); "Sync now"
// (admins) queues a refresh. "Retarget" on an ad row opens the segment builder
// prefilled with "clicked this ad".

import { useCallback, useEffect, useState } from 'react';
import { BarChart3, Columns3, Download, ImageOff, Loader2, RefreshCw, Target } from 'lucide-react';
import { toast } from 'sonner';
import { useTranslations } from 'next-intl';

import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { downloadCsv } from '@/components/analytics/insights/csv';
import { LoadingRows, MetricHeader, StatusChip } from '@/components/ads/ads-ui';
import { EmptyState } from '@/components/ui/empty-state';
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

/** Columns a member may hide (name and status always show). Kept per browser. */
const OPTIONAL_COLUMNS = ['spend', 'reach', 'impressions', 'ctr', 'results', 'costPerResult', 'conversationsInBodhinox', 'purchases', 'revenue', 'roas'] as const;
type OptionalColumn = (typeof OPTIONAL_COLUMNS)[number];
const HIDDEN_KEY = 'bodhinox.ads.table.hidden';

function readHidden(): OptionalColumn[] {
  try {
    const value = JSON.parse(window.localStorage.getItem(HIDDEN_KEY) ?? '[]');
    return Array.isArray(value) ? value.filter((c): c is OptionalColumn => (OPTIONAL_COLUMNS as readonly string[]).includes(c)) : [];
  } catch {
    return [];
  }
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
  const [hidden, setHidden] = useState<OptionalColumn[]>(() => (typeof window === 'undefined' ? [] : readHidden()));
  const show = (column: OptionalColumn) => !hidden.includes(column);
  const toggleColumn = (column: OptionalColumn) => {
    const next = hidden.includes(column) ? hidden.filter((c) => c !== column) : [...hidden, column];
    setHidden(next);
    try { window.localStorage.setItem(HIDDEN_KEY, JSON.stringify(next)); } catch { /* storage blocked: this view only */ }
  };

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

  const exportCsv = () => {
    if (!rows?.length) return;
    const cols: { key: OptionalColumn | 'name' | 'id' | 'status' | 'currency'; label: string; value: (r: AdRow) => unknown }[] = [
      { key: 'name', label: nameHeader, value: (r) => r.name ?? '' },
      { key: 'id', label: 'ID', value: (r) => r.id },
      { key: 'status', label: t('status'), value: (r) => r.status ?? '' },
      { key: 'currency', label: t('currency'), value: (r) => r.currency ?? '' },
      { key: 'spend', label: t('spend'), value: (r) => r.spend ?? '' },
      { key: 'reach', label: t('reach'), value: (r) => r.reach ?? '' },
      { key: 'impressions', label: t('impressions'), value: (r) => r.impressions ?? '' },
      { key: 'ctr', label: t('ctr'), value: (r) => { const v = ctr(r.clicks, r.impressions); return v === null ? '' : v.toFixed(2); } },
      { key: 'results', label: t('results'), value: (r) => resultOf(r).value ?? '' },
      { key: 'costPerResult', label: t('costPerResult'), value: (r) => { const v = ratio(r.spend, resultOf(r).value); return v === null ? '' : v.toFixed(2); } },
      { key: 'conversationsInBodhinox', label: t('conversationsInBodhinox'), value: (r) => r.conversationsInBodhinox },
      { key: 'purchases', label: t('purchases'), value: (r) => r.purchases },
      { key: 'revenue', label: t('revenue'), value: (r) => r.revenue ?? '' },
      { key: 'roas', label: t('roas'), value: (r) => (r.revenue !== null && r.spend ? (r.revenue / r.spend).toFixed(2) : '') },
    ];
    const visible = cols.filter((c) => !(OPTIONAL_COLUMNS as readonly string[]).includes(c.key) || (show(c.key as OptionalColumn) && (c.key !== 'reach' || showReach)));
    downloadCsv(`ads ${level} ${range.from} ${range.to}`, visible.map((c) => c.label), rows.map((r) => visible.map((c) => c.value(r))));
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
        <div className="ml-auto flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <DropdownMenu>
            <DropdownMenuTrigger render={<Button type="button" variant="outline" size="sm" data-testid="ads-columns" />}>
              <Columns3 className="size-3.5" /> {t('columns')}
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-56">
              {OPTIONAL_COLUMNS.filter((c) => c !== 'reach' || showReach).map((c) => (
                <DropdownMenuCheckboxItem key={c} checked={show(c)} onCheckedChange={() => toggleColumn(c)}>{t(c)}</DropdownMenuCheckboxItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
          <Button type="button" variant="outline" size="sm" disabled={!rows?.length} onClick={() => exportCsv()} data-testid="ads-export">
            <Download className="size-3.5" /> {t('export')}
          </Button>
          <span>{syncedAt ? t('syncedAt', { time: new Date(syncedAt).toLocaleString() }) : t('neverSynced')}</span>
          {canManage && (
            <Button type="button" variant="outline" size="sm" onClick={() => void sync()} disabled={syncing}>
              {syncing ? <Loader2 className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />} {t('sync')}
            </Button>
          )}
        </div>
      </div>

      {!rows && !failed && <LoadingRows />}
      {failed && (
        <div className="flex items-center gap-2 text-sm text-destructive">
          {tAds('loadFailed')}
          <Button type="button" variant="outline" size="sm" onClick={() => void load()}>{tAds('retry')}</Button>
        </div>
      )}
      {rows && rows.length === 0 && <EmptyState icon={BarChart3} title={t('empty')} body={t('emptyBody')} className="rounded-group border border-separator bg-grouped-surface" />}
      {rows && rows.length > 0 && (
        <ul className="space-y-2 md:hidden" data-testid="ads-cards">
          {rows.map((row) => {
            const result = resultOf(row);
            return (
              <li key={row.id} className="rounded-xl border border-border bg-card p-3">
                <div className="flex items-start justify-between gap-2">
                  <button type="button" onClick={() => setOpened(row)} aria-label={t('openDetails', { name: row.name ?? row.id })}
                    className="min-w-0 text-left text-sm font-semibold text-foreground outline-none hover:text-primary focus-visible:ring-2 focus-visible:ring-ring">
                    <span className="line-clamp-2">{row.name ?? row.id}</span>
                  </button>
                  <StatusChip status={row.status} />
                </div>
                <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1.5 text-xs">
                  {([
                    [t('spend'), row.spend == null ? formatCount(null) : formatSpend(row.spend, row.currency)],
                    [`${t('results')} · ${t(`resultKinds.${result.kind}`)}`, formatCount(result.value)],
                    [t('costPerResult'), formatMoneyValue(ratio(row.spend, result.value), row.currency)],
                    [t('roas'), row.revenue !== null && row.spend ? t('roasValue', { value: (row.revenue / row.spend).toFixed(2) }) : '-'],
                  ] as const).map(([label, value]) => (
                    <div key={label} className="min-w-0">
                      <dt className="truncate text-muted-foreground">{label}</dt>
                      <dd className="font-semibold tabular-nums text-foreground">{value}</dd>
                    </div>
                  ))}
                </dl>
              </li>
            );
          })}
        </ul>
      )}
      {rows && rows.length > 0 && (
        <div className="hidden overflow-x-auto rounded-xl border border-border bg-card md:block">
          <table className="w-full min-w-[980px] text-sm">
            <thead className="bg-muted text-left text-xs text-muted-foreground">
              <tr>
                <th className={th}>{nameHeader}</th>
                <th className={th}>{t('status')}</th>
                {show('spend') && <th className={`${th} text-right`}>{t('spend')}</th>}
                {showReach && show('reach') && <th className={`${th} text-right`}><MetricHeader label={t('reach')} help={t('help.reach')} /></th>}
                {show('impressions') && <th className={`${th} text-right`}><MetricHeader label={t('impressions')} help={t('help.impressions')} /></th>}
                {show('ctr') && <th className={`${th} text-right`}><MetricHeader label={t('ctr')} help={t('help.ctr')} /></th>}
                {show('results') && <th className={`${th} text-right`}><MetricHeader label={t('results')} help={t('help.results')} /></th>}
                {show('costPerResult') && <th className={`${th} text-right`}><MetricHeader label={t('costPerResult')} help={t('help.costPerResult')} /></th>}
                {show('conversationsInBodhinox') && <th className={`${th} text-right`}>{t('conversationsInBodhinox')}</th>}
                {show('purchases') && <th className={`${th} text-right`}>{t('purchases')}</th>}
                {show('revenue') && <th className={`${th} text-right`}>{t('revenue')}</th>}
                {show('roas') && <th className={`${th} text-right`}><MetricHeader label={t('roas')} help={t('help.roas')} /></th>}
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
                    <td className="px-3.5 py-3"><StatusChip status={row.status} /></td>
                    {show('spend') && <td className={num}>{row.spend == null ? formatCount(null) : formatSpend(row.spend, row.currency)}</td>}
                    {showReach && show('reach') && <td className={num}>{formatCount(row.reach)}</td>}
                    {show('impressions') && <td className={num}>{formatCount(row.impressions)}</td>}
                    {show('ctr') && <td className={num}>{formatPercent(ctr(row.clicks, row.impressions))}</td>}
                    {show('results') && <td className={num}>
                      {formatCount(result.value)}
                      <div className="text-[11px] font-normal text-muted-foreground">{t(`resultKinds.${result.kind}`)}</div>
                    </td>}
                    {show('costPerResult') && <td className={num}>{formatMoneyValue(ratio(row.spend, result.value), row.currency)}</td>}
                    {show('conversationsInBodhinox') && <td className={num}>{row.conversationsInBodhinox.toLocaleString()}</td>}
                    {show('purchases') && <td className={num}>{row.purchases.toLocaleString()}</td>}
                    {show('revenue') && <td className={num}>
                      {row.revenue === null ? '-' : formatMoneyValue(row.revenue, row.currency)}
                      {row.sales > 0 && <div className="text-[11px] font-normal text-muted-foreground">{t('sales', { count: row.sales })}</div>}
                    </td>}
                    {show('roas') && <td className={num}>{row.revenue !== null && row.spend ? t('roasValue', { value: (row.revenue / row.spend).toFixed(2) }) : '-'}</td>}
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

      <AdDetailDrawer row={opened} level={level} adAccountId={opened?.adAccountId ?? adAccountId} range={range} onClose={() => setOpened(null)} />

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
