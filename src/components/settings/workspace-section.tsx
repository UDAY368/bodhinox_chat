'use client';

/**
 * Settings › Workspace: the workspace name, time zone and default language,
 * and its working hours with "Copy Monday to weekdays". One draft for the
 * whole section, saved from the shared Unsaved changes bar.
 *
 * Storage is reused, never duplicated: name and default language live on the
 * workspace (PUT /api/account/workspace); time zone and working hours are the
 * inbox settings Inbox › Working hours also edits (PUT /api/inbox/settings,
 * sending only that card's own fields). Everyone reads; owners and admins save.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';
import { Copy, Loader2, Plus, Trash2 } from 'lucide-react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { authFetch } from '@/lib/auth/client';
import { syncLocale } from '@/lib/i18n/locale-client';
import { APP_LOCALES, type AppLocale } from '@/lib/i18n/locales';
import type { WorkspaceInboxSettings } from '@/lib/inbox/inbox-settings';
import { MAX_RANGES_PER_DAY, WEEKDAYS, type TimeRange, type Weekday, type WorkingHours } from '@/lib/inbox/working-hours';
import { workingHoursBody } from './inbox/working-hours-card';
import { SettingsPanelHead } from './settings-panel-head';
import { SettingsPanel, SettingsRow } from './settings-row';
import { useSettingsDraft } from './settings-draft';

interface Draft {
  name: string;
  default_language: AppLocale | null;
  timezone: string;
  working_hours: WorkingHours;
}

const DEFAULT_RANGE: TimeRange = { start: '09:00', end: '18:00' };
const selectClass = 'border-border bg-muted text-foreground h-9 w-full rounded-md border px-2 text-sm sm:max-w-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring';

function timeZones(): string[] {
  try {
    return (Intl as unknown as { supportedValuesOf?: (key: string) => string[] }).supportedValuesOf?.('timeZone') ?? [];
  } catch {
    return [];
  }
}

const sameDraft = (a: Draft | null, b: Draft | null) => JSON.stringify(a) === JSON.stringify(b);

/** Copy Monday's ranges to Tuesday through Friday (pure). */
export function copyMondayToWeekdays(hours: WorkingHours): WorkingHours {
  const monday = hours.mon ?? [];
  return { ...hours, tue: monday.map((r) => ({ ...r })), wed: monday.map((r) => ({ ...r })), thu: monday.map((r) => ({ ...r })), fri: monday.map((r) => ({ ...r })) };
}

/** Field errors keyed by "name" or "<day>.<index>" (pure). */
export function workspaceErrors(draft: Draft): Record<string, 'nameRequired' | 'closeAfterOpen'> {
  const errors: Record<string, 'nameRequired' | 'closeAfterOpen'> = {};
  if (!draft.name.trim()) errors.name = 'nameRequired';
  for (const day of WEEKDAYS)
    (draft.working_hours[day] ?? []).forEach((range, i) => {
      if (!range.start || !range.end || range.start >= range.end) errors[`${day}.${i}`] = 'closeAfterOpen';
    });
  return errors;
}

