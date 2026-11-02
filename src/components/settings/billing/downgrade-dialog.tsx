'use client';

// Choose what stays active under a smaller plan (admins). Shows, per kind, the
// items in use when the target plan allows fewer; the admin ticks up to the
// limit. Nothing is deleted: the rest are archived and restored when the
// limits allow again. Without a choice, the most recently used items stay.

import { useCallback, useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { useFormatter, useTranslations } from 'next-intl';

import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { authFetch } from '@/lib/auth/client';

export type ArchivableKindView = 'segments' | 'lists' | 'flows' | 'automations';
export interface DowngradeOverviewView {
  plan: { id: string; name: string };
  effectiveAt: string | null;
  pending: boolean;
  kinds: { kind: ArchivableKindView; limit: number | null; items: { id: string; name: string; lastUsedAt: string | null }[]; excess: number }[];
  selection: Partial<Record<ArchivableKindView, string[]>> | null;
  archived: { kind: ArchivableKindView; id: string; name: string; archivedAt: string }[];
}

/** The default choice per kind: the stored selection, else the most recently used up to the limit. */
export function initialKeep(view: DowngradeOverviewView): Partial<Record<ArchivableKindView, string[]>> {
  const keep: Partial<Record<ArchivableKindView, string[]>> = {};
  for (const k of view.kinds) {
    if (k.excess <= 0 || k.limit === null) continue;
    const inUse = new Set(k.items.map((i) => i.id));
    const stored = (view.selection?.[k.kind] ?? []).filter((id) => inUse.has(id));
    keep[k.kind] = (stored.length ? stored : k.items.map((i) => i.id)).slice(0, k.limit);
  }
  return keep;
}

/** Fetches /api/billing/downgrade-plan when opened. `onSaved` runs after a choice is stored. */
export function DowngradeDialog({ open, onOpenChange, onSaved }: { open: boolean; onOpenChange: (open: boolean) => void; onSaved?: () => void }) {
  const t = useTranslations('Settings.planDowngrade');
  const format = useFormatter();
  const [view, setView] = useState<DowngradeOverviewView | null | 'failed'>(null);
  const [keep, setKeep] = useState<Partial<Record<ArchivableKindView, string[]>>>({});
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setView(null);
    try {
      const res = await authFetch('/api/billing/downgrade-plan', { cache: 'no-store' });
      if (!res.ok) return setView('failed');
      const body = (await res.json()) as DowngradeOverviewView;
      setView(body);
      setKeep(initialKeep(body));
    } catch {
      setView('failed');
    }
  }, []);

  useEffect(() => { if (open) void load(); }, [open, load]);

  const date = (iso: string) => format.dateTime(new Date(iso), { dateStyle: 'medium' });
  const over = view && view !== 'failed' ? view.kinds.filter((k) => k.excess > 0 && k.limit !== null) : [];

  const toggle = (kind: ArchivableKindView, id: string, limit: number, on: boolean) => setKeep((current) => {
    const ids = current[kind] ?? [];
    if (on) return ids.includes(id) || ids.length >= limit ? current : { ...current, [kind]: [...ids, id] };
    return { ...current, [kind]: ids.filter((x) => x !== id) };
  });

  const save = async () => {
    if (!view || view === 'failed') return;
    setSaving(true);
    try {
      const res = await authFetch('/api/billing/downgrade-plan', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ plan: view.plan.id, keep }),
      });
      const body = (await res.json().catch(() => ({}))) as { error?: string; applied?: boolean };
      if (!res.ok) {
        toast.error(body.error || t('saveFailed'));
        if (res.status === 409) void load();
        return;
      }
      toast.success(body.applied ? t('saved') : t('savedPending'));
      onSaved?.();
      onOpenChange(false);
    } catch {
      toast.error(t('saveFailed'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="bg-popover border-border sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="text-popover-foreground">{t('title')}</DialogTitle>
          <DialogDescription className="text-muted-foreground">
            {view && view !== 'failed'
              ? view.pending && view.effectiveAt
                ? t('effective', { plan: view.plan.name, date: date(view.effectiveAt) })
                : t('inEffect', { plan: view.plan.name })
              : t('description')}
          </DialogDescription>
        </DialogHeader>
        {view === null ? (
          <Loader2 className="size-5 animate-spin text-primary" />
        ) : view === 'failed' ? (
          <div className="flex items-center gap-3 text-sm text-muted-foreground">
            {t('loadFailed')}
            <Button variant="outline" size="sm" onClick={() => void load()}>{t('retry')}</Button>
          </div>
        ) : (
          <div className="max-h-[60vh] space-y-5 overflow-y-auto pr-1">
            <p className="text-sm text-muted-foreground">{t('nothingDeleted')}</p>
            {over.length === 0 && <p className="text-sm text-foreground" data-testid="downgrade-fits">{t('withinLimits', { plan: view.plan.name })}</p>}
            {over.map((k) => {
              const chosen = keep[k.kind] ?? [];
              const limit = k.limit as number;
              return (
                <fieldset key={k.kind} className="space-y-2" data-testid={`downgrade-${k.kind}`}>
                  <legend className="text-sm font-medium text-foreground">
                    {t(`kinds.${k.kind}`)} · {t('pick', { limit, count: chosen.length })}
                  </legend>
                  <ul className="space-y-1.5">
                    {k.items.map((item) => {
                      const checked = chosen.includes(item.id);
                      return (
                        <li key={item.id} className="flex items-center gap-2 text-sm">
                          <Checkbox id={`keep-${item.id}`} checked={checked} disabled={!checked && chosen.length >= limit}
                            onCheckedChange={(on) => toggle(k.kind, item.id, limit, on === true)} />
                          <label htmlFor={`keep-${item.id}`} className="min-w-0 flex-1 truncate text-foreground">{item.name}</label>
                          <span className="shrink-0 text-xs text-muted-foreground">
                            {item.lastUsedAt ? t('lastUsed', { date: date(item.lastUsedAt) }) : t('neverUsed')}
                          </span>
                        </li>
                      );
                    })}
                  </ul>
                </fieldset>
              );
            })}
            {view.archived.length > 0 && (
              <div className="space-y-1">
                <p className="text-sm font-medium text-foreground">{t('archivedTitle')}</p>
                <ul className="space-y-0.5 text-xs text-muted-foreground">
                  {view.archived.map((a) => <li key={`${a.kind}-${a.id}`}>{t(`kinds.${a.kind}`)}: {a.name}</li>)}
                </ul>
                <p className="text-xs text-muted-foreground">{t('archivedHint')}</p>
              </div>
            )}
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>{t('cancel')}</Button>
          <Button onClick={() => void save()} disabled={saving || !view || view === 'failed' || over.length === 0}>
            {saving && <Loader2 className="mr-1 size-3.5 animate-spin" />}
            {t('save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
