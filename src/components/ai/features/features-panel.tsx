'use client';

// AI page, Assistant features tab (admins with 'ai.settings'): the feature
// switches (suggested replies, summaries, lead scoring, auto-labelling,
// translation with the team language, route to staff, business insights),
// the monthly token budget card (used of limit, state, reset date, limit
// presets, "pause the AI when the budget is used up") and where this month's
// tokens went. Saves through PUT /api/ai/settings; reads GET /api/ai/budget.
// The Instagram goals editor stays below when the workspace uses Instagram.

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useFormatter, useTranslations } from 'next-intl';
import { toast } from 'sonner';
import {
  BarChart3, FileText, Globe, Loader2, MessageSquare, Pencil, ShieldCheck, Star, Tag,
} from 'lucide-react';
import { authFetch } from '@/lib/auth/client';
import { useWorkspaceChannels } from '@/hooks/use-workspace-channels';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { InstagramGoalsEditor } from '@/components/settings/ai-assistant-settings';
import type { AiGoal } from '@/lib/flows/types';
import { cn } from '@/lib/utils';
import { FEATURES, LIMIT_PRESETS, parseLimit, TEAM_LANGUAGES, usedPct, type FeatureKey, type SettingKey } from './features-view';

interface SettingsView {
  settings: Record<SettingKey, boolean> & {
    monthly_token_cap: number | null; pause_at_cap: boolean; translation_language: string; instagram_goals?: AiGoal[];
  };
  deployment_enabled: boolean;
  configured: boolean;
}

interface BudgetView {
  used: number; cap: number | null; plan_limit: number | null; limit: number | null; pause_at_cap: boolean;
  resets_at: string; by_mode: { mode: string; tokens: number }[]; state: 'ok' | 'warn' | 'over' | 'none';
}

const ICONS: Record<FeatureKey, typeof Tag> = {
  suggest: MessageSquare, summary: FileText, assess: Star, label: Tag, translate: Globe, route: ShieldCheck, insights: BarChart3,
};
/** Usage modes that belong to a feature switch (for the "off" note in Where tokens went). */
const MODE_SETTING: Record<string, SettingKey> = {
  suggest: 'suggestions_enabled', summary: 'summaries_enabled', assess: 'assessment_enabled', insights: 'insights_enabled',
  label: 'labelling_enabled', translate: 'translation_enabled',
};
const NO_GOALS: AiGoal[] = [];

