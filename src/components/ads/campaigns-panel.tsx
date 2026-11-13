'use client';

// The Campaigns tab (ad management, phase A): the connected ad account's
// campaigns, ad sets and ads as a tree, with Meta's delivery status, budget,
// end date and the last 30 days' spend and chats. Admins can pause / resume,
// change a budget or an ad set's end date, and rename, each after a confirm
// step that states the exact change. Changes are sent by the worker; while one
// is on its way the panel refreshes itself. A change whose outcome Meta left
// unclear is listed for an admin to check again or dismiss. A workspace daily
// budget cap stops anyone from setting (or resuming at) a higher budget.

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, ChevronRight, Loader2, MoreHorizontal, Pause, Play, RefreshCw, ShieldAlert } from 'lucide-react';
import { toast } from 'sonner';
import { useTranslations } from 'next-intl';

import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { formatSpend } from '@/components/ads/ads-table';
import { authFetch } from '@/lib/auth/client';
import { formatMoney, isCurrencyCode, parseMoney } from '@/lib/commerce/money';
import type { AdChangeDto, AdChangeField, AdManageView, AdObjectDto } from '@/lib/meta-ads/manage';
import { cn } from '@/lib/utils';

type Edit =
  | { kind: 'status'; object: AdObjectDto; value: 'ACTIVE' | 'PAUSED' }
  | { kind: 'daily_budget' | 'lifetime_budget'; object: AdObjectDto }
  | { kind: 'end_time'; object: AdObjectDto }
  | { kind: 'name'; object: AdObjectDto }
  | { kind: 'cap' };

/** Refresh while a change is on its way, for at most this long. */
const POLL_MS = 4000;
const POLL_LIMIT = 30;

const money = (minor: number | null, currency: string | null) =>
  minor === null ? '-' : currency && isCurrencyCode(currency) ? formatMoney(minor, currency) : minor.toLocaleString();

