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
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { authFetch } from '@/lib/auth/client';
import type { AddonKind } from '@/lib/billing/entitlements-catalogue';

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
    if (!window.confirm(t('cancelConfirm'))) return;
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

  return (
    <Card data-testid="add-ons-card">
      <CardHeader>
        <CardTitle className="text-foreground">{t('title')}</CardTitle>
        <CardDescription>{t('description')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {data === null ? (
          <Loader2 className="size-5 animate-spin text-primary" />
        ) : data === 'failed' ? (
          <div className="flex items-center gap-3 text-sm text-muted-foreground">
            {t('loadFailed')}
            <Button variant="outline" size="sm" onClick={() => { setData(null); void load(); }}>{t('retry')}</Button>
          </div>
        ) : (
          <>
            {!data.configured ? (
              <p className="text-sm text-muted-foreground">{t('notConfigured')}</p>
            ) : (
              <ul className="space-y-3">
                {data.packs.map((pack) => (
                  <li key={pack.kind} className="flex flex-wrap items-center gap-3 rounded-md border border-border p-3">
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium text-foreground">{t(`kinds.${pack.kind}`, { count: pack.quantity })}</p>
                      <p className="text-xs text-muted-foreground">{t('perPack', { price: money(pack.amountMinor, pack.currency) })}</p>
                    </div>
                    <label className="flex items-center gap-2 text-xs text-muted-foreground">
                      {t('packs')}
                      <Input type="number" min={1} max={MAX_PACKS} className="h-8 w-20" value={packs[pack.kind] ?? 1}
                        onChange={(e) => setPacks((p) => ({ ...p, [pack.kind]: Math.min(MAX_PACKS, Math.max(1, Math.floor(Number(e.target.value) || 1))) }))} />
                    </label>
                    <Button size="sm" disabled={busy !== null} onClick={() => void buy(pack)}>
                      {busy === pack.kind && <Loader2 className="mr-1 size-3.5 animate-spin" />}
                      {t('buy', { price: money(pack.amountMinor * (packs[pack.kind] ?? 1), pack.currency) })}
                    </Button>
                  </li>
                ))}
              </ul>
            )}
            {data.configured && <p className="text-xs text-muted-foreground">{t('coverage')}</p>}
            {data.addOns.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t('empty')}</p>
            ) : (
              <ul className="divide-y divide-border" data-testid="add-ons-list">
                {data.addOns.map((row) => (
                  <li key={row.id} className="flex flex-wrap items-center gap-3 py-2 text-sm">
                    <span className="min-w-0 flex-1 text-foreground">{t(`kinds.${row.kind}`, { count: row.quantity })}</span>
                    <Badge variant={STATUS_VARIANT[row.status]}>{t(`status.${row.status}`)}</Badge>
                    <span className="text-xs text-muted-foreground">
                      {row.status === 'active' && row.endsAt ? t('until', { date: date(row.endsAt) }) : date(row.createdAt)}
                    </span>
                    {row.status === 'active' && (
                      <Button variant="ghost" size="sm" disabled={busy !== null} onClick={() => void cancel(row)}>{t('cancel')}</Button>
                    )}
                    {row.status === 'pending' && <p className="basis-full text-xs text-muted-foreground">{t('pendingHint')}</p>}
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
