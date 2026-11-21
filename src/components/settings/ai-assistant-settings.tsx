'use client';

/**
 * Settings -> AI assistant (Phase 13): the workspace switches for
 * summaries, suggested replies, intent/lead assessment and business
 * insights, plus an optional monthly token cap. Admins with 'ai.settings'
 * only (GET/PUT /api/ai/settings). Every feature is off until turned on
 * here, and still needs the deployment switch and a configured key, which
 * the status line explains. Saving a switch calls no AI provider.
 *
 * Stage 5 (5G): when the workspace uses Instagram, the "Goals for Instagram
 * replies" editor sets up to 3 ordered goals for the Instagram AI auto-reply
 * (share a link, grow followers, capture a lead). Saved with the same PUT.
 */

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { ArrowDown, ArrowUp, Loader2, Plus, Sparkles, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { useTranslations } from 'next-intl';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { InlineError } from '@/components/ui/inline-error';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Checkbox } from '@/components/ui/checkbox';
import { SegmentedControl } from '@/components/ui/segmented-control';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { authFetch } from '@/lib/auth/client';
import { useWorkspaceChannels } from '@/hooks/use-workspace-channels';
import { AUTO_REPLY_LEAD_FIELDS, autoReplyGoalsProblem } from '@/lib/ai/goal-rules';
import { AI_GOAL_LIMITS, AI_GOAL_TYPES, type AiGoal, type AiGoalType } from '@/lib/flows/types';
import { GroupedListRow } from '@/components/ui/grouped-list';
import { cn } from '@/lib/utils';
import { SETTINGS_ROW_HAIRLINE, SettingsBlock, SettingsGroup, SettingsRow, SettingsSwitchRow } from './settings-row';

export type AiToggle = 'summaries_enabled' | 'suggestions_enabled' | 'assessment_enabled' | 'insights_enabled';

export interface AiSettingsView {
  settings: Record<AiToggle, boolean> & { monthly_token_cap: number | null; updated_at: string | null; instagram_goals?: AiGoal[] };
  deployment_enabled: boolean;
  configured: boolean;
}

/** Each switch with its AiSettings.features label key. */
export const AI_TOGGLES: { key: AiToggle; feature: 'summary' | 'suggest' | 'assess' | 'insights' }[] = [
  { key: 'summaries_enabled', feature: 'summary' },
  { key: 'suggestions_enabled', feature: 'suggest' },
  { key: 'assessment_enabled', feature: 'assess' },
  { key: 'insights_enabled', feature: 'insights' },
];

/** The cap typed in the box: null for empty, a positive whole number, or 'invalid'. */
export function parseCapInput(raw: string): number | null | 'invalid' {
  const text = raw.trim().replace(/[,\s_]/g, '');
  if (!text) return null;
  if (!/^\d+$/.test(text)) return 'invalid';
  const n = Number(text);
  return Number.isSafeInteger(n) && n > 0 && n <= 1_000_000_000_000 ? n : 'invalid';
}

/** Which status line applies: the deployment switch first, then the key. */
export function aiStatus(view: Pick<AiSettingsView, 'deployment_enabled' | 'configured'>): 'deploymentOff' | 'notConfigured' | 'ready' {
  if (!view.deployment_enabled) return 'deploymentOff';
  if (!view.configured) return 'notConfigured';
  return 'ready';
}

/** A new goal of the given type with empty fields (the form fills them in). */
export function blankGoal(type: AiGoalType): AiGoal {
  if (type === 'share_link') return { type, url: '' };
  if (type === 'grow_followers') return { type };
  return { type, fields: ['email'], on_refusal: 'continue' };
}

/** The goal types not used yet (each type once). */
export function unusedGoalTypes(goals: readonly AiGoal[]): AiGoalType[] {
  return AI_GOAL_TYPES.filter((type) => !goals.some((g) => g.type === type));
}

/** Moves the goal at `from` by `delta` places; an out-of-range move returns the list unchanged. */
export function moveGoal(goals: readonly AiGoal[], from: number, delta: -1 | 1): AiGoal[] {
  const to = from + delta;
  if (from < 0 || from >= goals.length || to < 0 || to >= goals.length) return [...goals];
  const next = [...goals];
  [next[from], next[to]] = [next[to], next[from]];
  return next;
}

