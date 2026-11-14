'use client';

// Ads → Rules: automated rules checked every hour against the stored results,
// e.g. "Pause any ad set whose cost per result is above 200 over the last 3
// days, once it has spent 500". Every member sees the rules and what they did;
// admins create, switch and delete them. Pausing needs ad management.

import { useCallback, useEffect, useState } from 'react';
import { Loader2, Plus, Trash2, Zap } from 'lucide-react';
import { toast } from 'sonner';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { authFetch } from '@/lib/auth/client';
import { cn } from '@/lib/utils';
import type { AdRuleActionDto, AdRuleDto } from '@/lib/meta-ads/rules';

const SELECT = 'h-9 w-full rounded-lg border border-border bg-card px-2.5 text-sm';
const LEVELS = ['campaign', 'adset', 'ad'] as const;
const METRICS = ['cost_per_result', 'spend', 'ctr', 'cpm'] as const;
const WINDOWS = [1, 3, 7] as const;

async function post(body: Record<string, unknown>) {
  const res = await authFetch('/api/meta-ads/rules', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const payload = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error('failed'), { code: typeof payload.error === 'string' ? payload.error : undefined });
  return payload as { rule?: AdRuleDto };
}

export function RulesPanel({ canManage, canPause }: { canManage: boolean; canPause: boolean }) {
  const t = useTranslations('Ads.rules');
  const [data, setData] = useState<{ rules: AdRuleDto[]; actions: AdRuleActionDto[] } | null>(null);
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await authFetch('/api/meta-ads/rules', { cache: 'no-store' });
      setData(res.ok ? await res.json() : { rules: [], actions: [] });
    } catch {
      setData((d) => d ?? { rules: [], actions: [] });
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const sentence = (r: AdRuleDto) => t('sentence', {
    action: t(`actions.${r.action}`), level: t(`levels.${r.level}`), metric: t(`metrics.${r.metric}`), operator: t(`operators.${r.operator}`),
    threshold: r.metric === 'ctr' ? `${r.threshold}%` : String(r.threshold), days: r.windowDays,
  }) + (r.minSpend > 0 ? ` ${t('minSpendSentence', { amount: String(r.minSpend) })}` : '');

  const toggle = async (rule: AdRuleDto, enabled: boolean) => {
    setBusy(rule.id);
    try {
      const { rule: next } = await post({ action: 'enable', id: rule.id, enabled });
      if (next) setData((d) => d && { ...d, rules: d.rules.map((r) => (r.id === next.id ? next : r)) });
    } catch {
      toast.error(t('failed'));
    } finally {
      setBusy(null);
    }
  };
  const remove = async (rule: AdRuleDto) => {
    setBusy(rule.id);
    try {
      await post({ action: 'delete', id: rule.id });
      setData((d) => d && { ...d, rules: d.rules.filter((r) => r.id !== rule.id) });
    } catch {
      toast.error(t('failed'));
    } finally {
      setBusy(null);
    }
  };

  return (
    <section aria-labelledby="ad-rules-title" className="space-y-3" data-testid="ads-rules">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 id="ad-rules-title" className="text-sm font-semibold text-foreground">{t('title')}</h2>
          <p className="text-xs text-muted-foreground">{t('description')}</p>
        </div>
        {canManage && (
          <Button type="button" size="sm" onClick={() => setCreating(true)} data-testid="new-rule"><Plus className="size-4" /> {t('new')}</Button>
        )}
      </div>
      {data === null ? (
        <div className="flex justify-center py-10"><Loader2 className="size-5 animate-spin text-muted-foreground" /></div>
      ) : data.rules.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border px-4 py-10 text-center">
          <Zap className="mx-auto size-6 text-muted-foreground" aria-hidden />
          <p className="mt-2 text-sm font-medium text-foreground">{t('emptyTitle')}</p>
          <p className="mx-auto mt-1 max-w-md text-xs text-muted-foreground">{t('emptyBody')}</p>
        </div>
      ) : (
        <ul className="divide-y divide-border/70 rounded-xl border border-border bg-card">
          {data.rules.map((r) => (
            <li key={r.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
              <div className="min-w-0 flex-1 basis-64">
                <p className="truncate text-sm font-medium text-foreground">{r.name}</p>
                <p className="text-xs text-muted-foreground">{sentence(r)}</p>
                {r.lastRunAt && <p className="text-xs text-muted-foreground">{t('lastChecked', { at: new Date(r.lastRunAt).toLocaleString() })}</p>}
              </div>
              {canManage ? (
                <>
                  <Switch checked={r.enabled} disabled={busy === r.id || (r.action === 'pause' && !canPause && !r.enabled)}
                    aria-label={t('enabled', { name: r.name })} onCheckedChange={(next) => void toggle(r, next)} />
                  <Button type="button" size="icon" variant="ghost" disabled={busy === r.id} aria-label={t('delete', { name: r.name })}
                    onClick={() => void remove(r)}><Trash2 className="size-4" /></Button>
                </>
              ) : (
                <span className="text-xs text-muted-foreground">{r.enabled ? t('on') : t('off')}</span>
              )}
            </li>
          ))}
        </ul>
      )}
      {data && data.actions.length > 0 && (
        <div className="rounded-xl border border-border bg-card p-4">
          <h3 className="text-sm font-semibold text-foreground">{t('recent')}</h3>
          <ul className="mt-2 space-y-1.5">
            {data.actions.map((a) => {
              const rule = data.rules.find((r) => r.id === a.ruleId);
              return (
                <li key={a.id} className="flex flex-wrap items-center justify-between gap-2 text-xs">
                  <span className="min-w-0 truncate text-foreground">{a.objectName ?? a.objectId}{rule ? ` · ${rule.name}` : ''}</span>
                  <span className={cn('rounded-full px-2 py-0.5 font-medium',
                    a.outcome === 'queued' ? 'bg-amber-500/10 text-amber-700 dark:text-amber-300'
                      : a.outcome === 'skipped' ? 'bg-muted text-muted-foreground' : 'bg-primary/10 text-primary')}>
                    {t(`outcomes.${a.outcome}`)} · {new Date(a.createdAt).toLocaleString()}
                  </span>
                </li>
              );
            })}
          </ul>
        </div>
      )}
      <p className="text-xs text-muted-foreground">{t('help')}</p>
      {creating && (
        <NewRuleDialog canPause={canPause} onClose={() => setCreating(false)}
          onCreated={(rule) => { setData((d) => d && { ...d, rules: [rule, ...d.rules] }); setCreating(false); }} />
      )}
    </section>
  );
}

