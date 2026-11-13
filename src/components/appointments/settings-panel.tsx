'use client';

/**
 * Booking settings: hold length, unconfirmed-hold cap per page, notice,
 * horizon, customer cut-off, reminder and staff-notification toggles, and
 * the five WhatsApp templates. A template that cannot carry an appointment
 * message (appointmentTemplateRefusal) is listed but not selectable, with the
 * reason; the server checks again on save.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { createClient } from '@/lib/data/client';
import {
  appointmentTemplateRefusal, manageButtonUrl, type AppointmentCheckedTemplate, type AppointmentTemplateRefusal,
} from '@/lib/appointments/template-check';
import {
  APPOINTMENT_TEMPLATE_SLOTS, type AppointmentSettingsRow, type AppointmentTemplateSlot,
} from '@/lib/appointments/types';
import { apiRequest, selectClass, useFailureText, type ApiFailure } from './shared';

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
  const tAppointments = useTranslations('Appointments');
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

  if (loadFailure) {
    return (
      <div className="max-w-2xl space-y-2 text-sm" role="alert">
        <p className="text-destructive">{failureText(loadFailure)}</p>
        <Button type="button" variant="outline" size="sm" onClick={() => void loadSettings()}>{tAppointments('retry')}</Button>
      </div>
    );
  }
  if (!settings) return <Loader2 className="h-5 w-5 animate-spin text-primary" aria-label={t('title')} />;
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
              <select id={`tpl-${slot}`} className={selectClass} value={value} disabled={disabled} onChange={(e) => setTemplate(slot, e.target.value)}>
                <option value="">{t('noTemplate')}</option>
                {value && !current && <option value={value}>{value.replace('|', ' (')})</option>}
                {choices.map((c) => (
                  <option key={c.key} value={c.key} disabled={!!c.refusal && c.key !== value}>
                    {c.label}{c.refusal ? ` — ${t(`templateErrors.${c.refusal}`)}` : ''}
                  </option>
                ))}
              </select>
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