const NO_GOALS: AiGoal[] = [];

/** The Instagram goals editor (Settings -> AI assistant). */
export function InstagramGoalsEditor({ initial, busy, onSave }: {
  initial: AiGoal[]; busy: boolean; onSave: (goals: AiGoal[]) => Promise<boolean>;
}) {
  const tg = useTranslations('AiSettings.instagramGoals');
  const [goals, setGoals] = useState<AiGoal[]>(initial);
  // Reset the draft only when the saved goals change, not on every other settings save.
  const initialJson = JSON.stringify(initial);
  const [syncedJson, setSyncedJson] = useState(initialJson);
  if (syncedJson !== initialJson) {
    setSyncedJson(initialJson);
    setGoals(initial);
  }
  const update = (index: number, goal: AiGoal) => setGoals((list) => list.map((g, i) => (i === index ? goal : g)));
  const unused = unusedGoalTypes(goals);
  const dirty = JSON.stringify(goals) !== initialJson;

  const save = async () => {
    const cleaned = goals.map((g): AiGoal => g.type === 'share_link'
      ? { type: 'share_link', url: g.url.trim(), ...(g.label?.trim() ? { label: g.label.trim() } : {}) }
      : g);
    if (autoReplyGoalsProblem(cleaned) !== null) {
      toast.error(tg('invalid'));
      return;
    }
    if (await onSave(cleaned)) toast.success(tg('saved'));
  };

  return (
    <SettingsGroup
      title={<span id="ai-instagram-goals-title">{tg('title')}</span>}
      footer={<>{tg('description')} {tg('onlyInstagram')}</>}
      action={
        <Button type="button" size="sm" className="min-h-11 sm:min-h-8" disabled={busy || !dirty} onClick={() => void save()}>
          {busy && <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />}
          {tg('save')}
        </Button>
      }
    >
      {goals.length === 0 && (
        <div className={cn(SETTINGS_ROW_HAIRLINE, 'flex min-h-11 items-center px-4 py-3 text-sm text-muted-foreground')}>{tg('empty')}</div>
      )}
      {goals.map((goal, index) => {
        const id = `ai-goal-${index}`;
        return (
          <div key={goal.type} role="group" aria-label={tg('goalLabel', { n: index + 1 })} className={SETTINGS_ROW_HAIRLINE}>
            <div className="flex min-h-11 flex-wrap items-center gap-2 px-4 pt-3 pb-1">
              <span className="text-sm font-semibold">{tg('goalLabel', { n: index + 1 })}</span>
              <label className="sr-only" htmlFor={`${id}-type`}>{tg('type')}</label>
              <Select value={goal.type} disabled={busy}
                onValueChange={(v) => { if (v) update(index, blankGoal(v as AiGoalType)); }}>
                <SelectTrigger id={`${id}-type`} className="min-h-11 sm:min-h-8">
                  <SelectValue>{(v: string) => tg(`types.${v as AiGoalType}`)}</SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {[goal.type, ...unused].map((type) => <SelectItem key={type} value={type}>{tg(`types.${type}`)}</SelectItem>)}
                </SelectContent>
              </Select>
              <span className="ml-auto flex gap-1">
                <Button type="button" size="icon" variant="ghost" className="size-11 sm:size-9" aria-label={tg('moveUp')} disabled={busy || index === 0}
                  onClick={() => setGoals((list) => moveGoal(list, index, -1))}><ArrowUp className="size-4" aria-hidden="true" /></Button>
                <Button type="button" size="icon" variant="ghost" className="size-11 sm:size-9" aria-label={tg('moveDown')} disabled={busy || index === goals.length - 1}
                  onClick={() => setGoals((list) => moveGoal(list, index, 1))}><ArrowDown className="size-4" aria-hidden="true" /></Button>
                <Button type="button" size="icon" variant="ghost" className="size-11 text-destructive hover:text-destructive sm:size-9" aria-label={tg('remove')} disabled={busy}
                  onClick={() => setGoals((list) => list.filter((_, i) => i !== index))}><Trash2 className="size-4" aria-hidden="true" /></Button>
              </span>
              <p className="text-muted-foreground w-full text-xs">{tg(`typeHelp.${goal.type}`)}</p>
            </div>
            {goal.type === 'share_link' && (
              <>
                <SettingsRow label={tg('url')} htmlFor={`${id}-url`}>
                  <Input id={`${id}-url`} type="url" inputMode="url" value={goal.url} maxLength={2048} disabled={busy}
                    placeholder="https://" onChange={(e) => update(index, { ...goal, url: e.target.value })} />
                </SettingsRow>
                <SettingsRow label={tg('linkLabel')} htmlFor={`${id}-label`}>
                  <Input id={`${id}-label`} value={goal.label ?? ''} maxLength={80} disabled={busy}
                    onChange={(e) => update(index, { ...goal, label: e.target.value })} />
                </SettingsRow>
              </>
            )}
            {goal.type === 'capture_lead' && (
              <>
                <SettingsRow label={tg('fields')}>
                  <div role="group" aria-label={tg('fields')} className="flex flex-wrap gap-x-4 gap-y-1 sm:justify-end">
                    {AUTO_REPLY_LEAD_FIELDS.map((field) => (
                      <label key={field} className="flex min-h-11 items-center gap-2 text-sm sm:min-h-8">
                        <Checkbox checked={goal.fields.includes(field)} disabled={busy}
                          onCheckedChange={(checked: boolean) => update(index, {
                            ...goal,
                            fields: checked
                              ? [...goal.fields.filter((f) => f !== field), field].slice(0, AI_GOAL_LIMITS.leadFields)
                              : goal.fields.filter((f) => f !== field),
                          })} />
                        {tg(`fieldNames.${field}`)}
                      </label>
                    ))}
                  </div>
                </SettingsRow>
                <SettingsRow label={tg('onRefusal')}>
                  <SegmentedControl aria-label={tg('onRefusal')} value={goal.on_refusal}
                    onValueChange={(v) => { if (!busy) update(index, { ...goal, on_refusal: v }); }}
                    options={[
                      { value: 'continue', label: tg('refusalContinue'), disabled: busy },
                      { value: 'handoff', label: tg('refusalHandoff'), disabled: busy },
                    ]} />
                </SettingsRow>
              </>
            )}
          </div>
        );
      })}
      {goals.length < AI_GOAL_LIMITS.goals && unused.length > 0 && (
        <GroupedListRow
          leading={<Plus className="size-4 text-primary" aria-hidden="true" />}
          title={<span className="text-primary">{tg('add')}</span>}
          onClick={busy ? undefined : () => setGoals((list) => [...list, blankGoal(unused[0])])}
        />
      )}
    </SettingsGroup>
  );
}