/** A local date-time input value (YYYY-MM-DDTHH:mm) for an ISO time. */
const localInput = (iso: string | null) => {
  const d = iso ? new Date(iso) : new Date(Date.now() + 7 * 86_400_000);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

export function CampaignsPanel({ canManage }: { canManage: boolean }) {
  const t = useTranslations('Ads.manage');
  const tAds = useTranslations('Ads');
  const [view, setView] = useState<AdManageView | null>(null);
  const [failed, setFailed] = useState(false);
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [edit, setEdit] = useState<Edit | null>(null);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const polls = useRef(0);

  const load = useCallback(async () => {
    setFailed(false);
    try {
      const res = await authFetch('/api/meta-ads/manage', { cache: 'no-store' });
      if (!res.ok) throw new Error();
      setView((await res.json()) as AdManageView);
    } catch {
      setFailed(true);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const queued = view?.changes.some((c) => c.status === 'queued') ?? false;
  useEffect(() => {
    if (!queued) {
      polls.current = 0;
      return;
    }
    if (polls.current >= POLL_LIMIT) return;
    const timer = setTimeout(() => {
      polls.current += 1;
      void load();
    }, POLL_MS);
    return () => clearTimeout(timer);
  }, [queued, view, load]);

  const currency = view?.currency ?? null;
  const canChange = canManage && !!view?.manageEnabled && (view?.missingScopes.length ?? 1) === 0;
  const openChange = useMemo(() => {
    const map = new Map<string, AdChangeDto>();
    for (const c of view?.changes ?? []) if (c.status === 'queued' || c.status === 'unknown') map.set(`${c.objectId}:${c.field}`, c);
    return map;
  }, [view]);

  const tree = useMemo(() => {
    const objects = view?.objects ?? [];
    const children = (level: AdObjectDto['level'], parent: (o: AdObjectDto) => string | null, id: string) =>
      objects.filter((o) => o.level === level && parent(o) === id);
    return objects.filter((o) => o.level === 'campaign').map((campaign) => ({
      campaign,
      adsets: children('adset', (o) => o.campaignId, campaign.id).map((adset) => ({
        adset,
        ads: children('ad', (o) => o.adsetId, adset.id),
      })),
    }));
  }, [view]);

  const toggle = (id: string) => setOpen((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return next;
  });

  const startEdit = (next: Edit) => {
    setEdit(next);
    if (next.kind === 'daily_budget' || next.kind === 'lifetime_budget') {
      const minor = next.kind === 'daily_budget' ? next.object.dailyBudget : next.object.lifetimeBudget;
      setDraft(minor !== null && currency && isCurrencyCode(currency) ? money(minor, currency).replace(/[^\d.,]/g, '') : '');
    } else if (next.kind === 'end_time') setDraft(localInput(next.object.endTime));
    else if (next.kind === 'name') setDraft(next.object.name ?? '');
    else if (next.kind === 'cap') {
      setDraft(view?.maxDailyBudget != null && currency && isCurrencyCode(currency)
        ? money(view.maxDailyBudget, currency).replace(/[^\d.,]/g, '') : '');
    }
  };

  const errorMessage = async (res: Response) => {
    const body = (await res.json().catch(() => null)) as { message?: unknown } | null;
    return typeof body?.message === 'string' ? body.message : t('failed');
  };

  /** The value sent to the API, or null (with a toast) when the input is not usable. */
  const valueOf = (current: Edit): string | number | null => {
    if (current.kind === 'status') return current.value;
    if (current.kind === 'name') return draft.trim() || null;
    if (current.kind === 'end_time') {
      const ms = Date.parse(draft);
      return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
    }
    if (!currency || !isCurrencyCode(currency)) return null;
    try {
      return parseMoney(draft, currency);
    } catch {
      return null;
    }
  };

  const submit = async () => {
    if (!edit) return;
    if (edit.kind === 'cap' && draft.trim() === '') return saveCap(null);
    const value = valueOf(edit);
    if (value === null || value === 0) {
      toast.error(t('invalidValue'));
      return;
    }
    if (edit.kind === 'cap') return saveCap(value as number);
    setBusy(true);
    try {
      const res = await authFetch('/api/meta-ads/manage/changes', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ objectId: edit.object.id, field: edit.kind, value: String(value) }),
      });
      if (!res.ok) {
        toast.error(await errorMessage(res));
        return;
      }
      toast.success(t('sent'));
      setEdit(null);
      polls.current = 0;
      await load();
    } finally {
      setBusy(false);
    }
  };

  const saveCap = async (cap: number | null) => {
    setBusy(true);
    try {
      const res = await authFetch('/api/meta-ads/manage/budget-cap', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ maxDailyBudget: cap }),
      });
      if (!res.ok) {
        toast.error(await errorMessage(res));
        return;
      }
      toast.success(t('capSaved'));
      setEdit(null);
      await load();
    } finally {
      setBusy(false);
    }
  };

  const reconcile = async (change: AdChangeDto, action: 'recheck' | 'dismiss') => {
    setBusy(true);
    try {
      const res = await authFetch(`/api/meta-ads/manage/changes/${change.id}/${action}`, { method: 'POST' });
      if (!res.ok) {
        toast.error(await errorMessage(res));
        return;
      }
      const body = (await res.json()) as { change: AdChangeDto };
      if (action === 'recheck') toast[body.change.status === 'applied' ? 'success' : 'info'](
        body.change.status === 'applied' ? t('recheckApplied') : t('recheckNotShown'));
      await load();
    } finally {
      setBusy(false);
    }
  };

  const refresh = async () => {
    setBusy(true);
    try {
      const res = await authFetch('/api/meta-ads/manage/sync', { method: 'POST' });
      if (!res.ok) throw new Error();
      toast.success(t('refreshQueued'));
    } catch {
      toast.error(t('failed'));
    } finally {
      setBusy(false);
    }
  };

  const fieldLabel = (field: AdChangeField) => t(`fields.${field}`);
  const shown = (change: AdChangeDto, value: string | null) => {
    if (value === null) return '-';
    if (change.field === 'daily_budget' || change.field === 'lifetime_budget') return money(Number(value), currency);
    if (change.field === 'end_time') return new Date(value).toLocaleString();
    if (change.field === 'status') return t(`status.${value === 'ACTIVE' ? 'active' : 'paused'}`);
    return value;
  };

  const budgetCell = (o: AdObjectDto) =>
    o.dailyBudget !== null ? t('perDay', { amount: money(o.dailyBudget, currency) })
      : o.lifetimeBudget !== null ? t('total', { amount: money(o.lifetimeBudget, currency) }) : '-';

  const row = (o: AdObjectDto, depth: number, expandable: boolean) => {
    const pending = openChange.get(`${o.id}:status`);
    const paused = o.status === 'PAUSED';
    const changeable = o.status === 'ACTIVE' || o.status === 'PAUSED';
    return (
      <tr key={o.id} className="border-t border-border/70 transition-colors duration-150 hover:bg-muted/60" data-ad-object={o.level}>
        <td className="px-3.5 py-3">
          <div className="flex items-center gap-1" style={{ paddingLeft: depth * 20 }}>
            {expandable ? (
              <button type="button" onClick={() => toggle(o.id)} aria-expanded={open.has(o.id)}
                aria-label={open.has(o.id) ? t('collapse') : t('expand')}
                className="text-muted-foreground hover:text-foreground rounded p-0.5">
                {open.has(o.id) ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}
              </button>
            ) : <span className="w-5" />}
            <div className="min-w-0">
              <div className="truncate font-semibold text-foreground">{o.name ?? o.id}</div>
              <div className="text-xs text-muted-foreground">{t(`levels.${o.level}`)} · {o.id}</div>
            </div>
          </div>
        </td>
        <td className="px-3.5 py-3">
          <span className={cn('rounded-full px-2 py-0.5 text-xs font-medium',
            o.effectiveStatus === 'ACTIVE' ? 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300' : 'bg-muted text-muted-foreground')}>
            {o.effectiveStatus ?? o.status ?? '-'}
          </span>
        </td>
        <td className="px-3.5 py-3 tabular-nums">{budgetCell(o)}</td>
        <td className="px-3.5 py-3 text-muted-foreground">{o.endTime ? new Date(o.endTime).toLocaleDateString() : '-'}</td>
        <td className="px-3.5 py-3 text-right tabular-nums">{o.spend === null ? '-' : formatSpend(o.spend, currency)}</td>
        <td className="px-3.5 py-3 text-right tabular-nums">{o.conversationsStarted === null ? '-' : o.conversationsStarted.toLocaleString()}</td>
        {canChange && (
          <td className="px-3.5 py-3 text-right">
            <div className="flex items-center justify-end gap-1">
              {changeable && (
                <Button type="button" variant="outline" size="sm" disabled={!!pending || busy}
                  onClick={() => startEdit({ kind: 'status', object: o, value: paused ? 'ACTIVE' : 'PAUSED' })}>
                  {pending ? <Loader2 className="size-3.5 animate-spin" /> : paused ? <Play className="size-3.5" /> : <Pause className="size-3.5" />}
                  {paused ? t('resume') : t('pause')}
                </Button>
              )}
              <DropdownMenu>
                <DropdownMenuTrigger aria-label={t('more')} title={t('more')}
                  className="text-muted-foreground hover:bg-muted hover:text-foreground inline-flex size-8 items-center justify-center rounded-md">
                  <MoreHorizontal className="size-4" />
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  {o.dailyBudget !== null && (
                    <DropdownMenuItem onClick={() => startEdit({ kind: 'daily_budget', object: o })}>{t('changeDaily')}</DropdownMenuItem>
                  )}
                  {o.lifetimeBudget !== null && (
                    <DropdownMenuItem onClick={() => startEdit({ kind: 'lifetime_budget', object: o })}>{t('changeLifetime')}</DropdownMenuItem>
                  )}
                  {o.level === 'adset' && (
                    <DropdownMenuItem onClick={() => startEdit({ kind: 'end_time', object: o })}>{t('changeEnd')}</DropdownMenuItem>
                  )}
                  <DropdownMenuItem onClick={() => startEdit({ kind: 'name', object: o })}>{t('rename')}</DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </td>
        )}
      </tr>
    );
  };

  if (failed) {
    return (
      <div className="flex items-center gap-2 text-sm text-destructive">
        {tAds('loadFailed')}
        <Button type="button" variant="outline" size="sm" onClick={() => void load()}>{tAds('retry')}</Button>
      </div>
    );
  }
  if (!view) return <Loader2 className="size-4 animate-spin text-primary" />;

  const unknown = view.changes.filter((c) => c.status === 'unknown');
  const recent = view.changes.filter((c) => c.status !== 'unknown').slice(0, 8);
  const title = edit?.kind === 'cap' ? t('capTitle')
    : edit?.kind === 'status' ? t(edit.value === 'ACTIVE' ? 'confirmResume' : 'confirmPause', { name: edit.object.name ?? edit.object.id })
    : edit ? t(`edit.${edit.kind}`, { name: edit.object.name ?? edit.object.id }) : '';

  return (
    <div className="space-y-4" data-testid="campaigns-panel">
      {!view.manageEnabled && <p className="rounded-xl bg-muted p-3 text-sm text-muted-foreground">{t('manageOff')}</p>}
      {view.manageEnabled && view.missingScopes.length > 0 && (
        <p className="rounded-xl border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-amber-800 dark:text-amber-300">
          {t('missingScopes', { scopes: view.missingScopes.join(', ') })}
        </p>
      )}

      <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
        <span>{view.syncedAt ? t('syncedAt', { time: new Date(view.syncedAt).toLocaleString() }) : t('neverSynced')}</span>
        <span>
          {view.maxDailyBudget !== null ? t('capIs', { amount: money(view.maxDailyBudget, currency) }) : t('noCap')}
        </span>
        {canManage && (
          <div className="ml-auto flex gap-2">
            <Button type="button" variant="outline" size="sm" onClick={() => startEdit({ kind: 'cap' })} disabled={busy}>
              <ShieldAlert className="size-3.5" /> {t('setCap')}
            </Button>
            <Button type="button" variant="outline" size="sm" onClick={() => void refresh()} disabled={busy}>
              <RefreshCw className="size-3.5" /> {t('refresh')}
            </Button>
          </div>
        )}
      </div>

      {unknown.length > 0 && (
        <div className="space-y-2 rounded-xl border border-amber-500/40 bg-amber-500/5 p-3" data-testid="ad-changes-unknown">
          <p className="text-sm font-medium text-foreground">{t('unknownTitle')}</p>
          <p className="text-xs text-muted-foreground">{t('unknownHelp')}</p>
          {unknown.map((c) => (
            <div key={c.id} className="flex flex-wrap items-center gap-2 text-sm">
              <span className="min-w-0 basis-full sm:basis-0 sm:flex-1">
                {t('changeLine', { name: c.objectName ?? c.objectId, field: fieldLabel(c.field), from: shown(c, c.fromValue), to: shown(c, c.toValue) })}
              </span>
              {canManage && (
                <>
                  <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => void reconcile(c, 'recheck')}>{t('recheck')}</Button>
                  <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={() => void reconcile(c, 'dismiss')}>{t('dismiss')}</Button>
                </>
              )}
            </div>
          ))}
        </div>
      )}

      {tree.length === 0 ? (
        <p className="rounded-xl border border-border bg-card px-4 py-12 text-center text-sm text-muted-foreground">{t('empty')}</p>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-border bg-card">
          <table className="w-full min-w-[820px] text-sm">
            <thead className="bg-muted text-left text-xs text-muted-foreground">
              <tr>
                <th className="px-3.5 py-2.5 font-semibold">{t('name')}</th>
                <th className="px-3.5 py-2.5 font-semibold">{t('delivery')}</th>
                <th className="px-3.5 py-2.5 font-semibold">{t('budget')}</th>
                <th className="px-3.5 py-2.5 font-semibold">{t('ends')}</th>
                <th className="px-3.5 py-2.5 text-right font-semibold">{t('spend30')}</th>
                <th className="px-3.5 py-2.5 text-right font-semibold">{t('chats30')}</th>
                {canChange && <th className="px-3 py-2"><span className="sr-only">{t('actions')}</span></th>}
              </tr>
            </thead>
            <tbody>
              {tree.map(({ campaign, adsets }) => (
                <Fragment key={campaign.id}>
                  {row(campaign, 0, adsets.length > 0)}
                  {open.has(campaign.id) && adsets.map(({ adset, ads }) => (
                    <Fragment key={adset.id}>
                      {row(adset, 1, ads.length > 0)}
                      {open.has(adset.id) && ads.map((ad) => row(ad, 2, false))}
                    </Fragment>
                  ))}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {recent.length > 0 && (
        <div className="space-y-1">
          <p className="text-xs font-medium text-muted-foreground">{t('recentTitle')}</p>
          <ul className="space-y-1 text-xs text-muted-foreground" data-testid="ad-changes-recent">
            {recent.map((c) => (
              <li key={c.id} className="flex flex-wrap gap-x-2">
                <span className={cn('font-medium', c.status === 'applied' ? 'text-emerald-700 dark:text-emerald-300'
                  : c.status === 'failed' ? 'text-destructive' : 'text-foreground')}>{t(`changeStatus.${c.status}`)}</span>
                <span>{t('changeLine', { name: c.objectName ?? c.objectId, field: fieldLabel(c.field), from: shown(c, c.fromValue), to: shown(c, c.toValue) })}</span>
                <span>· {new Date(c.createdAt).toLocaleString()}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <Dialog open={edit !== null} onOpenChange={(next) => { if (!next && !busy) setEdit(null); }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            <DialogDescription>
              {edit?.kind === 'cap' ? t('capHelp')
                : edit?.kind === 'status' ? t(edit.value === 'ACTIVE' ? 'resumeHelp' : 'pauseHelp')
                : t('editHelp')}
            </DialogDescription>
          </DialogHeader>
          {edit && edit.kind !== 'status' && (
            <div className="space-y-1">
              <Label htmlFor="ad-edit-value">
                {edit.kind === 'cap' || edit.kind === 'daily_budget' || edit.kind === 'lifetime_budget'
                  ? t('amountIn', { currency: currency ?? '' }) : edit.kind === 'end_time' ? t('fields.end_time') : t('fields.name')}
              </Label>
              <Input id="ad-edit-value" value={draft} onChange={(e) => setDraft(e.target.value)}
                type={edit.kind === 'end_time' ? 'datetime-local' : 'text'}
                inputMode={edit.kind === 'name' || edit.kind === 'end_time' ? undefined : 'decimal'}
                maxLength={edit.kind === 'name' ? 400 : 40} autoFocus />
              {(edit.kind === 'daily_budget' || edit.kind === 'lifetime_budget') && (
                <p className="text-xs text-muted-foreground">
                  {t('currentValue', { amount: money(edit.kind === 'daily_budget' ? edit.object.dailyBudget : edit.object.lifetimeBudget, currency) })}
                  {view.maxDailyBudget !== null && ` · ${t('capIs', { amount: money(view.maxDailyBudget, currency) })}`}
                </p>
              )}
              {edit.kind === 'cap' && <p className="text-xs text-muted-foreground">{t('capClear')}</p>}
            </div>
          )}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => setEdit(null)} disabled={busy}>{t('cancel')}</Button>
            <Button type="button" onClick={() => void submit()} disabled={busy}>
              {busy && <Loader2 className="size-3.5 animate-spin" />}
              {edit?.kind === 'cap' ? t('save') : edit?.kind === 'status' ? (edit.value === 'ACTIVE' ? t('resume') : t('pause')) : t('sendChange')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