export function WorkspaceSection() {
  const t = useTranslations('SettingsRedesign.workspace');
  const tHours = useTranslations('Settings.workingHours');
  const tDay = useTranslations('Weekdays');
  const tLang = useTranslations('SettingsRedesign.languages');
  const router = useRouter();
  const shownLocale = useLocale();
  const zones = useMemo(timeZones, []);

  const [inbox, setInbox] = useState<WorkspaceInboxSettings | null>(null);
  const [saved, setSaved] = useState<Draft | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [canEdit, setCanEdit] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const [saving, setSaving] = useState(false);
  const [showErrors, setShowErrors] = useState(false);

  useEffect(() => {
    let live = true;
    Promise.all([
      authFetch('/api/account/workspace', { cache: 'no-store' }).then((r) => { if (!r.ok) throw new Error(); return r.json(); }),
      authFetch('/api/inbox/settings', { cache: 'no-store' }).then((r) => { if (!r.ok) throw new Error(); return r.json(); }),
    ])
      .then(([ws, ib]: [{ workspace: { name: string; default_language: AppLocale | null }; can_edit: boolean }, { settings: WorkspaceInboxSettings }]) => {
        if (!live) return;
        const next: Draft = {
          name: ws.workspace.name,
          default_language: ws.workspace.default_language,
          timezone: ib.settings.timezone,
          working_hours: ib.settings.working_hours ?? {},
        };
        setInbox(ib.settings);
        setSaved(next);
        setDraft(next);
        setCanEdit(ws.can_edit);
      })
      .catch(() => { if (live) setLoadFailed(true); });
    return () => { live = false; };
  }, []);

  const errors = draft ? workspaceErrors(draft) : {};
  const dirty = canEdit && !sameDraft(draft, saved);

  const save = useCallback(async () => {
    if (!draft || !saved || !inbox) return false;
    if (Object.keys(workspaceErrors(draft)).length) {
      setShowErrors(true);
      toast.error(t('checkFields'));
      return false;
    }
    setSaving(true);
    try {
      const workspaceChanged = draft.name.trim() !== saved.name || draft.default_language !== saved.default_language;
      const hoursChanged = draft.timezone !== saved.timezone || JSON.stringify(draft.working_hours) !== JSON.stringify(saved.working_hours);
      let next = { ...saved };
      if (workspaceChanged) {
        const res = await authFetch('/api/account/workspace', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: draft.name.trim(), default_language: draft.default_language }),
        });
        const body = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(t('saveFailed'));
        next = { ...next, name: body.workspace.name, default_language: body.workspace.default_language };
      }
      if (hoursChanged) {
        const res = await authFetch('/api/inbox/settings', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            ...workingHoursBody(inbox),
            timezone: draft.timezone.trim(),
            working_hours: Object.fromEntries(WEEKDAYS.map((d) => [d, draft.working_hours[d] ?? []])),
          }),
        });
        const body = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(typeof body.error === 'string' ? body.error : t('saveFailed'));
        setInbox(body.settings);
        next = { ...next, timezone: body.settings.timezone, working_hours: body.settings.working_hours ?? {} };
      }
      setSaved(next);
      setDraft(next);
      setShowErrors(false);
      toast.success(t('saved'));
      if (workspaceChanged && draft.default_language !== saved.default_language) {
        const locale = await syncLocale();
        if (locale && locale.effective !== shownLocale) router.refresh();
      }
      return true;
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('saveFailed'));
      return false;
    } finally {
      setSaving(false);
    }
  }, [draft, saved, inbox, router, t, shownLocale]);

  const discard = useCallback(() => {
    setDraft(saved);
    setShowErrors(false);
  }, [saved]);

  useSettingsDraft('workspace', { dirty, saving, save, discard });

  const setDay = (day: Weekday, ranges: TimeRange[]) =>
    setDraft((d) => (d ? { ...d, working_hours: { ...d.working_hours, [day]: ranges } } : d));
  const err = (key: string) => (showErrors && errors[key] ? t(`errors.${errors[key]}`) : null);
  const editable = canEdit && !saving;

  return (
    <section className="max-w-3xl animate-in fade-in-50 duration-200">
      <SettingsPanelHead title={t('title')} description={t('description')} />
      {loadFailed ? (
        <p role="alert" className="text-sm text-destructive">{t('loadFailed')}</p>
      ) : !draft ? (
        <Loader2 className="size-5 animate-spin text-primary" aria-label={t('loading')} />
      ) : (
        <div className="space-y-8">
          {!canEdit && <p className="text-sm text-muted-foreground">{t('adminsOnly')}</p>}
          <SettingsPanel>
            <SettingsRow label={t('name')} hint={t('nameHint')} htmlFor="workspace-name" error={err('name')} errorId="workspace-name-error">
              <Input
                id="workspace-name"
                value={draft.name}
                maxLength={80}
                disabled={!editable}
                aria-invalid={Boolean(err('name'))}
                aria-describedby={err('name') ? 'workspace-name-error' : undefined}
                onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                className="bg-muted sm:max-w-xs"
              />
            </SettingsRow>
            <SettingsRow label={tHours('timezone')} hint={t('timezoneHint')} htmlFor="workspace-timezone">
              <Input
                id="workspace-timezone"
                list="workspace-timezones"
                value={draft.timezone}
                maxLength={64}
                disabled={!editable}
                onChange={(e) => setDraft({ ...draft, timezone: e.target.value })}
                className="bg-muted sm:max-w-xs"
              />
              <datalist id="workspace-timezones">
                {zones.map((zone) => <option key={zone} value={zone} />)}
              </datalist>
            </SettingsRow>
            <SettingsRow label={t('language')} hint={t('languageHint')} htmlFor="workspace-language">
              <select
                id="workspace-language"
                className={selectClass}
                value={draft.default_language ?? ''}
                disabled={!editable}
                onChange={(e) => setDraft({ ...draft, default_language: (e.target.value || null) as AppLocale | null })}
              >
                <option value="">{t('languageUnset')}</option>
                {APP_LOCALES.map((code) => <option key={code} value={code}>{tLang(code)}</option>)}
              </select>
            </SettingsRow>
          </SettingsPanel>

          <section aria-labelledby="workspace-hours-title" className="space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 id="workspace-hours-title" className="text-base font-semibold text-foreground">{tHours('hours')}</h3>
              {canEdit && (
                <Button type="button" variant="outline" size="sm" disabled={!editable}
                  onClick={() => { setDraft({ ...draft, working_hours: copyMondayToWeekdays(draft.working_hours) }); toast.success(t('copied')); }}>
                  <Copy className="size-3.5" /> {t('copyMonday')}
                </Button>
              )}
            </div>
            <p className="text-xs text-muted-foreground">{t('hoursHint')}</p>
            <SettingsPanel>
              {WEEKDAYS.map((day) => {
                const ranges = draft.working_hours[day] ?? [];
                return (
                  <div key={day} className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-start sm:gap-4">
                    <label className="flex w-40 shrink-0 items-center gap-3 text-sm font-medium text-foreground sm:pt-1.5">
                      <Switch
                        checked={ranges.length > 0}
                        disabled={!editable}
                        onCheckedChange={(open) => setDay(day, open ? [DEFAULT_RANGE] : [])}
                        aria-label={tHours('openOn', { day: tDay(day) })}
                      />
                      {tDay(day)}
                    </label>
                    <div className="min-w-0 flex-1 space-y-2">
                      {ranges.length === 0 && <p className="py-1.5 text-sm text-muted-foreground">{tHours('closed')}</p>}
                      {ranges.map((range, i) => (
                        <div key={i}>
                          <div className="flex flex-wrap items-center gap-2">
                            <Input type="time" aria-label={tHours('opensAt', { day: tDay(day) })} value={range.start} disabled={!editable}
                              onChange={(e) => setDay(day, ranges.map((r, j) => (j === i ? { ...r, start: e.target.value } : r)))}
                              className="w-32 bg-muted" />
                            <span className="text-xs text-muted-foreground">{tHours('to')}</span>
                            <Input type="time" aria-label={tHours('closesAt', { day: tDay(day) })}
                              aria-invalid={Boolean(err(`${day}.${i}`))}
                              value={range.end === '24:00' ? '23:59' : range.end} disabled={!editable}
                              onChange={(e) => setDay(day, ranges.map((r, j) => (j === i ? { ...r, end: e.target.value === '23:59' ? '24:00' : e.target.value } : r)))}
                              className="w-32 bg-muted" />
                            {editable && (
                              <Button type="button" variant="ghost" size="icon-sm" aria-label={tHours('removeRange')}
                                onClick={() => setDay(day, ranges.filter((_, j) => j !== i))}>
                                <Trash2 className="size-3.5" />
                              </Button>
                            )}
                          </div>
                          {err(`${day}.${i}`) && <p role="alert" className="mt-1 text-xs text-destructive">{err(`${day}.${i}`)}</p>}
                        </div>
                      ))}
                      {editable && ranges.length > 0 && ranges.length < MAX_RANGES_PER_DAY && ranges[ranges.length - 1].end < '23:59' && (
                        <Button type="button" variant="ghost" size="sm"
                          onClick={() => setDay(day, [...ranges, { start: ranges[ranges.length - 1].end, end: '24:00' }])}>
                          <Plus className="size-3.5" /> {tHours('addRange')}
                        </Button>
                      )}
                    </div>
                  </div>
                );
              })}
            </SettingsPanel>
          </section>
        </div>
      )}
    </section>
  );
}
