'use client';

// The agent editor (AI page, Agents tab): one sheet with name, role, goal and
// instructions, tone, channels, handover rules and working hours, as in the
// prototype. Saves through POST /api/ai/agents or PATCH /api/ai/agents/:id.

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { authFetch } from '@/lib/auth/client';
import { Button } from '@/components/ui/button';
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { SegmentedControl } from '@/components/ui/segmented-control';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';
import {
  AGENT_CHANNELS, AGENT_ROLES, AGENT_TONES, formFrom, formToBody,
  type AgentForm, type AgentFormErrors, type AgentView, type HoursMode,
} from './agent-view';

const trigger = 'min-h-11 w-full sm:min-h-9';
const HOURS_MODES: HoursMode[] = ['always', 'during', 'outside'];
const MODE_LABEL = { always: 'editor.modeAlways', during: 'editor.modeDuring', outside: 'editor.modeOutside' } as const;

export function AgentDialog({ open, agent, takenNames, onOpenChange, onSaved }: {
  open: boolean;
  /** null: a new agent. */
  agent: AgentView | null;
  takenNames: readonly string[];
  onOpenChange: (open: boolean) => void;
  onSaved: (agent: AgentView, created: boolean) => void;
}) {
  const t = useTranslations('AiStudio');
  const [form, setForm] = useState<AgentForm>(() => formFrom(agent));
  const [errors, setErrors] = useState<AgentFormErrors>({});
  const [busy, setBusy] = useState(false);
  const set = <K extends keyof AgentForm>(key: K, value: AgentForm[K]) => setForm((f) => ({ ...f, [key]: value }));

  const save = async () => {
    const built = formToBody(form, { isDefault: agent?.is_default === true, takenNames: takenNames.filter((n) => n !== agent?.name) });
    if (!built.ok) { setErrors(built.errors); return; }
    setErrors({});
    setBusy(true);
    try {
      const res = await authFetch(agent ? `/api/ai/agents/${agent.id}` : '/api/ai/agents', {
        method: agent ? 'PATCH' : 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(built.body),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        if (data.code === 'name_taken') setErrors({ name: true });
        toast.error(data.error ?? t('agents.toasts.failed'));
        return;
      }
      onSaved({ ...data.agent, stats: agent?.stats ?? null }, !agent);
      onOpenChange(false);
    } catch {
      toast.error(t('agents.toasts.failed'));
    } finally {
      setBusy(false);
    }
  };

  const err = (key: keyof AgentFormErrors, message: string) =>
    errors[key] ? <p className="text-xs font-medium text-destructive" role="alert">{message}</p> : null;

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" size="lg" className="gap-0 p-0">
        <SheetHeader className="border-b border-border/50 pr-12">
          <SheetTitle>{agent ? t('editor.editTitle', { name: agent.name }) : t('editor.newTitle')}</SheetTitle>
          {agent?.is_default && <SheetDescription>{t('agents.defaultHint')}</SheetDescription>}
        </SheetHeader>
        <form className="flex min-h-0 flex-1 flex-col" onSubmit={(e) => { e.preventDefault(); void save(); }} noValidate>
         <div className="flex-1 space-y-4 overflow-y-auto p-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1">
              <Label htmlFor="agent-name">{t('editor.name')}</Label>
              <Input id="agent-name" value={form.name} maxLength={60} placeholder={t('editor.namePlaceholder')}
                aria-invalid={errors.name ? true : undefined} onChange={(e) => set('name', e.target.value)} />
              {err('name', t('editor.errors.name'))}
            </div>
            <div className="space-y-1">
              <Label htmlFor="agent-role">{t('editor.role')}</Label>
              <Select value={form.role} onValueChange={(v) => { if (v) set('role', v as AgentForm['role']); }}>
                <SelectTrigger id="agent-role" className={trigger}>
                  <SelectValue>{(v: string) => t(`agents.roles.${v}`)}</SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {AGENT_ROLES.map((r) => <SelectItem key={r} value={r}>{t(`agents.roles.${r}`)}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="space-y-1">
            <Label htmlFor="agent-goal">{t('editor.goal')}</Label>
            <Textarea id="agent-goal" rows={4} maxLength={4000} value={form.instructions} placeholder={t('editor.goalPlaceholder')}
              aria-invalid={errors.goal ? true : undefined} onChange={(e) => set('instructions', e.target.value)} />
            {err('goal', t('editor.errors.goal'))}
          </div>
          <div className="space-y-1">
            <Label htmlFor="agent-tone">{t('editor.tone')}</Label>
            <Select value={form.tone} onValueChange={(v) => { if (v) set('tone', v as AgentForm['tone']); }}>
              <SelectTrigger id="agent-tone" className={trigger}>
                <SelectValue>{(v: string) => t(`agents.tones.${v}`)}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                {AGENT_TONES.map((tone) => <SelectItem key={tone} value={tone}>{t(`agents.tones.${tone}`)}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <span className="text-sm font-medium" id="agent-channels-label">{t('editor.channels')}</span>
            <div className="flex flex-wrap gap-2" role="group" aria-labelledby="agent-channels-label">
              {AGENT_CHANNELS.map((c) => {
                const on = form.channels.includes(c);
                return (
                  <button key={c} type="button" aria-pressed={on}
                    className={cn('inline-flex min-h-11 items-center gap-1.5 rounded-full sm:min-h-8 border px-3 text-[13px] font-medium transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50',
                      on ? 'border-primary bg-primary-soft text-primary' : 'border-border bg-card text-muted-foreground hover:text-foreground')}
                    onClick={() => set('channels', on ? form.channels.filter((x) => x !== c) : [...form.channels, c])}>
                    <span aria-hidden className={cn('size-2 rounded-full', c === 'whatsapp' ? 'bg-emerald-500' : 'bg-pink-500')} />
                    {t(`agents.channels.${c}`)}
                  </button>
                );
              })}
            </div>
            {err('channels', t('editor.errors.channels'))}
          </div>

          <fieldset className="min-w-0 space-y-3 rounded-xl border border-border p-3.5">
            <legend className="px-1.5 text-xs font-semibold text-muted-foreground">{t('editor.handoffLegend')}</legend>
            <div className="space-y-1">
              <Label htmlFor="agent-keywords">{t('editor.keywords')}</Label>
              <Input id="agent-keywords" value={form.keywords} maxLength={2000} placeholder={t('editor.keywordsPlaceholder')}
                onChange={(e) => set('keywords', e.target.value)} />
              <p className="text-xs text-muted-foreground">{t('editor.keywordsHint')}</p>
            </div>
            <div className="space-y-1">
              <Label htmlFor="agent-turns">{t('editor.maxTurns')}</Label>
              <Input id="agent-turns" type="number" inputMode="numeric" min={0} max={50} className="max-w-[8rem]" value={form.maxTurns}
                aria-invalid={errors.maxTurns ? true : undefined} onChange={(e) => set('maxTurns', e.target.value)} />
              <p className="text-xs text-muted-foreground">{t('editor.maxTurnsHint')}</p>
              {err('maxTurns', t('editor.errors.maxTurns'))}
            </div>
            <div className="flex items-start justify-between gap-3 border-t border-border pt-3">
              <span className="min-w-0 text-sm">
                <span className="block font-medium" id="agent-unsure-label">{t('editor.unsure')}</span>
                <span className="block text-xs text-muted-foreground">{t('editor.unsureHint')}</span>
              </span>
              <Switch checked={form.unsure} aria-labelledby="agent-unsure-label" onCheckedChange={(v: boolean) => set('unsure', v)} />
            </div>
            <div className="flex items-start justify-between gap-3 border-t border-border pt-3">
              <span className="min-w-0 text-sm">
                <span className="block font-medium" id="agent-no-knowledge-label">{t('editor.noKnowledge')}</span>
                <span className="block text-xs text-muted-foreground">{t('editor.noKnowledgeHint')}</span>
              </span>
              <Switch checked={form.noKnowledge} aria-labelledby="agent-no-knowledge-label" onCheckedChange={(v: boolean) => set('noKnowledge', v)} />
            </div>
          </fieldset>

          <fieldset className="min-w-0 space-y-3 rounded-xl border border-border p-3.5">
            <legend className="px-1.5 text-xs font-semibold text-muted-foreground">{t('editor.hoursLegend')}</legend>
            <div className="space-y-1.5">
              <span className="text-sm font-medium">{t('editor.hoursMode')}</span>
              <SegmentedControl
                aria-label={t('editor.hoursMode')}
                value={form.mode}
                onValueChange={(v) => set('mode', v)}
                options={HOURS_MODES.map((m) => ({ value: m, label: t(MODE_LABEL[m]) }))}
              />
            </div>
            {form.mode !== 'always' && (
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1">
                  <Label htmlFor="agent-from">{t('editor.from')}</Label>
                  <Input id="agent-from" type="time" value={form.from} onChange={(e) => set('from', e.target.value)} />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="agent-to">{t('editor.to')}</Label>
                  <Input id="agent-to" type="time" value={form.to} onChange={(e) => set('to', e.target.value)} />
                </div>
              </div>
            )}
            {err('hours', t('editor.errors.hours'))}
            <p className="text-xs text-muted-foreground">{t('editor.overnightHint')}</p>
            <p className="text-xs text-muted-foreground">{t('editor.timezone')}</p>
          </fieldset>
         </div>
          <SheetFooter className="flex-row justify-end border-t border-border/50">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>{t('common.cancel')}</Button>
            <Button type="submit" disabled={busy}>
              {busy && <Loader2 className="size-4 animate-spin" aria-hidden />}
              {agent ? t('editor.save') : t('editor.create')}
            </Button>
          </SheetFooter>
        </form>
      </SheetContent>
    </Sheet>
  );
}
