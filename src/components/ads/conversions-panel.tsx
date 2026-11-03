'use client';

// Conversions API event log and the "Outcome unknown" review list. Events with
// an unknown outcome are never re-sent automatically: an admin checks Events
// Manager and records what happened. Nothing here sends anything to Meta.
import { useCallback, useEffect, useState } from 'react';
import { useFormatter, useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { AlertTriangle } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { authFetch } from '@/lib/auth/client';
import type { CapiListFilter, CapiResolution, ConversionEventDto } from '@/lib/meta-ads/capi';

export interface ConversionsPanelProps {
  /** Only admins may resolve an event with an unknown outcome. */
  canResolve: boolean;
}

const FILTERS: CapiListFilter[] = ['queued', 'sent', 'failed', 'unknown', 'skipped'];
const STATUS_VARIANT: Record<ConversionEventDto['status'], 'default' | 'secondary' | 'destructive' | 'outline'> = {
  queued: 'secondary', sent: 'default', failed: 'destructive', unknown: 'outline', skipped: 'secondary',
};

export function ConversionsPanel({ canResolve }: ConversionsPanelProps) {
  const t = useTranslations('Ads.conversions');
  const tAds = useTranslations('Ads');
  const format = useFormatter();
  const [filter, setFilter] = useState<CapiListFilter | ''>('');
  const [events, setEvents] = useState<ConversionEventDto[] | null>(null);
  const [review, setReview] = useState<ConversionEventDto[]>([]);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!canResolve) return;
    setFailed(false);
    try {
      const fetchList = async (status: string) => {
        const res = await authFetch(`/api/meta-ads/conversions${status ? `?status=${encodeURIComponent(status)}` : ''}`);
        const json = (await res.json().catch(() => ({}))) as { events?: ConversionEventDto[] };
        if (!res.ok || !Array.isArray(json.events)) throw new Error('load failed');
        return json.events;
      };
      const [list, open] = await Promise.all([fetchList(filter), fetchList('review')]);
      setEvents(list);
      setReview(open);
    } catch {
      setFailed(true);
    }
  }, [canResolve, filter]);

  useEffect(() => {
    void load();
  }, [load]);

  if (!canResolve) return <p className="text-sm text-muted-foreground">{t('adminOnly')}</p>;

  const resolve = async (event: ConversionEventDto, resolution: CapiResolution) => {
    setBusy(event.id);
    try {
      const res = await authFetch(`/api/meta-ads/conversions/${encodeURIComponent(event.id)}/resolve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ resolution }),
      });
      // 409: already resolved elsewhere; reload either way.
      if (res.ok) toast.success(t('resolve.done'));
      else if (res.status !== 409) toast.error(t('resolve.failed'));
      await load();
    } catch {
      toast.error(t('resolve.failed'));
    } finally {
      setBusy(null);
    }
  };

  const eventLabel = (name: string) => (t.has(`events.${name}`) ? t(`events.${name}`) : name);
  const when = (iso: string) => format.dateTime(new Date(iso), { dateStyle: 'medium', timeStyle: 'short' });
  const amount = (e: ConversionEventDto) =>
    e.value === null ? '' : e.currency ? format.number(e.value, { style: 'currency', currency: e.currency }) : format.number(e.value);
  const detail = (e: ConversionEventDto) => {
    if (e.resolution) return e.resolution === 'confirmed_sent' ? t('resolve.confirmedSent') : t('resolve.confirmedNotSent');
    if (e.status === 'skipped' && e.skipReason) return t(`skipReasons.${e.skipReason}`);
    if (e.status === 'failed' && e.errorCode) return t('errorCode', { code: e.errorCode });
    return '';
  };

  if (failed) {
    return (
      <div className="space-y-2">
        <p className="text-sm text-destructive">{tAds('loadFailed')}</p>
        <Button size="sm" variant="outline" onClick={() => void load()}>{tAds('retry')}</Button>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {review.length > 0 ? (
        <section className="rounded-lg border border-amber-500/40 bg-amber-500/5 p-4" aria-labelledby="capi-review-title">
          <div className="flex items-start gap-2">
            <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-600" aria-hidden />
            <div className="min-w-0">
              <h2 id="capi-review-title" className="text-sm font-semibold">{t('reviewTitle')}</h2>
              <p className="text-xs text-muted-foreground">{t('reviewHelp')}</p>
            </div>
          </div>
          <ul className="mt-3 divide-y">
            {review.map((e) => (
              <li key={e.id} className="flex flex-col gap-2 py-2 sm:flex-row sm:items-center sm:justify-between">
                <div className="min-w-0 text-sm">
                  <p className="font-medium">{eventLabel(e.eventName)} · {t(`sources.${e.source}`)}{amount(e) ? ` · ${amount(e)}` : ''}</p>
                  <p className="text-xs text-muted-foreground">
                    {[e.contactName ?? t('unknownContact'), when(e.createdAt)].join(' · ')}
                  </p>
                </div>
                <div className="flex shrink-0 flex-wrap gap-2">
                  <Button size="sm" variant="outline" disabled={busy === e.id} onClick={() => void resolve(e, 'confirmed_sent')}>
                    {t('resolve.sent')}
                  </Button>
                  <Button size="sm" variant="outline" disabled={busy === e.id} onClick={() => void resolve(e, 'confirmed_not_sent')}>
                    {t('resolve.notSent')}
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <label className="flex items-center gap-2 text-sm">
        <span className="text-muted-foreground">{t('filterLabel')}</span>
        <select
          className="h-8 rounded-md border border-border bg-background px-2 text-sm"
          value={filter}
          onChange={(ev) => setFilter(ev.target.value as CapiListFilter | '')}
        >
          <option value="">{t('filterAll')}</option>
          {FILTERS.map((f) => (
            <option key={f} value={f}>{t(`status.${f}`)}</option>
          ))}
        </select>
      </label>

      {events === null ? null : events.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('empty')}</p>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-left text-xs text-muted-foreground">
              <tr>
                <th className="px-3 py-2 font-medium">{t('event')}</th>
                <th className="px-3 py-2 font-medium">{t('source')}</th>
                <th className="px-3 py-2 font-medium">{t('contact')}</th>
                <th className="px-3 py-2 text-right font-medium">{t('value')}</th>
                <th className="px-3 py-2 font-medium">{t('statusLabel')}</th>
                <th className="px-3 py-2 font-medium">{t('createdAt')}</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {events.map((e) => (
                <tr key={e.id}>
                  <td className="px-3 py-2">{eventLabel(e.eventName)}</td>
                  <td className="px-3 py-2">{t(`sources.${e.source}`)}</td>
                  <td className="max-w-48 truncate px-3 py-2">{e.contactName ?? t('unknownContact')}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{amount(e)}</td>
                  <td className="px-3 py-2">
                    <Badge variant={STATUS_VARIANT[e.status]}>{t(`status.${e.status}`)}</Badge>
                    {detail(e) ? <span className="ml-2 text-xs text-muted-foreground">{detail(e)}</span> : null}
                  </td>
                  <td className="whitespace-nowrap px-3 py-2 text-muted-foreground">{when(e.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
