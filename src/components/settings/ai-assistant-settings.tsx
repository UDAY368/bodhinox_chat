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
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Checkbox } from '@/components/ui/checkbox';
import { authFetch } from '@/lib/auth/client';
import { useWorkspaceChannels } from '@/hooks/use-workspace-channels';
import { goalsProblem } from '@/lib/ai/goal-rules';
import { AI_GOAL_LIMITS, AI_GOAL_TYPES, AI_LEAD_FIELDS, type AiGoal, type AiGoalType } from '@/lib/flows/types';

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
const fieldClass = 'border-input bg-background h-9 w-full rounded-md border px-2 text-sm';

/** The Instagram goals editor (Settings -> AI assistant). */
function InstagramGoalsEditor({ initial, busy, onSave }: {
  initial: AiGoal[]; busy: boolean; onSave: (goals: AiGoal[]) => Promise<boolean>;
}) {
  const tg = useTranslations('AiSettings.instagramGoals');
  const [goals, setGoals] = useState<AiGoal[]>(initial);
  useEffect(() => { setGoals(initial); }, [initial]);
  const update = (index: number, goal: AiGoal) => setGoals((list) => list.map((g, i) => (i === index ? goal : g)));
  const unused = unusedGoalTypes(goals);
  const dirty = JSON.stringify(goals) !== JSON.stringify(initial);

  const save = async () => {
    const cleaned = goals.map((g): AiGoal => g.type === 'share_link'
      ? { type: 'share_link', url: g.url.trim(), ...(g.label?.trim() ? { label: g.label.trim() } : {}) }
      : g);
    if (goalsProblem(cleaned) !== null) {
      toast.error(tg('invalid'));
      return;
    }
    if (await onSave(cleaned)) toast.success(tg('saved'));
  };

  return (
    <section className="space-y-3 rounded-lg border p-3" aria-labelledby="ai-instagram-goals-title">
      <div>
        <h3 id="ai-instagram-goals-title" className="text-sm font-medium">{tg('title')}</h3>
        <p className="text-muted-foreground text-xs">{tg('description')} {tg('onlyInstagram')}</p>
      </div>
      {goals.length === 0 && <p className="text-muted-foreground text-sm">{tg('empty')}</p>}
      <ol className="space-y-3">
        {goals.map((goal, index) => {
          const id = `ai-goal-${index}`;
          return (
            <li key={goal.type} className="bg-muted/30 space-y-2 rounded-md border p-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-medium">{tg('goalLabel', { n: index + 1 })}</span>
                <label className="sr-only" htmlFor={`${id}-type`}>{tg('type')}</label>
                <select id={`${id}-type`} className={`${fieldClass} w-auto`} value={goal.type} disabled={busy}
                  onChange={(e) => update(index, blankGoal(e.target.value as AiGoalType))}>
                  {[goal.type, ...unused].map((type) => <option key={type} value={type}>{tg(`types.${type}`)}</option>)}
                </select>
                <span className="ml-auto flex gap-1">
                  <Button type="button" size="icon" variant="ghost" aria-label={tg('moveUp')} disabled={busy || index === 0}
                    onClick={() => setGoals((list) => moveGoal(list, index, -1))}><ArrowUp className="size-4" aria-hidden="true" /></Button>
                  <Button type="button" size="icon" variant="ghost" aria-label={tg('moveDown')} disabled={busy || index === goals.length - 1}
                    onClick={() => setGoals((list) => moveGoal(list, index, 1))}><ArrowDown className="size-4" aria-hidden="true" /></Button>
                  <Button type="button" size="icon" variant="ghost" aria-label={tg('remove')} disabled={busy}
                    onClick={() => setGoals((list) => list.filter((_, i) => i !== index))}><Trash2 className="size-4" aria-hidden="true" /></Button>
                </span>
              </div>
              <p className="text-muted-foreground text-xs">{tg(`typeHelp.${goal.type}`)}</p>
              {goal.type === 'share_link' && (
                <div className="grid gap-2 sm:grid-cols-2">
                  <div className="space-y-1">
                    <Label htmlFor={`${id}-url`}>{tg('url')}</Label>
                    <Input id={`${id}-url`} type="url" inputMode="url" value={goal.url} maxLength={2048} disabled={busy}
                      placeholder="https://" onChange={(e) => update(index, { ...goal, url: e.target.value })} />
                  </div>
                  <div className="space-y-1">
                    <Label htmlFor={`${id}-label`}>{tg('linkLabel')}</Label>
                    <Input id={`${id}-label`} value={goal.label ?? ''} maxLength={80} disabled={busy}
                      onChange={(e) => update(index, { ...goal, label: e.target.value })} />
                  </div>
                </div>
              )}
              {goal.type === 'capture_lead' && (
                <div className="space-y-2">
                  <fieldset className="space-y-1">
                    <legend className="text-sm">{tg('fields')}</legend>
                    <div className="flex flex-wrap gap-3">
                      {AI_LEAD_FIELDS.map((field) => (
                        <label key={field} className="flex items-center gap-2 text-sm">
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
                  </fieldset>
                  <div className="max-w-xs space-y-1">
                    <Label htmlFor={`${id}-refusal`}>{tg('onRefusal')}</Label>
                    <select id={`${id}-refusal`} className={fieldClass} value={goal.on_refusal} disabled={busy}
                      onChange={(e) => update(index, { ...goal, on_refusal: e.target.value === 'handoff' ? 'handoff' : 'continue' })}>
                      <option value="continue">{tg('refusalContinue')}</option>
                      <option value="handoff">{tg('refusalHandoff')}</option>
                    </select>
                  </div>
                </div>
              )}
            </li>
          );
        })}
      </ol>
      <div className="flex flex-wrap gap-2">
        {goals.length < AI_GOAL_LIMITS.goals && unused.length > 0 && (
          <Button type="button" variant="outline" size="sm" disabled={busy}
            onClick={() => setGoals((list) => [...list, blankGoal(unused[0])])}>
            <Plus className="size-3.5" aria-hidden="true" /> {tg('add')}
          </Button>
        )}
        <Button type="button" size="sm" disabled={busy || !dirty} onClick={() => void save()}>
          {busy && <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />}
          {tg('save')}
        </Button>
      </div>
    </section>
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

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Sparkles className="size-4" aria-hidden="true" /> {t('title')}
        </CardTitle>
        <CardDescription>{t('description')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        {loadFailed && (
          <div className="flex items-center gap-3 text-sm">
            <p className="text-destructive">{t('loadFailed')}</p>
            <Button type="button" size="sm" variant="outline" onClick={() => void load()}>{t('retry')}</Button>
          </div>
        )}
        {!view && !loadFailed && <Loader2 className="text-muted-foreground size-4 animate-spin" aria-label={t('loading')} />}
        {view && status && (
          <>
            <div className="flex flex-wrap items-center gap-2 text-sm" role="status">
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

            <p className="text-muted-foreground text-sm">{ts('staffReviewNote')}</p>

            <div className="divide-border divide-y rounded-lg border">
              {AI_TOGGLES.map(({ key, feature }) => (
                <label key={key} className="flex items-start gap-3 p-3 text-sm">
                  <Switch
                    checked={view.settings[key]}
                    onCheckedChange={(v: boolean) => void save({ [key]: v })}
                    disabled={busy}
                    aria-describedby={`ai-toggle-${feature}-help`}
                  />
                  <span className="min-w-0">
                    <span className="text-foreground block font-medium">{ts(`features.${feature}`)}</span>
                    <span id={`ai-toggle-${feature}-help`} className="text-muted-foreground block text-xs">{t(`help.${feature}`)}</span>
                  </span>
                </label>
              ))}
            </div>

            <div className="space-y-2">
              <Label htmlFor="ai-token-cap">{ts('monthlyTokenCap')}</Label>
              <div className="flex max-w-sm gap-2">
                <Input
                  id="ai-token-cap"
                  inputMode="numeric"
                  value={cap}
                  onChange={(e) => setCap(e.target.value)}
                  placeholder={t('capPlaceholder')}
                  disabled={busy}
                />
                <Button type="button" variant="outline" onClick={saveCap} disabled={busy}>
                  {busy && <Loader2 className="size-3.5 animate-spin" />}
                  {t('saveCap')}
                </Button>
              </div>
              <p className="text-muted-foreground text-xs">{ts('monthlyTokenCapHint')}</p>
            </div>

            {instagram && (
              <InstagramGoalsEditor initial={view.settings.instagram_goals ?? NO_GOALS} busy={busy}
                onSave={(goals) => save({ instagram_goals: goals }, true)} />
            )}

            <p className="text-muted-foreground text-xs">
              {ts('autonomousNote')}{' '}
              <Link href="/agents" className="text-primary underline-offset-2 hover:underline">{t('autonomousLink')}</Link>
            </p>
            {view.settings.updated_at && (
              <p className="text-muted-foreground text-xs">{t('updatedAt', { date: new Date(view.settings.updated_at).toLocaleString() })}</p>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
