'use client';

// Settings → Billing → Add-ons (admins): buy extra AI messages, seats or
// WhatsApp numbers on top of the plan, and see or stop the ones bought.
// Renders nothing for members who cannot manage billing. The server decides
// every price, limit and status; a purchase whose outcome the provider did not
// confirm stays "pending" until it is reconciled.

import { useCallback, useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { useFormatter, useTranslations } from 'next-intl';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { useConfirm } from '@/components/ui/confirm-dialog';
import { Input } from '@/components/ui/input';
import { authFetch } from '@/lib/auth/client';
import type { AddonKind } from '@/lib/billing/entitlements-catalogue';
import { InlineError } from '@/components/ui/inline-error';
import { cn } from '@/lib/utils';
import { SETTINGS_ROW_HAIRLINE, SettingsGroup } from '../settings-row';

export interface AddonPackView { kind: AddonKind; quantity: number; amountMinor: number; currency: string }
export interface AddonRowView {
  id: string;
  kind: AddonKind;
  quantity: number;
  status: 'pending' | 'active' | 'cancelled' | 'failed';
  amountMinor: number | null;
  currency: string | null;
  startsAt: string;
  endsAt: string | null;
  createdAt: string;
}
interface AddonsResponse { configured: boolean; packs: AddonPackView[]; addOns: AddonRowView[] }

const MAX_PACKS = 100;
const STATUS_VARIANT = { active: 'default', pending: 'secondary', cancelled: 'outline', failed: 'destructive' } as const;

/** `onChanged` runs after a purchase or cancellation (e.g. to reload plan limits). */
export function AddOnsCard({ onChanged }: { onChanged?: () => void }) {
  const t = useTranslations('Settings.addOns');
  const confirm = useConfirm();
  const format = useFormatter();
  const [data, setData] = useState<AddonsResponse | null | 'hidden' | 'failed'>(null);
  const [packs, setPacks] = useState<Record<string, number>>({});
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await authFetch('/api/billing/add-ons', { cache: 'no-store' });
      if (res.status === 403) return setData('hidden');
      if (!res.ok) return setData('failed');
      setData((await res.json()) as AddonsResponse);
    } catch {
      setData('failed');
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  if (data === 'hidden') return null;
  const money = (minor: number, currency: string) => format.number(minor / 100, { style: 'currency', currency });
  const date = (iso: string) => format.dateTime(new Date(iso), { dateStyle: 'medium' });

  const buy = async (pack: AddonPackView) => {
    const count = packs[pack.kind] ?? 1;
    setBusy(pack.kind);
    try {
      const res = await authFetch('/api/billing/add-ons', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ kind: pack.kind, packs: count }),
      });
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      if (res.status === 201) toast.success(t('purchased'));
      else if (res.status === 202) toast.info(t('purchasePending'));
      else toast.error(body.error || t('purchaseFailed'));
      await load();
      onChanged?.();
    } catch {
      toast.error(t('purchaseFailed'));
    } finally {
      setBusy(null);
    }
  };

  const cancel = async (row: AddonRowView) => {
    if (!(await confirm({ title: t('cancelConfirm'), confirmLabel: t('cancel'), destructive: true }))) return;
    setBusy(row.id);
    try {
      const res = await authFetch(`/api/billing/add-ons?id=${encodeURIComponent(row.id)}`, { method: 'DELETE' });
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      if (res.ok) toast.success(t('cancelled'));
      else toast.error(body.error || t('cancelFailed'));
      await load();
      onChanged?.();
    } catch {
      toast.error(t('cancelFailed'));
    } finally {
      setBusy(null);
    }
  };

  const row = cn(SETTINGS_ROW_HAIRLINE, 'flex min-h-11 flex-wrap items-center gap-3 px-4 py-3');
  const ready = data !== null && data !== 'failed';

  return (
    <SettingsGroup
      testId="add-ons-card"
      title={t('title')}
      footer={<>{t('description')}{ready && data.configured ? <> {t('coverage')}</> : null}</>}
    >
      {data === null ? (
        <div className={cn(row, 'flex-nowrap')} role="status" aria-busy="true">
          <div className="h-4 flex-1 animate-pulse rounded bg-muted motion-reduce:animate-none" />
          <div className="h-8 w-28 animate-pulse rounded-md bg-muted motion-reduce:animate-none" />
        </div>
      ) : data === 'failed' ? (
        <InlineError message={t('loadFailed')} onRetry={() => { setData(null); void load(); }} />
      ) : (
        <>
          {!data.configured ? (
            <div className={row}><p className="text-sm text-muted-foreground">{t('notConfigured')}</p></div>
          ) : (
            data.packs.map((pack) => (
              <div key={pack.kind} className={row}>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium text-foreground">{t(`kinds.${pack.kind}`, { count: pack.quantity })}</p>
                  <p className="text-xs text-muted-foreground">{t('perPack', { price: money(pack.amountMinor, pack.currency) })}</p>
                </div>
                <label className="flex items-center gap-2 text-xs text-muted-foreground">
                  {t('packs')}
                  <Input type="number" min={1} max={MAX_PACKS} className="h-11 w-20 sm:h-8" value={packs[pack.kind] ?? 1}
                    onChange={(e) => setPacks((p) => ({ ...p, [pack.kind]: Math.min(MAX_PACKS, Math.max(1, Math.floor(Number(e.target.value) || 1))) }))} />
                </label>
                <Button size="sm" className="min-h-11 sm:min-h-8" disabled={busy !== null} onClick={() => void buy(pack)}>
                  {busy === pack.kind && <Loader2 className="mr-1 size-3.5 animate-spin" />}
                  {t('buy', { price: money(pack.amountMinor * (packs[pack.kind] ?? 1), pack.currency) })}
                </Button>
              </div>
            ))
          )}
          {data.addOns.length === 0 ? (
            <div className={row}><p className="text-sm text-muted-foreground">{t('empty')}</p></div>
          ) : (
            <div data-testid="add-ons-list" className={SETTINGS_ROW_HAIRLINE}>
              {data.addOns.map((addOn) => (
                <div key={addOn.id} className={cn(row, 'text-sm')}>
                  <span className="min-w-0 flex-1 text-foreground">{t(`kinds.${addOn.kind}`, { count: addOn.quantity })}</span>
                  <Badge variant={STATUS_VARIANT[addOn.status]}>{t(`status.${addOn.status}`)}</Badge>
                  <span className="text-xs text-muted-foreground">
                    {addOn.status === 'active' && addOn.endsAt ? t('until', { date: date(addOn.endsAt) }) : date(addOn.createdAt)}
                  </span>
                  {addOn.status === 'active' && (
                    <Button variant="ghost" size="sm" className="min-h-11 text-destructive sm:min-h-8" disabled={busy !== null} onClick={() => void cancel(addOn)}>{t('cancel')}</Button>
                  )}
                  {addOn.status === 'pending' && <p className="basis-full text-xs text-muted-foreground">{t('pendingHint')}</p>}
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </SettingsGroup>
  );
}
