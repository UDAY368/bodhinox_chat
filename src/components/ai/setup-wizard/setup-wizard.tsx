'use client';
import { authFetch } from '@/lib/auth/client';

import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { Check, ChevronLeft, ChevronRight, Loader2, Rocket } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Switch } from '@/components/ui/switch';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { cn } from '@/lib/utils';
import type { AgentProfile } from '@/lib/ai/agent-profile';
import {
  BUSINESS_TYPE_SUGGESTIONS,
  MIN_CONFIDENCE_THRESHOLD,
  WIZARD_STEPS,
  WIZARD_TONES,
  draftToInput,
  fullDraftInput,
  parseKeywords,
  profileToDraft,
  type WizardDraft,
  type WizardStep,
} from './wizard-state';

const JSON_HEADERS = { 'Content-Type': 'application/json' };

export interface AgentSetupWizardProps {
  /** Admins and owners can save; everyone else sees a read-only wizard. */
  canEdit: boolean;
  /**
   * Rendered inside the Knowledge step (the knowledge manager). When
   * omitted the step explains where to add knowledge and offers
   * `onOpenKnowledge`.
   */
  knowledgeSlot?: ReactNode;
  /** Opens the page's Knowledge tab. */
  onOpenKnowledge?: () => void;
  /** Opens the AI provider/model settings (needed before auto-reply can run). */
  onOpenProvider?: () => void;
  /** Called after setup completes and auto-reply is enabled. */
  onFinished?: () => void;
}

/**
 * Onboarding wizard for the AI agent: business, instructions and tone,
 * greeting, handoff rules, knowledge, then review and enable
 * auto-reply. Each "Next" saves that step's fields (partial PUT), so a
 * half-finished setup is kept.
 */