export function AiAssistantSettings() {
  const t = useTranslations('AiAssistantSettings');
  const ts = useTranslations('AiSettings');
  const [view, setView] = useState<AiSettingsView | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [cap, setCap] = useState('');
  const channels = useWorkspaceChannels();
  const instagram = channels.data?.enabled.includes('instagram') === true;

  const apply = useCallback((next: AiSettingsView) => {
    setView(next);
    setCap(next.settings.monthly_token_cap === null ? '' : String(next.settings.monthly_token_cap));
  }, []);

  const load = useCallback(async () => {
    setLoadFailed(false);
    try {
      const res = await authFetch('/api/ai/settings', { cache: 'no-store' });
      if (!res.ok) throw new Error();
      apply(await res.json());
    } catch {
      setLoadFailed(true);
    }
  }, [apply]);

  useEffect(() => { void load(); }, [load]);

  const save = async (patch: Partial<Record<AiToggle, boolean>> & { monthly_token_cap?: number | null; instagram_goals?: AiGoal[] },
    quiet = false): Promise<boolean> => {
    setBusy(true);
    try {
      const res = await authFetch('/api/ai/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      });
      if (!res.ok) throw new Error();
      apply(await res.json());
      if (!quiet) toast.success(t('saved'));
      return true;
    } catch {
      toast.error(t('saveFailed'));
      return false;
    } finally {
      setBusy(false);
    }
  };

  const saveCap = () => {
    const parsed = parseCapInput(cap);
    if (parsed === 'invalid') {
      toast.error(t('capInvalid'));
      return;
    }
    void save({ monthly_token_cap: parsed });
  };

  const status = view ? aiStatus(view) : null;

  const placeholder = (
    <div className={cn(SETTINGS_ROW_HAIRLINE, 'space-y-3 px-4 py-3')} role="status" aria-label={t('loading')}>
      {[0, 1, 2, 3].map((i) => <div key={i} className="h-8 w-full animate-pulse rounded-md bg-muted" />)}
    </div>
  );

  return (
    <div className="space-y-6">
      <SettingsGroup
        title={<><Sparkles className="size-4" aria-hidden="true" /> {t('title')}</>}
        footer={<>
          {t('description')}
          {view && <span className="mt-2 block">{ts('staffReviewNote')}</span>}
          {view && (
            <span className="mt-2 block">
              {ts('autonomousNote')}{' '}
              <Link href="/agents" className="text-primary underline-offset-2 hover:underline">{t('autonomousLink')}</Link>
            </span>
          )}
          {view?.settings.updated_at && (
            <span className="mt-2 block">{t('updatedAt', { date: new Date(view.settings.updated_at).toLocaleString() })}</span>
          )}
        </>}
      >
        {loadFailed && (
          <SettingsBlock>
            <InlineError message={t('loadFailed')} onRetry={() => void load()} />
          </SettingsBlock>
        )}
        {!view && !loadFailed && placeholder}
        {view && status && (
          <>
            <div className={cn(SETTINGS_ROW_HAIRLINE, 'flex min-h-11 flex-wrap items-center gap-2 px-4 py-3 text-sm')} role="status">
              <Badge variant={status === 'ready' ? 'secondary' : 'outline'}>
                {status === 'ready' ? ts('status.ready') : t(`badge.${status}`)}
              </Badge>
              {status === 'deploymentOff' && <span className="text-muted-foreground">{ts('status.deploymentOff')} {t('deploymentOffHelp')}</span>}
              {status === 'notConfigured' && (
                <span className="text-muted-foreground">
                  {ts('status.notConfigured')}{' '}
                  <Link href="/agents" className="text-primary underline-offset-2 hover:underline">{t('openAgents')}</Link>
                </span>
              )}
            </div>
            {AI_TOGGLES.map(({ key, feature }) => (
              <SettingsSwitchRow
                key={key}
                title={ts(`features.${feature}`)}
                description={<span id={`ai-toggle-${feature}-help`}>{t(`help.${feature}`)}</span>}
                control={
                  <Switch
                    checked={view.settings[key]}
                    onCheckedChange={(v: boolean) => void save({ [key]: v })}
                    disabled={busy}
                    aria-label={ts(`features.${feature}`)}
                    aria-describedby={`ai-toggle-${feature}-help`}
                  />
                }
              />
            ))}
          </>
        )}
      </SettingsGroup>

      {view && (
        <SettingsGroup
          footer={ts('monthlyTokenCapHint')}
          action={
            <Button type="button" size="sm" className="min-h-11 sm:min-h-8" onClick={saveCap} disabled={busy}>
              {busy && <Loader2 className="size-3.5 animate-spin" />}
              {t('saveCap')}
            </Button>
          }
        >
          <SettingsRow label={ts('monthlyTokenCap')} htmlFor="ai-token-cap">
            <Input
              id="ai-token-cap"
              inputMode="numeric"
              value={cap}
              onChange={(e) => setCap(e.target.value)}
              placeholder={t('capPlaceholder')}
              disabled={busy}
            />
          </SettingsRow>
        </SettingsGroup>
      )}

      {view && instagram && (
        <InstagramGoalsEditor initial={view.settings.instagram_goals ?? NO_GOALS} busy={busy}
          onSave={(goals) => save({ instagram_goals: goals }, true)} />
      )}
    </div>
  );
}
