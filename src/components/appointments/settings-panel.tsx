'use client';

/**
 * Booking settings: hold length, unconfirmed-hold cap per page, notice,
 * horizon, customer cut-off, reminder and staff-notification toggles, and
 * the five WhatsApp templates. A template that cannot carry an appointment
 * message (appointmentTemplateRefusal) is listed but not selectable, with the
 * reason; the server checks again on save.
 */
import { OptionSelect } from '@/components/contacts/option-select';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { InlineError } from '@/components/ui/inline-error';
import { Input } from '@/components/ui/input';
import { PageLoading } from '@/components/ui/page-loading';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from '@/components/ui/select';
import { createClient } from '@/lib/data/client';
import {
  appointmentTemplateRefusal, manageButtonUrl, type AppointmentCheckedTemplate, type AppointmentTemplateRefusal,
} from '@/lib/appointments/template-check';
import {
  APPOINTMENT_TEMPLATE_SLOTS, type AppointmentSettingsRow, type AppointmentTemplateSlot,
} from '@/lib/appointments/types';
import { apiRequest, useFailureText, type ApiFailure } from './shared';

export type TemplateOption = AppointmentCheckedTemplate & { id: string; name: string; language: string };

export interface TemplateChoice { key: string; label: string; refusal: AppointmentTemplateRefusal | null }

export const templateKey = (name: string | null, language: string | null) => (name && language ? `${name}|${language}` : '');

/** Approved templates as picker choices, each with why it cannot be used (pure; tested). */
export function templateChoices(templates: TemplateOption[], origin: string): TemplateChoice[] {
  return templates.map((tpl) => ({
    key: templateKey(tpl.name, tpl.language),
    label: `${tpl.name} (${tpl.language})`,
    refusal: appointmentTemplateRefusal(tpl, origin),
  }));
}

/**
 * Only the fields the admin changed since the settings were loaded (pure;
 * tested), so a stale form never overwrites fields nobody touched. A
 * template slot's name and language always travel together.
 */
export function settingsPatch(baseline: AppointmentSettingsRow, edited: AppointmentSettingsRow): Partial<AppointmentSettingsRow> {
  const patch: Record<string, unknown> = {};
  for (const key of Object.keys(edited) as (keyof AppointmentSettingsRow)[]) {
    if (edited[key] !== baseline[key]) patch[key] = edited[key];
  }
  for (const slot of APPOINTMENT_TEMPLATE_SLOTS) {
    const nameKey = `${slot}_template_name` as const, langKey = `${slot}_template_language` as const;
    if (nameKey in patch || langKey in patch) {
      patch[nameKey] = edited[nameKey];
      patch[langKey] = edited[langKey];
    }
  }
  return patch as Partial<AppointmentSettingsRow>;
}

const NUMBERS: { key: keyof AppointmentSettingsRow; label: string; min: number; max: number; help?: string }[] = [
  { key: 'hold_minutes', label: 'holdMinutes', min: 5, max: 60, help: 'holdMinutesHelp' },
  { key: 'max_active_holds_per_page', label: 'maxActiveHolds', min: 1, max: 200, help: 'maxActiveHoldsHelp' },
  { key: 'min_notice_minutes', label: 'minNotice', min: 0, max: 10080 },
  { key: 'horizon_days', label: 'horizon', min: 1, max: 365 },
  { key: 'customer_cancel_cutoff_minutes', label: 'cancelCutoff', min: 0, max: 10080 },
];
const SWITCHES: { key: 'reminder_24h' | 'reminder_2h' | 'staff_notify'; label: string }[] = [
  { key: 'reminder_24h', label: 'reminder24h' },
  { key: 'reminder_2h', label: 'reminder2h' },
  { key: 'staff_notify', label: 'staffNotify' },
];