export function FeaturesPanel() {
  const t = useTranslations('AiStudio');
  const ts = useTranslations('AiSettings');
  const format = useFormatter();
  const [view, setView] = useState<SettingsView | null>(null);
  const [budget, setBudget] = useState<BudgetView | null>(null);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [editingLimit, setEditingLimit] = useState(false);
  const [limitText, setLimitText] = useState('');
  const [limitError, setLimitError] = useState<string | null>(null);
  const channels = useWorkspaceChannels();
  const instagram = channels.data?.enabled.includes('instagram') === true;

  const loadBudget = useCallback(async () => {
    try {
      const res = await authFetch('/api/ai/budget', { cache: 'no-store' });
      if (res.ok) setBudget(await res.json());
    } catch { /* the card shows its loading state */ }
  }, []);
  const load = useCallback(async () => {
    setFailed(false);
    try {
      const res = await authFetch('/api/ai/settings', { cache: 'no-store' });
      if (!res.ok) throw new Error();
      setView(await res.json());
      void loadBudget();
    } catch {
      setFailed(true);
    }
  }, [loadBudget]);
  useEffect(() => { void load(); }, [load]);

  const save = async (patch: Record<string, unknown>, message?: string): Promise<boolean> => {
    setBusy(true);
    try {
      const res = await authFetch('/api/ai/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch) });
      if (!res.ok) throw new Error();
      setView(await res.json());
      if (message) toast.success(message);
      void loadBudget();
      return true;
    } catch {
      toast.error(t('common.failed'));
      return false;
    } finally {
      setBusy(false);
    }
  };

  const saveLimit = async (raw: string) => {
    const parsed = parseLimit(raw);
    if (!parsed.ok) { setLimitError(t(`budget.errors.${parsed.error}`)); return; }
    setLimitError(null);
    if (await save({ monthly_token_cap: parsed.value }, t('budget.saved', { n: format.number(parsed.value) }))) setEditingLimit(false);
  };

  if (failed) {
    return (
      <div className="flex flex-wrap items-center gap-3 rounded-xl border border-border bg-card p-4 text-sm">
        <p className="text-destructive">{t('common.loadFailed')}</p>
        <Button type="button" size="sm" variant="outline" onClick={() => void load()}>{t('common.retry')}</Button>
      </div>
    );
  }
  if (!view) return <div className="flex justify-center py-10"><Loader2 className="size-5 animate-spin text-muted-foreground" aria-label={t('common.loading')} /></div>;

  const s = view.settings;
  const onCount = FEATURES.filter((f) => s[f.setting]).length;
  const pct = budget ? usedPct(budget.used, budget.limit) : 0;
  const stateTone = { ok: 'secondary', warn: 'outline', over: 'destructive', none: 'outline' } as const;
  const usageTotal = budget ? Math.max(1, budget.by_mode.reduce((n, r) => n + r.tokens, 0)) : 1;

  return (
    <div className="min-w-0 space-y-4">
      {(!view.deployment_enabled || !view.configured) && (
        <p role="status" className="rounded-lg bg-amber-500/10 px-3 py-2 text-[13px] text-amber-800 dark:text-amber-200">
          {!view.deployment_enabled ? ts('status.deploymentOff') : ts('status.notConfigured')}
        </p>
      )}
      <div className="grid grid-cols-1 gap-3.5 lg:grid-cols-[minmax(0,1.6fr)_minmax(280px,1fr)] lg:items-start">
        <section className="min-w-0 rounded-xl border border-border bg-card p-4 pb-1" aria-labelledby="ai-features-title">
          <div className="flex items-start justify-between gap-3 pb-3.5">
            <div className="min-w-0">
              <h2 id="ai-features-title" className="text-base font-semibold">{t('features.title')}</h2>
              <p className="mt-1 text-[13px] text-muted-foreground">{t('features.body')}</p>
            </div>
            <Badge variant={onCount ? 'secondary' : 'outline'} className="shrink-0 rounded-full">{t('features.onCount', { on: onCount, total: FEATURES.length })}</Badge>
          </div>
          {FEATURES.map(({ key, setting }) => {
            const Icon = ICONS[key];
            const name = t(`features.items.${key}.name`);
            return (
              <div key={key} className="flex items-start gap-3 border-t border-border py-3.5">
                <span className="flex size-9 shrink-0 items-center justify-center rounded-[11px] bg-muted text-muted-foreground"><Icon className="size-4" aria-hidden /></span>
                <div className="min-w-0 flex-1">
                  <strong className="block text-sm font-semibold" id={`feature-${key}`}>{name}</strong>
                  <p className="mt-0.5 text-[13px] text-muted-foreground">{t(`features.items.${key}.desc`)}</p>
                  {key === 'translate' && s.translation_enabled && (
                    <label className="mt-2.5 flex flex-wrap items-center gap-2 text-[13px] font-medium text-muted-foreground">
                      {t('features.teamLanguage')}
                      <select value={s.translation_language} disabled={busy}
                        className="h-8 min-w-[130px] rounded-lg border border-border bg-card px-2 text-[13px] text-foreground outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30"
                        onChange={(e) => void save({ translation_language: e.target.value }, t('features.languageSaved', { language: t(`languages.${e.target.value}`) }))}>
                        {TEAM_LANGUAGES.map((l) => <option key={l} value={l}>{t(`languages.${l}`)}</option>)}
                      </select>
                    </label>
                  )}
                </div>
                <Switch className="mt-1.5" checked={s[setting]} disabled={busy} aria-labelledby={`feature-${key}`}
                  onCheckedChange={(v: boolean) => void save({ [setting]: v }, t(v ? 'features.turnedOn' : 'features.turnedOff', { name }))} />
              </div>
            );
          })}
        </section>

        <div className="flex min-w-0 flex-col gap-3.5">
          <section className="flex flex-col gap-3 rounded-xl border border-border bg-card p-4" aria-labelledby="ai-budget-title">
            <div className="flex items-center justify-between gap-3">
              <h2 id="ai-budget-title" className="text-base font-semibold">{t('budget.title')}</h2>
              {budget && <Badge variant={stateTone[budget.state]} className={cn('rounded-full', budget.state === 'warn' && 'border-amber-500/40 text-amber-800 dark:text-amber-200')}>{t(`budget.states.${budget.state}`)}</Badge>}
            </div>
            {!budget ? <Loader2 className="size-4 animate-spin text-muted-foreground" aria-label={t('common.loading')} /> : (
              <>
                <p className="tabular-nums">
                  <strong className="text-[26px] font-bold tracking-tight">{format.number(budget.used)}</strong>{' '}
                  <span className="text-sm text-muted-foreground">{budget.limit === null ? t('budget.usedNoLimit') : t('budget.ofLimit', { limit: format.number(budget.limit) })}</span>
                </p>
                {budget.limit !== null && (
                  <div className="h-2.5 overflow-hidden rounded-full bg-muted" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.min(100, pct)} aria-label={t('budget.barLabel')}>
                    <i className={cn('block h-full rounded-full transition-[width] duration-300', pct >= 100 ? 'bg-destructive' : pct >= 80 ? 'bg-amber-500' : 'bg-primary')}
                      style={{ width: `${Math.min(100, pct)}%` }} />
                  </div>
                )}
                <div className="flex flex-wrap justify-between gap-2 text-xs text-muted-foreground">
                  {budget.limit !== null && <span className="tabular-nums">{t('budget.pct', { n: pct })}</span>}
                  <span>{t('budget.resets', { date: format.dateTime(new Date(budget.resets_at), { day: 'numeric', month: 'short' }) })}</span>
                </div>
                {budget.state === 'over' && (
                  <p className="rounded-lg bg-amber-500/10 px-3 py-2 text-[13px] text-amber-800 dark:text-amber-200">
                    {budget.cap !== null && !s.pause_at_cap && (budget.plan_limit === null || budget.used < budget.plan_limit) ? t('budget.overNote') : t('budget.pausedNote')}
                  </p>
                )}
                {budget.plan_limit !== null && <p className="text-xs text-muted-foreground">{t('budget.planLimit', { n: format.number(budget.plan_limit) })}</p>}
                {editingLimit ? (
                  <form className="flex flex-col gap-2.5 rounded-xl bg-muted p-3" noValidate onSubmit={(e) => { e.preventDefault(); void saveLimit(limitText); }}>
                    <div className="space-y-1">
                      <Label htmlFor="ai-limit">{t('budget.limitLabel')}</Label>
                      <Input id="ai-limit" inputMode="numeric" value={limitText} autoFocus aria-invalid={limitError ? true : undefined}
                        onChange={(e) => setLimitText(e.target.value)} />
                      {limitError && <p className="text-xs font-medium text-destructive" role="alert">{limitError}</p>}
                    </div>
                    <div className="flex flex-wrap gap-1.5">
                      {LIMIT_PRESETS.map((n) => (
                        <button key={n} type="button" onClick={() => setLimitText(String(n))}
                          className="h-7 rounded-full border border-border bg-card px-3 text-xs text-muted-foreground transition-colors duration-150 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50">
                          {t('budget.preset', { n: n / 1_000_000 })}
                        </button>
                      ))}
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <Button type="submit" size="sm" disabled={busy}>{t('budget.saveLimit')}</Button>
                      {s.monthly_token_cap !== null && (
                        <Button type="button" size="sm" variant="outline" disabled={busy}
                          onClick={async () => { if (await save({ monthly_token_cap: null }, t('budget.removed'))) setEditingLimit(false); }}>{t('budget.removeLimit')}</Button>
                      )}
                      <Button type="button" size="sm" variant="ghost" onClick={() => { setEditingLimit(false); setLimitError(null); }}>{t('common.cancel')}</Button>
                    </div>
                  </form>
                ) : (
                  <div>
                    <Button type="button" size="sm" variant="outline" onClick={() => { setLimitText(s.monthly_token_cap ? String(s.monthly_token_cap) : ''); setEditingLimit(true); }}>
                      <Pencil aria-hidden />{s.monthly_token_cap === null ? t('budget.setLimit') : t('budget.change')}
                    </Button>
                  </div>
                )}
                <div className="flex items-start justify-between gap-3 border-t border-border pt-3">
                  <span className="min-w-0 text-[13px]">
                    <strong className="block font-semibold" id="ai-pause-label">{t('budget.pause')}</strong>
                    <small className="block text-xs text-muted-foreground">{t('budget.pauseHint')}</small>
                  </span>
                  <Switch checked={s.pause_at_cap} disabled={busy} aria-labelledby="ai-pause-label"
                    onCheckedChange={(v: boolean) => void save({ pause_at_cap: v }, t(v ? 'budget.pauseOn' : 'budget.pauseOff'))} />
                </div>
                <small className="text-xs text-muted-foreground">{t('budget.tokensNote')}</small>
              </>
            )}
          </section>

          <section className="rounded-xl border border-border bg-card p-4" aria-labelledby="ai-usage-title">
            <h2 id="ai-usage-title" className="text-base font-semibold">{t('usage.title')}</h2>
            {!budget ? null : budget.by_mode.length === 0 ? (
              <p className="mt-3 text-[13px] text-muted-foreground">{t('usage.empty')}</p>
            ) : (
              <div className="mt-3.5 flex flex-col gap-2.5">
                {budget.by_mode.map((r) => {
                  const setting = MODE_SETTING[r.mode];
                  return (
                    <div key={r.mode} className="grid grid-cols-[minmax(0,1.3fr)_minmax(30px,1fr)_76px] items-center gap-2.5 text-[13px]">
                      <span className="min-w-0 truncate">{t(`usage.modes.${r.mode}`)}{setting && !s[setting] && <small className="text-muted-foreground"> {t('usage.off')}</small>}</span>
                      <div className="h-1.5 overflow-hidden rounded-full bg-muted" aria-hidden>
                        <i className="block h-full rounded-full bg-primary" style={{ width: `${Math.round((r.tokens / usageTotal) * 100)}%` }} />
                      </div>
                      <span className="text-right text-muted-foreground tabular-nums">{format.number(r.tokens)}</span>
                    </div>
                  );
                })}
              </div>
            )}
          </section>
        </div>
      </div>

      {instagram && (
        <section className="rounded-xl border border-border bg-card p-4">
          <InstagramGoalsEditor initial={s.instagram_goals ?? NO_GOALS} busy={busy}
            onSave={(goals) => save({ instagram_goals: goals })} />
        </section>
      )}
      <p className="text-xs text-muted-foreground">
        {ts('staffReviewNote')} {ts('autonomousNote')}{' '}
        <Link href="/agents?tab=setup" className="text-primary underline-offset-2 hover:underline">{t('features.setupLink')}</Link>
      </p>
    </div>
  );
}
