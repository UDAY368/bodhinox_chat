'use client';

// "Ads created in Bodhinox": the latest ads made from the Create ad dialog
// with their progress (campaign -> ad set -> creative -> ad). It refreshes
// while one is still being made. An 'unknown' one (Meta's answer was unclear)
// can be re-checked (a read at Meta) or discarded; a failed one discarded.

import { useCallback, useEffect, useState } from 'react';
import { ExternalLink, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { authFetch } from '@/lib/auth/client';
import { cn } from '@/lib/utils';
import type { AdDraftDto } from '@/lib/meta-ads/create';
import { formatMoneyValue } from './ads-shared';
import { isCurrencyCode, formatMoney } from '@/lib/commerce/money';

const POLL_MS = 5_000;
const MAX_POLLS = 60;

export function AdDrafts({ canManage, refreshKey }: { canManage: boolean; refreshKey: number }) {
  const t = useTranslations('Ads.drafts');
  const [drafts, setDrafts] = useState<AdDraftDto[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await authFetch('/api/meta-ads/drafts', { cache: 'no-store' });
      if (res.ok) setDrafts(((await res.json()) as { drafts: AdDraftDto[] }).drafts);
    } catch {
      // Keep what is shown; the next refresh tries again.
    }
  }, []);

  useEffect(() => { void load(); }, [load, refreshKey]);

  const running = drafts?.some((d) => d.status === 'queued') ?? false;
  useEffect(() => {
    if (!running) return;
    let polls = 0;
    const timer = setInterval(() => {
      polls += 1;
      if (polls > MAX_POLLS) clearInterval(timer);
      else void load();
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [running, load]);

  const act = async (draft: AdDraftDto, action: 'recheck' | 'discard') => {
    setBusy(draft.id);
    try {
      const res = await authFetch('/api/meta-ads/drafts', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action, id: draft.id }),
      });
      if (!res.ok) throw new Error();
      const next = ((await res.json()) as { draft: AdDraftDto }).draft;
      setDrafts((list) => list?.map((d) => (d.id === next.id ? next : d)) ?? null);
      if (action === 'recheck') toast.message(next.status === 'unknown' ? t('stillUnknown') : t('found'));
    } catch {
      toast.error(t('actionFailed'));
    } finally {
      setBusy(null);
    }
  };

  if (!drafts || drafts.length === 0) return null;
  const budget = (d: AdDraftDto) => (d.currency && isCurrencyCode(d.currency) ? formatMoney(d.dailyBudget, d.currency) : formatMoneyValue(d.dailyBudget / 100, null));

  return (
    <section aria-labelledby="ad-drafts-title" className="rounded-xl border border-border bg-card p-4" data-testid="ad-drafts">
      <h2 id="ad-drafts-title" className="text-sm font-semibold text-foreground">{t('title')}</h2>
      <ul className="mt-3 divide-y divide-border/70">
        {drafts.map((d) => (
          <li key={d.id} className="flex flex-wrap items-center gap-3 py-2.5">
            {d.imageUrl
              // Meta's image URL from the upload.
              // eslint-disable-next-line @next/next/no-img-element
              ? <img src={d.imageUrl} alt="" className="size-10 shrink-0 rounded-md border border-border object-cover" referrerPolicy="no-referrer" />
              : <span className="size-10 shrink-0 rounded-md bg-muted" aria-hidden />}
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium text-foreground">{d.name}</p>
              <p className="text-xs text-muted-foreground">
                {t(`kinds.${d.kind}`)} · {t('perDay', { amount: budget(d) })} · {new Date(d.createdAt).toLocaleString()}
              </p>
            </div>
            <span className={cn('rounded-full px-2 py-0.5 text-xs font-medium',
              d.status === 'created' ? 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
                : d.status === 'failed' ? 'bg-destructive/10 text-destructive'
                : d.status === 'unknown' ? 'bg-amber-500/10 text-amber-700 dark:text-amber-300'
                : 'bg-muted text-muted-foreground')}>
              {d.status === 'queued' && <Loader2 className="mr-1 inline size-3 animate-spin" />}
              {d.status === 'queued' ? t('making', { step: t(`steps.${d.step}`) })
                : d.status === 'created' ? (d.publish ? t('createdLive') : t('createdPaused'))
                : d.status === 'failed' ? t('failed', { code: d.lastErrorCode ?? '-' })
                : t(`status.${d.status}`)}
            </span>
            {d.status === 'created' && d.adId && (
              <a href={`https://adsmanager.facebook.com/adsmanager/manage/ads?act=${encodeURIComponent(d.adAccountId)}&selected_ad_ids=${encodeURIComponent(d.adId)}`}
                target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-xs text-primary hover:underline">
                {t('openInAdsManager')} <ExternalLink className="size-3" />
              </a>
            )}
            {canManage && d.status === 'unknown' && (
              <Button type="button" size="sm" variant="outline" disabled={busy === d.id} onClick={() => void act(d, 'recheck')}>{t('recheck')}</Button>
            )}
            {canManage && (d.status === 'unknown' || d.status === 'failed') && (
              <Button type="button" size="sm" variant="ghost" disabled={busy === d.id} onClick={() => void act(d, 'discard')}>{t('discard')}</Button>
            )}
          </li>
        ))}
      </ul>
      {drafts.some((d) => d.status === 'unknown') && <p className="mt-2 text-xs text-muted-foreground">{t('unknownHelp')}</p>}
    </section>
  );
}