export function SettingsPanel({ canEdit }: { canEdit: boolean }) {
  const t = useTranslations('AppointmentSettings');
  const failureText = useFailureText();
  /** The settings as last loaded or saved: the form only ever sends what differs from it. */
  const [baseline, setBaseline] = useState<AppointmentSettingsRow | null>(null);
  const [settings, setSettings] = useState<AppointmentSettingsRow | null>(null);
  const [loadFailure, setLoadFailure] = useState<ApiFailure | null>(null);
  const [templates, setTemplates] = useState<TemplateOption[]>([]);
  const [busy, setBusy] = useState(false);
  const [fieldError, setFieldError] = useState<{ field: string; message: string } | null>(null);
  const origin = typeof window === 'undefined' ? '' : window.location.origin;

  // A failed load shows the reason and Retry, never defaults that look saved and could be saved over the real ones.
  const loadSettings = useCallback(async () => {
    setLoadFailure(null);
    const r = await apiRequest<{ settings: AppointmentSettingsRow }>('/api/appointments/settings');
    if (!r.ok) return setLoadFailure(r);
    setBaseline(r.data.settings);
    setSettings(r.data.settings);
  }, []);

  useEffect(() => {
    let live = true;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void loadSettings();
    void createClient().from('message_templates')
      .select('id,name,language,category,body_text,header_type,header_content,header_media_url,buttons,template_kind,cards,lto')
      .eq('status', 'APPROVED').order('name')
      .then(({ data }) => {
        if (live) setTemplates((data as TemplateOption[] | null) ?? []);
      });
    return () => {
      live = false;
    };
  }, [loadSettings]);

  const choices = useMemo(() => templateChoices(templates, origin), [templates, origin]);

  async function save() {
    if (!settings || !baseline) return;
    const patch = settingsPatch(baseline, settings);
    setFieldError(null);
    if (Object.keys(patch).length === 0) return void toast.success(t('saved'));
    setBusy(true);
    const r = await apiRequest<{ settings: AppointmentSettingsRow }>('/api/appointments/settings', { method: 'PATCH', body: patch });
    setBusy(false);
    if (!r.ok) {
      const message = failureText(r);
      if (r.field) setFieldError({ field: r.field, message });
      return void toast.error(message);
    }
    setBaseline(r.data.settings);
    setSettings(r.data.settings);
    toast.success(t('saved'));
  }

  if (loadFailure) return <InlineError className="max-w-2xl" message={failureText(loadFailure)} onRetry={() => void loadSettings()} />;
  if (!settings) return <PageLoading rows={4} className="max-w-2xl" />;
  const set = (patch: Partial<AppointmentSettingsRow>) => setSettings((s) => (s ? { ...s, ...patch } : s));
  const disabled = !canEdit || busy;

  const setTemplate = (slot: AppointmentTemplateSlot, key: string) => {
    const [name, language] = key ? key.split('|') : [null, null];
    set({ [`${slot}_template_name`]: name, [`${slot}_template_language`]: language } as Partial<AppointmentSettingsRow>);
  };

  return (
    <div className="max-w-2xl space-y-6 text-sm">
      <h2 className="text-base font-semibold tracking-tight">{t('title')}</h2>
      <div className="grid gap-4 sm:grid-cols-2">
        {NUMBERS.map((n) => (
          <div key={n.key} className="space-y-1">
            <Label htmlFor={`set-${n.key}`}>{t(n.label as 'holdMinutes')}</Label>
            <Input id={`set-${n.key}`} type="number" min={n.min} max={n.max} disabled={disabled}
              value={String(settings[n.key] ?? '')} onChange={(e) => set({ [n.key]: Number(e.target.value) } as Partial<AppointmentSettingsRow>)} />
            {n.help && <p className="text-[11px] text-muted-foreground">{t(n.help as 'holdMinutesHelp')}</p>}
            {fieldError?.field === n.key && <p className="text-xs text-destructive">{fieldError.message}</p>}
          </div>
        ))}
      </div>
      <div className="space-y-2">
        {SWITCHES.map((s) => (
          <label key={s.key} className="flex items-center gap-2">
            <Switch checked={settings[s.key]} disabled={disabled} onCheckedChange={(v) => set({ [s.key]: v })} aria-label={t(s.label as 'reminder24h')} />
            {t(s.label as 'reminder24h')}
          </label>
        ))}
        <p className="text-[11px] text-muted-foreground">{t('remindersHelp')}</p>
      </div>
      <div className="space-y-3">
        <div>
          <h3 className="font-semibold">{t('templates')}</h3>
          <p className="text-[11px] text-muted-foreground">{t('templatesHelp')}</p>
          {origin && <p className="text-[11px] text-muted-foreground">{t('manageButtonHelp', { url: manageButtonUrl(origin) })}</p>}
        </div>
        {APPOINTMENT_TEMPLATE_SLOTS.map((slot) => {
          const value = templateKey(settings[`${slot}_template_name`], settings[`${slot}_template_language`]);
          const current = choices.find((c) => c.key === value);
          return (
            <div key={slot} className="space-y-1">
              <Label htmlFor={`tpl-${slot}`}>{t(`templateSlots.${slot}`)}</Label>
              <OptionSelect id={`tpl-${slot}`} value={value} disabled={disabled} onValueChange={(v) => setTemplate(slot, v)}
                options={[
                  { value: '', label: t('noTemplate') },
                  ...(value && !current ? [{ value, label: `${value.replace('|', ' (')})` }] : []),
                  ...choices.map((c) => ({
                    value: c.key,
                    label: `${c.label}${c.refusal ? ` — ${t(`templateErrors.${c.refusal}`)}` : ''}`,
                    disabled: !!c.refusal && c.key !== value,
                  })),
                ]} />
              {current?.refusal && <p className="text-xs text-destructive">{t(`templateErrors.${current.refusal}`)}</p>}
              {fieldError?.field === `${slot}_template_name` && <p className="text-xs text-destructive">{fieldError.message}</p>}
            </div>
          );
        })}
      </div>
      {canEdit && <Button type="button" disabled={busy} onClick={() => void save()}>{t('save')}</Button>}
    </div>
  );
}