export function AgentSetupWizard({ canEdit, knowledgeSlot, onOpenKnowledge, onOpenProvider, onFinished }: AgentSetupWizardProps) {
  const t = useTranslations('AgentSetup');
  const [draft, setDraft] = useState<WizardDraft | null>(null);
  const [completedAt, setCompletedAt] = useState<string | null>(null);
  const [stepIndex, setStepIndex] = useState(0);
  const [saving, setSaving] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);

  const load = useCallback(async () => {
    setLoadFailed(false);
    try {
      const res = await authFetch('/api/ai/agent-profile');
      const data = (await res.json().catch(() => null)) as { saved?: boolean; profile?: AgentProfile } | null;
      if (!res.ok || !data?.profile) throw new Error('load');
      setDraft(profileToDraft(data.profile));
      setCompletedAt(data.profile.setup_completed_at);
    } catch {
      setLoadFailed(true);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const step: WizardStep = WIZARD_STEPS[stepIndex];
  const update = <K extends keyof WizardDraft>(key: K, value: WizardDraft[K]) =>
    setDraft((d) => (d ? { ...d, [key]: value } : d));

  const save = async (body: Record<string, unknown>): Promise<boolean> => {
    if (!canEdit || Object.keys(body).length === 0) return true;
    setSaving(true);
    try {
      const res = await authFetch('/api/ai/agent-profile', { method: 'PUT', headers: JSON_HEADERS, body: JSON.stringify(body) });
      const data = (await res.json().catch(() => ({}))) as { error?: string; profile?: AgentProfile };
      if (!res.ok || !data.profile) {
        toast.error(data.error ?? t('saveFailed'));
        return false;
      }
      setCompletedAt(data.profile.setup_completed_at);
      return true;
    } catch {
      toast.error(t('saveFailed'));
      return false;
    } finally {
      setSaving(false);
    }
  };

  const next = async () => {
    if (!draft) return;
    if (await save(draftToInput(draft, step))) setStepIndex((i) => Math.min(WIZARD_STEPS.length - 1, i + 1));
  };

  /** Saves everything, marks setup complete, then turns auto-reply on through the existing AI config. */
  const finish = async () => {
    if (!draft || !canEdit) return;
    if (!(await save({ ...fullDraftInput(draft), complete_setup: true }))) return;
    setSaving(true);
    try {
      const res = await authFetch('/api/ai/config');
      const config = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      if (!res.ok || !config.configured) {
        toast.error(t('review.providerMissing'));
        onOpenProvider?.();
        return;
      }
      const enable = await authFetch('/api/ai/config', {
        method: 'POST',
        headers: JSON_HEADERS,
        // Resend the stored settings unchanged (the key is reused server-side) with auto-reply on.
        body: JSON.stringify({
          provider: config.provider,
          model: config.model,
          base_url: config.base_url ?? null,
          system_prompt: config.system_prompt ?? null,
          is_active: true,
          auto_reply_enabled: true,
          auto_reply_max_per_conversation: config.auto_reply_max_per_conversation,
          handoff_agent_id: config.handoff_agent_id ?? null,
        }),
      });
      const result = (await enable.json().catch(() => ({}))) as { error?: string };
      if (!enable.ok) {
        toast.error(result.error ?? t('review.enableFailed'));
        return;
      }
      toast.success(t('review.enabled'));
      onFinished?.();
    } catch {
      toast.error(t('review.enableFailed'));
    } finally {
      setSaving(false);
    }
  };

  if (loadFailed) {
    return (
      <Card>
        <CardContent className="flex items-center justify-between gap-3 py-6 text-sm">
          <span>{t('loadFailed')}</span>
          <Button variant="outline" size="sm" onClick={() => void load()}>{t('retry')}</Button>
        </CardContent>
      </Card>
    );
  }
  if (!draft) {
    return (
      <div className="flex justify-center py-10 text-muted-foreground">
        <Loader2 className="h-5 w-5 animate-spin" aria-label={t('loading')} />
      </div>
    );
  }

  const disabled = !canEdit || saving;
  const keywords = parseKeywords(draft.keywords);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-[15px] font-semibold">{t('title')}</CardTitle>
        <CardDescription>
          {completedAt ? t('completedDescription') : t('description')}
          {!canEdit && <span className="mt-1 block">{t('readOnly')}</span>}
        </CardDescription>
        <ol className="mt-3 flex flex-wrap gap-1.5" aria-label={t('progress')}>
          {WIZARD_STEPS.map((s, i) => (
            <li key={s}>
              <button
                type="button"
                onClick={() => setStepIndex(i)}
                aria-current={i === stepIndex ? 'step' : undefined}
                className={cn(
                  'flex h-7 items-center gap-1.5 rounded-full px-3 text-xs font-medium transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                  i === stepIndex ? 'bg-primary/10 text-primary' : 'bg-muted text-muted-foreground hover:text-foreground',
                )}
              >
                {i < stepIndex ? <Check className="h-3 w-3" /> : <span className="tabular-nums">{i + 1}</span>}
                {t(`steps.${s}`)}
              </button>
            </li>
          ))}
        </ol>
      </CardHeader>

      <CardContent className="space-y-5">
        {step === 'business' && (
          <div className="space-y-4">
            <Field id="wiz-website" label={t('business.website')} hint={t('business.websiteHint')}>
              <Input id="wiz-website" type="url" inputMode="url" placeholder="https://example.com" maxLength={2048}
                value={draft.website_url} disabled={disabled} onChange={(e) => update('website_url', e.target.value)} />
            </Field>
            <Field id="wiz-name" label={t('business.name')}>
              <Input id="wiz-name" maxLength={200} value={draft.business_name} disabled={disabled}
                onChange={(e) => update('business_name', e.target.value)} />
            </Field>
            <Field id="wiz-type" label={t('business.type')} hint={t('business.typeHint')}>
              <Input id="wiz-type" maxLength={100} value={draft.business_type} disabled={disabled}
                onChange={(e) => update('business_type', e.target.value)} />
              <div className="mt-2 flex flex-wrap gap-1.5">
                {BUSINESS_TYPE_SUGGESTIONS.map((type) => {
                  const label = t(`business.types.${type}`);
                  return (
                    <Chip key={type} active={draft.business_type === label} disabled={disabled}
                      onClick={() => update('business_type', label)}>{label}</Chip>
                  );
                })}
              </div>
            </Field>
          </div>
        )}

        {step === 'instructions' && (
          <div className="space-y-4">
            <Field id="wiz-instructions" label={t('instructions.label')} hint={t('instructions.hint')}>
              <Textarea id="wiz-instructions" rows={7} maxLength={4000} value={draft.instructions} disabled={disabled}
                placeholder={t('instructions.placeholder')} onChange={(e) => update('instructions', e.target.value)} />
              <p className="mt-1 text-right text-xs text-muted-foreground tabular-nums">{draft.instructions.length}/4000</p>
            </Field>
            <fieldset className="space-y-2">
              <legend className="text-sm font-medium">{t('instructions.tone')}</legend>
              <div className="flex flex-wrap gap-1.5">
                {WIZARD_TONES.map((tone) => (
                  <Chip key={tone} active={draft.tone === tone} disabled={disabled}
                    onClick={() => update('tone', draft.tone === tone ? null : tone)}>{t(`tones.${tone}`)}</Chip>
                ))}
              </div>
            </fieldset>
          </div>
        )}

        {step === 'greeting' && (
          <Field id="wiz-greeting" label={t('greeting.label')} hint={t('greeting.hint')}>
            <Textarea id="wiz-greeting" rows={4} maxLength={1024} value={draft.greeting} disabled={disabled}
              placeholder={t('greeting.placeholder')} onChange={(e) => update('greeting', e.target.value)} />
          </Field>
        )}

        {step === 'handoff' && (
          <div className="space-y-5">
            <Field id="wiz-keywords" label={t('handoff.keywords')} hint={t('handoff.keywordsHint')}>
              <Input id="wiz-keywords" value={draft.keywords} disabled={disabled} placeholder={t('handoff.keywordsPlaceholder')}
                onChange={(e) => update('keywords', e.target.value)} />
              {keywords.length > 0 && (
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {keywords.map((k) => <span key={k} className="rounded-full bg-muted px-2 py-0.5 text-xs">{k}</span>)}
                </div>
              )}
            </Field>
            <div className="flex items-start justify-between gap-4">
              <div>
                <Label htmlFor="wiz-low-confidence">{t('handoff.lowConfidence')}</Label>
                <p className="mt-0.5 text-xs text-muted-foreground">{t('handoff.lowConfidenceHint')}</p>
              </div>
              <Switch id="wiz-low-confidence" checked={draft.on_low_confidence} disabled={disabled}
                onCheckedChange={(checked) => update('on_low_confidence', checked === true)} />
            </div>
            {draft.on_low_confidence && (
              <Field id="wiz-threshold" label={t('handoff.threshold', { value: Math.round(draft.confidence_threshold * 100) })}
                hint={t('handoff.thresholdHint')}>
                <input id="wiz-threshold" type="range" min={MIN_CONFIDENCE_THRESHOLD} max={1} step={0.05} className="w-full accent-primary"
                  value={draft.confidence_threshold} disabled={disabled}
                  onChange={(e) => update('confidence_threshold', Number(e.target.value))} />
              </Field>
            )}
            <Field id="wiz-turns" label={t('handoff.maxTurns')} hint={t('handoff.maxTurnsHint')}>
              <Input id="wiz-turns" type="number" min={0} max={50} className="w-28" disabled={disabled}
                value={draft.max_turns_before_handoff}
                onChange={(e) => update('max_turns_before_handoff', Number(e.target.value))} />
            </Field>
          </div>
        )}

        {step === 'knowledge' && (
          knowledgeSlot ?? (
            <div className="rounded-xl bg-muted p-5 text-sm">
              <p className="font-medium">{t('knowledge.title')}</p>
              <p className="mt-1 text-muted-foreground">{t('knowledge.placeholder')}</p>
              {onOpenKnowledge && (
                <Button variant="outline" size="sm" className="mt-3" onClick={onOpenKnowledge}>{t('knowledge.open')}</Button>
              )}
            </div>
          )
        )}

        {step === 'review' && (
          <div className="space-y-4 text-sm">
            <dl className="grid gap-x-4 gap-y-2 sm:grid-cols-[10rem_1fr]">
              <ReviewRow label={t('business.name')} value={draft.business_name} empty={t('review.notSet')} />
              <ReviewRow label={t('business.type')} value={draft.business_type} empty={t('review.notSet')} />
              <ReviewRow label={t('business.website')} value={draft.website_url} empty={t('review.notSet')} />
              <ReviewRow label={t('instructions.tone')} value={draft.tone ? t(`tones.${draft.tone}`) : ''} empty={t('review.notSet')} />
              <ReviewRow label={t('instructions.label')} value={draft.instructions} empty={t('review.notSet')} />
              <ReviewRow label={t('greeting.label')} value={draft.greeting} empty={t('review.notSet')} />
              <ReviewRow label={t('handoff.keywords')} value={keywords.join(', ')} empty={t('review.none')} />
              <ReviewRow label={t('handoff.maxTurns')}
                value={draft.max_turns_before_handoff > 0 ? String(draft.max_turns_before_handoff) : t('review.noLimit')} empty="" />
            </dl>
            <p className="text-muted-foreground">{t('review.explain')}</p>
          </div>
        )}

        <div className="flex items-center justify-between border-t pt-4">
          <Button variant="ghost" size="sm" disabled={stepIndex === 0 || saving} onClick={() => setStepIndex((i) => Math.max(0, i - 1))}>
            <ChevronLeft className="mr-1 h-4 w-4" /> {t('back')}
          </Button>
          {step === 'review' ? (
            <Button size="sm" disabled={disabled} onClick={() => void finish()}>
              {saving ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <Rocket className="mr-1.5 h-4 w-4" />}
              {t('review.enable')}
            </Button>
          ) : (
            <Button size="sm" disabled={saving} onClick={() => void next()}>
              {saving && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
              {canEdit ? t('saveAndContinue') : t('next')} <ChevronRight className="ml-1 h-4 w-4" />
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

function Field({ id, label, hint, children }: { id: string; label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
      {children}
    </div>
  );
}

function Chip({ active, disabled, onClick, children }: { active: boolean; disabled?: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button type="button" disabled={disabled} aria-pressed={active} onClick={onClick}
      className={cn(
        'rounded-full border px-3 py-1 text-xs font-medium transition-colors duration-150 disabled:cursor-not-allowed disabled:opacity-60',
        active ? 'border-transparent bg-primary/10 text-primary' : 'border-border text-muted-foreground hover:bg-muted hover:text-foreground',
      )}>
      {children}
    </button>
  );
}

function ReviewRow({ label, value, empty }: { label: string; value: string; empty: string }) {
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className={cn('whitespace-pre-wrap break-words', !value && 'text-muted-foreground italic')}>
        {value ? (value.length > 300 ? `${value.slice(0, 300)}…` : value) : empty}
      </dd>
    </>
  );
}
