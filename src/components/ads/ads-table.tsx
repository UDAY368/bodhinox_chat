'use client';

// The Ads tab: campaign or ad rows with spend, impressions, clicks,
// conversations started (Meta's count), conversations Bodhinox saw start from
// the ad, and attributed purchases. Reads stored insights only
// (GET /api/meta-ads/ads); "Sync now" (admins) queues a refresh. "Retarget" on
// an ad row opens the segment builder prefilled with "clicked this ad".

import { useCallback, useEffect, useState } from 'react';
import { Loader2, RefreshCw, Target } from 'lucide-react';
import { toast } from 'sonner';
import { useTranslations } from 'next-intl';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { SegmentBuilderDialog } from '@/components/contacts/segment-builder-dialog';
import { authFetch } from '@/lib/auth/client';
import type { AudienceCondition } from '@/lib/audience/filter';

export interface AdRow {
  id: string;
  campaignId: string | null;
  name: string | null;
  status: string | null;
  currency: string | null;
  spend: number;
  impressions: number;
  clicks: number;
  conversationsStarted: number;
  conversationsInBodhinox: number;
  purchases: number;
}

type Level = 'campaign' | 'ad';

const DAY_MS = 86_400_000;
const isoDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** Amount in the ad account currency when known, else a plain number. */
export function formatSpend(value: number, currency: string | null): string {
  if (currency && /^[A-Z]{3}$/.test(currency)) {
    try {
      return new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(value);
    } catch {
      // Unknown currency code: fall through to a plain number.
    }
  }
  return new Intl.NumberFormat(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value);
}

export interface AdsTableProps {
  /** Admins may queue a sync. */
  canManage: boolean;
  /** Agents and above may save a retargeting segment. */
  canSegment: boolean;
}

export function AdsTable({ canManage, canSegment }: AdsTableProps) {
  const t = useTranslations('Ads.table');
  const tAds = useTranslations('Ads');
  const [level, setLevel] = useState<Level>('campaign');
  const [from, setFrom] = useState(() => isoDay(Date.now() - 29 * DAY_MS));
  const [to, setTo] = useState(() => isoDay(Date.now()));
  const [rows, setRows] = useState<AdRow[] | null>(null);
  const [syncedAt, setSyncedAt] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [retarget, setRetarget] = useState<AudienceCondition[] | null>(null);

  const load = useCallback(async () => {
    setFailed(false);
    setRows(null);
    try {
      const params = new URLSearchParams({ level, from, to });
      const res = await authFetch(`/api/meta-ads/ads?${params.toString()}`, { cache: 'no-store' });
      if (!res.ok) throw new Error();
      const body = (await res.json()) as { rows: AdRow[]; insightsSyncedAt: string | null };
      setRows(body.rows);
      setSyncedAt(body.insightsSyncedAt);
    } catch {
      setFailed(true);
    }
  }, [level, from, to]);

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

  const nameHeader = level === 'ad' ? t('ad') : t('campaign');

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-3">
        <div className="space-y-1">
          <Label htmlFor="ads-level">{t('level')}</Label>
          <select
            id="ads-level"
            value={level}
            onChange={(e) => setLevel(e.target.value === 'ad' ? 'ad' : 'campaign')}
            className="border-border bg-card text-foreground h-9 rounded-md border px-2 text-sm"
          >
            <option value="campaign">{t('levelCampaign')}</option>
            <option value="ad">{t('levelAd')}</option>
          </select>
        </div>
        <div className="space-y-1">
          <Label htmlFor="ads-from">{t('from')}</Label>
          <Input id="ads-from" type="date" value={from} max={to} onChange={(e) => e.target.value && setFrom(e.target.value)} className="h-9 w-40" />
        </div>
        <div className="space-y-1">
          <Label htmlFor="ads-to">{t('to')}</Label>
          <Input id="ads-to" type="date" value={to} min={from} onChange={(e) => e.target.value && setTo(e.target.value)} className="h-9 w-40" />
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
      {rows && rows.length === 0 && <p className="text-sm text-muted-foreground">{t('empty')}</p>}
      {rows && rows.length > 0 && (
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="w-full min-w-[760px] text-sm">
            <thead className="bg-muted/50 text-left text-xs text-muted-foreground">
              <tr>
                <th className="px-3 py-2 font-medium">{nameHeader}</th>
                <th className="px-3 py-2 font-medium">{t('status')}</th>
                <th className="px-3 py-2 text-right font-medium">{t('spend')}</th>
                <th className="px-3 py-2 text-right font-medium">{t('impressions')}</th>
                <th className="px-3 py-2 text-right font-medium">{t('clicks')}</th>
                <th className="px-3 py-2 text-right font-medium">{t('conversationsStarted')}</th>
                <th className="px-3 py-2 text-right font-medium">{t('conversationsInBodhinox')}</th>
                <th className="px-3 py-2 text-right font-medium">{t('purchases')}</th>
                {level === 'ad' && canSegment && <th className="px-3 py-2"><span className="sr-only">{tAds('retarget')}</span></th>}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id} className="border-t border-border">
                  <td className="px-3 py-2">
                    <div className="font-medium text-foreground">{row.name ?? row.id}</div>
                    <div className="text-xs text-muted-foreground">{row.id}</div>
                  </td>
                  <td className="px-3 py-2 text-muted-foreground">{row.status ?? '-'}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{formatSpend(row.spend, row.currency)}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{row.impressions.toLocaleString()}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{row.clicks.toLocaleString()}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{row.conversationsStarted.toLocaleString()}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{row.conversationsInBodhinox.toLocaleString()}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{row.purchases.toLocaleString()}</td>
                  {level === 'ad' && canSegment && (
                    <td className="px-3 py-2 text-right">
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
              ))}
            </tbody>
          </table>
        </div>
      )}

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
