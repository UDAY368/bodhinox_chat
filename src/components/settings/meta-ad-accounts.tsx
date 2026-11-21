'use client';

// Settings > Ads > Ad accounts: the ad accounts the workspace reports on and
// manages, as their own settings group. The primary one comes from connecting;
// admins add more of the ones the same Facebook login can see (up to 10) with
// the group's one primary action and a Select row, or remove a secondary one
// from its row's more menu.

import { useCallback, useEffect, useState } from 'react';
import { Loader2, Plus, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { useConfirm } from '@/components/ui/confirm-dialog';
import { GroupedListRow } from '@/components/ui/grouped-list';
import { PageLoading } from '@/components/ui/page-loading';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { authFetch } from '@/lib/auth/client';
import type { AvailableAdAccount, LinkedAdAccount } from '@/lib/meta-ads/accounts';
import { SettingsBlock, SettingsGroup, SettingsMoreMenu, SettingsRow } from './settings-row';

const accountLabel = (a: AvailableAdAccount) => `${a.name ?? a.adAccountId}${a.currency ? ` · ${a.currency}` : ''}`;

export function MetaAdAccounts({ canEdit }: { canEdit: boolean }) {
  const t = useTranslations('Ads.accounts');
  const confirm = useConfirm();
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

  const remove = async (a: LinkedAdAccount) => {
    const name = a.name ?? a.adAccountId;
    if (!(await confirm({ title: t('removeConfirm', { name }), body: t('removeBody'), confirmLabel: t('removeAction'), destructive: true }))) return;
    await change('remove', a.adAccountId);
  };

  const picking = canEdit && available !== null && available.length > 0;
  const action = !canEdit || !accounts ? undefined : available === null ? (
    <Button type="button" size="sm" className="min-h-11 sm:min-h-8" disabled={busy} onClick={() => void findMore()}>
      {busy ? <Loader2 className="size-3.5 animate-spin" /> : <Plus className="size-3.5" />} {t('add')}
    </Button>
  ) : (
    <>
      <Button type="button" size="sm" variant="ghost" className="min-h-11 sm:min-h-8" onClick={() => setAvailable(null)}>{t('cancel')}</Button>
      {picking && (
        <Button type="button" size="sm" className="min-h-11 sm:min-h-8" disabled={busy || !choice} onClick={() => void change('add', choice)}>
          {busy && <Loader2 className="size-3.5 animate-spin" />}
          {t('addThis')}
        </Button>
      )}
    </>
  );

  return (
    <SettingsGroup testId="meta-ad-accounts" title={t('title')} footer={t('description')} action={action}>
      {!accounts && <SettingsBlock><PageLoading rows={2} /></SettingsBlock>}
      {accounts?.map((a) => (
        <GroupedListRow
          key={a.adAccountId}
          title={<span className="font-medium">{a.name ?? a.adAccountId}</span>}
          subtitle={<>
            {a.adAccountId}{a.currency ? ` · ${a.currency}` : ''}
            {a.lastErrorCode ? ` · ${t('syncError', { code: a.lastErrorCode })}` : a.insightsSyncedAt ? ` · ${t('synced', { time: new Date(a.insightsSyncedAt).toLocaleString() })}` : ''}
          </>}
          trailing={a.isPrimary
            ? <span className="rounded-full bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary">{t('primary')}</span>
            : canEdit && (
              <SettingsMoreMenu
                label={t('moreFor', { name: a.name ?? a.adAccountId })}
                actions={[{
                  label: t('remove', { name: a.name ?? a.adAccountId }),
                  icon: Trash2,
                  destructive: true,
                  disabled: busy,
                  onSelect: () => void remove(a),
                }]}
              />
            )}
          className="py-1.5"
        />
      ))}
      {canEdit && available !== null && available.length === 0 && (
        <GroupedListRow title={<span className="text-muted-foreground">{t('noneAvailable')}</span>} className="[&_.truncate]:whitespace-normal" />
      )}
      {picking && (
        <SettingsRow label={t('choose')}>
          <Select value={choice || null} onValueChange={(v) => setChoice(v ? String(v) : '')}>
            <SelectTrigger aria-label={t('choose')} className="min-h-11 w-full bg-card sm:min-h-9">
              <SelectValue placeholder={t('choose')}>{(v: string | null) => {
                const a = available.find((x) => x.adAccountId === v);
                return a ? accountLabel(a) : t('choose');
              }}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              {available.map((a) => <SelectItem key={a.adAccountId} value={a.adAccountId}>{accountLabel(a)}</SelectItem>)}
            </SelectContent>
          </Select>
        </SettingsRow>
      )}
    </SettingsGroup>
  );
}