interface StageOption { id: string; name: string; pipeline_id: string; pipeline_name: string }

/**
 * Deals (Batch 3): the stage a completed booking moves its linked deal to.
 * Saved on its own, so it never overwrites the booking settings above.
 */
const NO_STAGE = '__no_stage__';

export function DealStageCard({ canEdit }: { canEdit: boolean }) {
  const t = useTranslations('Appointments.deal');
  const tA = useTranslations('Appointments');
  const failureText = useFailureText();
  const [stages, setStages] = useState<StageOption[] | null>(null);
  const [value, setValue] = useState('');
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setFailed(false);
    const [settings, list] = await Promise.all([
      apiRequest<{ settings: { completed_deal_stage_id?: string | null } }>('/api/appointments/settings'),
      canEdit ? apiRequest<{ stages: StageOption[] }>('/api/appointments/deal-stages') : Promise.resolve(null),
    ]);
    if (!settings.ok || (list && !list.ok)) return setFailed(true);
    setValue(settings.data.settings.completed_deal_stage_id ?? '');
    setStages(list && list.ok ? list.data.stages ?? [] : []);
  }, [canEdit]);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  async function save(next: string) {
    setBusy(true);
    const previous = value;
    setValue(next);
    const r = await apiRequest('/api/appointments/settings', { method: 'PATCH', body: { completed_deal_stage_id: next || null } });
    setBusy(false);
    if (!r.ok) {
      setValue(previous);
      return void toast.error(failureText(r as ApiFailure));
    }
    toast.success(t('stageSaved'));
  }

  const pipelines = useMemo(() => {
    const groups = new Map<string, { name: string; stages: StageOption[] }>();
    for (const s of stages ?? []) {
      const g = groups.get(s.pipeline_id) ?? { name: s.pipeline_name, stages: [] };
      g.stages.push(s);
      groups.set(s.pipeline_id, g);
    }
    return [...groups.entries()];
  }, [stages]);
  const stageItems = useMemo(() => [
    { value: NO_STAGE, label: t('stageNone') },
    ...(stages ?? []).map((s) => ({ value: s.id, label: s.name })),
    ...(value && !(stages ?? []).some((s) => s.id === value) ? [{ value, label: value.slice(0, 8) }] : []),
  ], [stages, value, t]);

  if (failed) return <InlineError message={tA('loadFailed')} onRetry={() => void load()} />;
  if (!stages) return <PageLoading rows={1} />;
  return (
    <div className="space-y-2 rounded-group border border-separator bg-grouped-surface p-4">
      <Label htmlFor="appt-deal-stage">{t('stageLabel')}</Label>
      <Select
        items={stageItems}
        value={value || NO_STAGE}
        disabled={!canEdit || busy}
        onValueChange={(v) => { if (typeof v === 'string') void save(v === NO_STAGE ? '' : v); }}
      >
        <SelectTrigger id="appt-deal-stage" className="w-full"><SelectValue /></SelectTrigger>
        <SelectContent>
          <SelectItem value={NO_STAGE}>{t('stageNone')}</SelectItem>
          {pipelines.map(([id, g]) => (
            <SelectGroup key={id}>
              <SelectLabel>{g.name}</SelectLabel>
              {g.stages.map((s) => <SelectItem key={s.id} value={s.id}>{s.name}</SelectItem>)}
            </SelectGroup>
          ))}
          {value && !stages.some((s) => s.id === value) && <SelectItem value={value}>{value.slice(0, 8)}</SelectItem>}
        </SelectContent>
      </Select>
      <p className="text-footnote text-muted-foreground">{t('stageHelp')}</p>
    </div>
  );
}
