'use client';

// Settings > Ads > Ad accounts: the ad accounts the workspace reports on and
// manages. The primary one comes from connecting; admins add more of the ones
// the same Facebook login can see (up to 10), or remove a secondary one.

import { useCallback, useEffect, useState } from 'react';
import { Loader2, Plus, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { authFetch } from '@/lib/auth/client';
import type { AvailableAdAccount, LinkedAdAccount } from '@/lib/meta-ads/accounts';

export function MetaAdAccounts({ canEdit }: { canEdit: boolean }) {
  const t = useTranslations('Ads.accounts');
  const [accounts, setAccounts] = useState<LinkedAdAccount[] | null>(null);
  const [available, setAvailable] = useState<AvailableAdAccount[] | null>(null);
  const [choice, setChoice] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await authFetch('/api/meta-ads/accounts', { cache: 'no-store' });
      if (res.ok) setAccounts(((await res.json()) as { accounts: LinkedAdAccount[] }).accounts);
    } catch {
      setAccounts([]);
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const findMore = async () => {
    setBusy(true);
    try {
      const res = await authFetch('/api/meta-ads/accounts?available=1', { cache: 'no-store' });
      if (!res.ok) throw new Error();
      const body = (await res.json()) as { accounts: LinkedAdAccount[]; available: AvailableAdAccount[] };
      setAccounts(body.accounts);
      setAvailable(body.available);
      setChoice(body.available[0]?.adAccountId ?? '');
    } catch {
      toast.error(t('loadFailed'));
    } finally {
      setBusy(false);
    }
  };

  const change = async (action: 'add' | 'remove', adAccountId: string) => {
    setBusy(true);
    try {
      const res = await authFetch('/api/meta-ads/accounts', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action, adAccountId }),
      });
      if (!res.ok) throw new Error();
      setAccounts(((await res.json()) as { accounts: LinkedAdAccount[] }).accounts);
      setAvailable(null);
      toast.success(action === 'add' ? t('added') : t('removed'));
    } catch {
      toast.error(t('changeFailed'));
    } finally {
      setBusy(false);
    }
  };

  if (!accounts) return <Loader2 className="size-4 animate-spin text-primary" />;

  return (
    <section aria-labelledby="meta-ad-accounts-title" className="space-y-3" data-testid="meta-ad-accounts">
      <div>
        <h3 id="meta-ad-accounts-title" className="text-sm font-semibold text-foreground">{t('title')}</h3>
        <p className="text-xs text-muted-foreground">{t('description')}</p>
      </div>
      <ul className="divide-y divide-border/70 rounded-xl border border-border">
        {accounts.map((a) => (
          <li key={a.adAccountId} className="flex flex-wrap items-center gap-3 px-3 py-2.5 text-sm">
            <div className="min-w-0 flex-1">
              <p className="truncate font-medium text-foreground">{a.name ?? a.adAccountId}</p>
              <p className="text-xs text-muted-foreground">
                {a.adAccountId}{a.currency ? ` · ${a.currency}` : ''}
                {a.lastErrorCode ? ` · ${t('syncError', { code: a.lastErrorCode })}` : a.insightsSyncedAt ? ` · ${t('synced', { time: new Date(a.insightsSyncedAt).toLocaleString() })}` : ''}
              </p>
            </div>
            {a.isPrimary
              ? <span className="rounded-full bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary">{t('primary')}</span>
              : canEdit && (
                <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={() => void change('remove', a.adAccountId)}
                  aria-label={t('remove', { name: a.name ?? a.adAccountId })}>
                  <Trash2 className="size-3.5" />
                </Button>
              )}
          </li>
        ))}
      </ul>
      {canEdit && available === null && (
        <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => void findMore()}>
          {busy ? <Loader2 className="size-3.5 animate-spin" /> : <Plus className="size-3.5" />} {t('add')}
        </Button>
      )}
      {canEdit && available !== null && (
        available.length === 0 ? (
          <p className="text-xs text-muted-foreground">{t('noneAvailable')}</p>
        ) : (
          <div className="flex flex-wrap items-center gap-2">
            <select value={choice} onChange={(e) => setChoice(e.target.value)} aria-label={t('choose')}
              className="h-9 max-w-xs rounded-lg border border-border bg-card px-2.5 text-sm">
              {available.map((a) => <option key={a.adAccountId} value={a.adAccountId}>{a.name ?? a.adAccountId}{a.currency ? ` · ${a.currency}` : ''}</option>)}
            </select>
            <Button type="button" size="sm" disabled={busy || !choice} onClick={() => void change('add', choice)}>{t('addThis')}</Button>
            <Button type="button" size="sm" variant="ghost" onClick={() => setAvailable(null)}>{t('cancel')}</Button>
          </div>
        )
      )}
    </section>
  );
}