function NewRuleDialog({ canPause, onClose, onCreated }: { canPause: boolean; onClose: () => void; onCreated: (rule: AdRuleDto) => void }) {
  const t = useTranslations('Ads.rules');
  const [name, setName] = useState('');
  const [ruleAction, setRuleAction] = useState<'pause' | 'notify'>(canPause ? 'pause' : 'notify');
  const [level, setLevel] = useState<(typeof LEVELS)[number]>('adset');
  const [metric, setMetric] = useState<(typeof METRICS)[number]>('cost_per_result');
  const [operator, setOperator] = useState<'gt' | 'lt'>('gt');
  const [threshold, setThreshold] = useState('');
  const [windowDays, setWindowDays] = useState<number>(3);
  const [minSpend, setMinSpend] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const value = Number(threshold);
  const min = minSpend.trim() ? Number(minSpend) : 0;
  const valid = name.trim().length > 0 && threshold.trim() !== '' && Number.isFinite(value) && value >= 0 && Number.isFinite(min) && min >= 0
    && (metric !== 'ctr' || value <= 100);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const { rule } = await post({ action: 'create', name: name.trim(), ruleAction, level, metric, operator, threshold: value, windowDays, minSpend: min });
      toast.success(t('created'));
      onCreated(rule!);
    } catch (e) {
      const code = (e as { code?: string }).code;
      setError(code === 'limit_reached' ? t('limitReached') : code === 'manage_not_enabled' ? t('pauseNeedsManage') : t('failed'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={(next) => { if (!next && !busy) onClose(); }}>
      <DialogContent className="sm:max-w-lg" data-testid="new-rule-dialog">
        <DialogHeader>
          <DialogTitle>{t('newTitle')}</DialogTitle>
          <DialogDescription>{t('newDescription')}</DialogDescription>
        </DialogHeader>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1 sm:col-span-2">
            <Label htmlFor="rule-name">{t('name')}</Label>
            <Input id="rule-name" value={name} maxLength={120} onChange={(e) => setName(e.target.value)} placeholder={t('namePlaceholder')} />
          </div>
          <div className="space-y-1">
            <Label htmlFor="rule-action">{t('then')}</Label>
            <select id="rule-action" value={ruleAction} onChange={(e) => setRuleAction(e.target.value as 'pause' | 'notify')} className={SELECT}>
              <option value="pause" disabled={!canPause}>{t('actions.pause')}</option>
              <option value="notify">{t('actions.notify')}</option>
            </select>
          </div>
          <div className="space-y-1">
            <Label htmlFor="rule-level">{t('anyActive')}</Label>
            <select id="rule-level" value={level} onChange={(e) => setLevel(e.target.value as typeof level)} className={SELECT}>
              {LEVELS.map((l) => <option key={l} value={l}>{t(`levels.${l}`)}</option>)}
            </select>
          </div>
          <div className="space-y-1">
            <Label htmlFor="rule-metric">{t('when')}</Label>
            <select id="rule-metric" value={metric} onChange={(e) => setMetric(e.target.value as typeof metric)} className={SELECT}>
              {METRICS.map((m) => <option key={m} value={m}>{t(`metrics.${m}`)}</option>)}
            </select>
          </div>
          <div className="grid grid-cols-[6rem_1fr] gap-2">
            <div className="space-y-1">
              <Label htmlFor="rule-operator">{t('is')}</Label>
              <select id="rule-operator" value={operator} onChange={(e) => setOperator(e.target.value as 'gt' | 'lt')} className={SELECT}>
                <option value="gt">{t('operators.gt')}</option>
                <option value="lt">{t('operators.lt')}</option>
              </select>
            </div>
            <div className="space-y-1">
              <Label htmlFor="rule-threshold">{metric === 'ctr' ? t('percent') : t('amount')}</Label>
              <Input id="rule-threshold" inputMode="decimal" value={threshold} onChange={(e) => setThreshold(e.target.value)} placeholder={metric === 'ctr' ? '0.8' : '200'} />
            </div>
          </div>
          <div className="space-y-1">
            <Label htmlFor="rule-window">{t('over')}</Label>
            <select id="rule-window" value={windowDays} onChange={(e) => setWindowDays(Number(e.target.value))} className={SELECT}>
              {WINDOWS.map((w) => <option key={w} value={w}>{t('days', { days: w })}</option>)}
            </select>
          </div>
          <div className="space-y-1">
            <Label htmlFor="rule-min">{t('minSpend')}</Label>
            <Input id="rule-min" inputMode="decimal" value={minSpend} onChange={(e) => setMinSpend(e.target.value)} placeholder="0" />
          </div>
        </div>
        <p className="text-xs text-muted-foreground">{t('currencyHelp')}</p>
        {error && <p className="text-sm text-destructive" role="alert">{error}</p>}
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose} disabled={busy}>{t('cancel')}</Button>
          <Button type="button" onClick={() => void submit()} disabled={!valid || busy}>{busy && <Loader2 className="size-4 animate-spin" />} {t('create')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
