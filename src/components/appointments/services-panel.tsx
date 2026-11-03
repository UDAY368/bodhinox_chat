'use client';

/**
 * Services: duration, break, slot step, capacity, price, mode, meeting link
 * (online only), bookable weekdays with the "Monday only" preset, feedback and
 * rebooking follow-ups, and who offers the service where (a shared calendar or
 * named practitioners per location, never both). Advance payment is shown but
 * disabled until payments support it.
 */
import { useState } from 'react';
import { toast } from 'sonner';
import { useLocale, useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { WEEKDAYS } from '@/lib/inbox/working-hours';
import {
  apiRequest, formatPrice, fromMinor, selectClass, toMinor, useFailureText,
  type AppointmentConfig, type ServiceDto,
} from './shared';

export interface ServiceDraft {
  name: string; mode: 'offline' | 'online'; duration: string; buffer: string; step: string; capacity: string;
  price: string; currency: string; weekdays: number[] | null; meetingUrl: string; feedbackDelay: string; rebookAfter: string;
}

export const EMPTY_SERVICE: ServiceDraft = {
  name: '', mode: 'offline', duration: '30', buffer: '0', step: '', capacity: '1', price: '', currency: '', weekdays: null,
  meetingUrl: '', feedbackDelay: '', rebookAfter: '',
};

const toDraft = (s: ServiceDto): ServiceDraft => ({
  name: s.name, mode: s.mode, duration: String(s.duration_minutes), buffer: String(s.buffer_minutes),
  step: s.slot_step_minutes == null ? '' : String(s.slot_step_minutes), capacity: String(s.capacity),
  price: fromMinor(s.price_minor, s.currency), currency: s.currency ?? '', weekdays: s.allowed_weekdays,
  meetingUrl: s.meeting_url ?? '', feedbackDelay: s.feedback_delay_minutes == null ? '' : String(s.feedback_delay_minutes),
  rebookAfter: s.rebook_after_days == null ? '' : String(s.rebook_after_days),
});

const optNum = (v: string) => (v.trim() === '' ? null : Number(v));

/** The request body for a draft, or the name of the first invalid field (pure; tested). */
export function serviceBody(d: ServiceDraft): { body: Record<string, unknown> } | { invalid: string } {
  const currency = d.currency.trim().toUpperCase() || null;
  const price = toMinor(d.price, currency);
  if (price === undefined) return { invalid: 'price_minor' };
  if (price !== null && !currency) return { invalid: 'currency' };
  if (d.weekdays && d.weekdays.length === 0) return { invalid: 'allowed_weekdays' };
  return {
    body: {
      name: d.name.trim(), mode: d.mode, duration_minutes: Number(d.duration), buffer_minutes: Number(d.buffer || 0),
      slot_step_minutes: optNum(d.step), capacity: Number(d.capacity || 1), price_minor: price, currency: price === null ? null : currency,
      allowed_weekdays: d.weekdays,
      meeting_url: d.mode === 'online' && d.meetingUrl.trim() ? d.meetingUrl.trim() : null,
      feedback_delay_minutes: optNum(d.feedbackDelay), rebook_after_days: optNum(d.rebookAfter),
    },
  };
}

export function ServicesPanel({ config, canEdit, onChanged }: { config: AppointmentConfig; canEdit: boolean; onChanged: () => void }) {
  const t = useTranslations('Appointments');
  const tDay = useTranslations('Weekdays');
  const locale = useLocale();
  const failureText = useFailureText();
  const [editing, setEditing] = useState<ServiceDto | 'new' | null>(null);
  const [draft, setDraft] = useState<ServiceDraft>(EMPTY_SERVICE);
  const [busy, setBusy] = useState(false);
  const set = <K extends keyof ServiceDraft>(k: K) => (v: ServiceDraft[K]) => setDraft((d) => ({ ...d, [k]: v }));

  const open = (s: ServiceDto | 'new') => {
    setDraft(s === 'new' ? EMPTY_SERVICE : toDraft(s));
    setEditing(s);
  };

  async function save() {
    const parsed = serviceBody(draft);
    if ('invalid' in parsed) return void toast.error(t('fieldErrors.invalid'));
    setBusy(true);
    const r = editing === 'new'
      ? await apiRequest('/api/appointments/services', { method: 'POST', body: parsed.body })
      : await apiRequest(`/api/appointments/services/${(editing as ServiceDto).id}`, { method: 'PATCH', body: parsed.body });
    setBusy(false);
    if (!r.ok) return void toast.error(failureText(r));
    toast.success(t('sheet.saved'));
    setEditing(null);
    onChanged();
  }

  async function archive(s: ServiceDto, archived: boolean) {
    const r = await apiRequest(`/api/appointments/services/${s.id}`, { method: 'PATCH', body: { archived } });
    if (!r.ok) return void toast.error(failureText(r));
    onChanged();
  }

  const toggleDay = (day: number, on: boolean) => {
    const base = draft.weekdays ?? [1, 2, 3, 4, 5, 6, 7];
    const next = on ? [...new Set([...base, day])].sort() : base.filter((d) => d !== day);
    set('weekdays')(next.length === 7 ? null : next);
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">{t('services.title')}</h2>
        {canEdit && <Button type="button" size="sm" onClick={() => open('new')}>{t('services.add')}</Button>}
      </div>
      {config.services.length === 0 && <p className="text-sm text-muted-foreground">{t('services.empty')}</p>}
      <ul className="space-y-3">
        {config.services.map((s) => (
          <li key={s.id} className="rounded-lg border border-border bg-card p-3 text-sm">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-medium">{s.name}</span>
              <span className="text-xs text-muted-foreground">
                {t(`services.modes.${s.mode}`)} · {s.duration_minutes}′ · {formatPrice(s.price_minor, s.currency, locale) ?? t('services.free')}
                {s.allowed_weekdays ? ` · ${s.allowed_weekdays.map((d) => tDay(WEEKDAYS[d - 1])).join(', ')}` : ''}
              </span>
              {s.archived_at && <span className="text-xs text-muted-foreground">({t('services.archived')})</span>}
              {canEdit && (
                <span className="ml-auto flex gap-1">
                  {!s.archived_at && <Button type="button" size="sm" variant="ghost" onClick={() => open(s)}>{t('form.edit')}</Button>}
                  <Button type="button" size="sm" variant="ghost" onClick={() => void archive(s, !s.archived_at)}>
                    {s.archived_at ? t('services.restore') : t('services.archive')}
                  </Button>
                </span>
              )}
            </div>
            {!s.archived_at && <OfferingsEditor service={s} config={config} canEdit={canEdit} onChanged={onChanged} />}
          </li>
        ))}
      </ul>

      <Dialog open={editing !== null} onOpenChange={(v) => { if (!v) setEditing(null); }}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
          <DialogHeader><DialogTitle>{editing === 'new' ? t('services.add') : t('services.title')}</DialogTitle></DialogHeader>
          <div className="grid gap-3 text-sm sm:grid-cols-2">
            <Field label={t('services.name')} id="svc-name" wide>
              <Input id="svc-name" maxLength={120} value={draft.name} onChange={(e) => set('name')(e.target.value)} />
            </Field>
            <Field label={t('services.mode')} id="svc-mode">
              <select id="svc-mode" className={selectClass} value={draft.mode} onChange={(e) => set('mode')(e.target.value as ServiceDraft['mode'])}>
                <option value="offline">{t('services.modes.offline')}</option>
                <option value="online">{t('services.modes.online')}</option>
              </select>
            </Field>
            <Field label={t('services.duration')} id="svc-duration">
              <Input id="svc-duration" type="number" min={5} max={480} value={draft.duration} onChange={(e) => set('duration')(e.target.value)} />
            </Field>
            <Field label={t('services.buffer')} id="svc-buffer">
              <Input id="svc-buffer" type="number" min={0} max={240} value={draft.buffer} onChange={(e) => set('buffer')(e.target.value)} />
            </Field>
            <Field label={t('services.step')} id="svc-step" help={t('services.stepHelp')}>
              <Input id="svc-step" type="number" min={5} max={480} value={draft.step} onChange={(e) => set('step')(e.target.value)} />
            </Field>
            <Field label={t('services.capacity')} id="svc-capacity">
              <Input id="svc-capacity" type="number" min={1} max={200} value={draft.capacity} onChange={(e) => set('capacity')(e.target.value)} />
            </Field>
            <Field label={t('services.price')} id="svc-price">
              <Input id="svc-price" inputMode="decimal" placeholder={t('services.free')} value={draft.price} onChange={(e) => set('price')(e.target.value)} />
            </Field>
            <Field label={t('services.currency')} id="svc-currency">
              <Input id="svc-currency" maxLength={3} placeholder="INR" value={draft.currency} onChange={(e) => set('currency')(e.target.value.toUpperCase())} />
            </Field>
            {draft.mode === 'online' && (
              <Field label={t('services.meetingUrl')} id="svc-meeting" help={t('services.meetingUrlHelp')} wide>
                <Input id="svc-meeting" type="url" placeholder="https://" maxLength={2048} value={draft.meetingUrl} onChange={(e) => set('meetingUrl')(e.target.value)} />
              </Field>
            )}
            <div className="space-y-2 sm:col-span-2">
              <Label>{t('services.allowedWeekdays')}</Label>
              <div className="flex flex-wrap gap-3">
                {WEEKDAYS.map((day, i) => (
                  <label key={day} className="flex items-center gap-1.5">
                    <Checkbox checked={draft.weekdays === null || draft.weekdays.includes(i + 1)}
                      onCheckedChange={(v) => toggleDay(i + 1, !!v)} />
                    {tDay(day)}
                  </label>
                ))}
              </div>
              <div className="flex flex-wrap gap-2">
                <Button type="button" size="sm" variant="outline" onClick={() => set('weekdays')(null)}>{t('services.allDays')}</Button>
                <Button type="button" size="sm" variant="outline" onClick={() => { set('weekdays')([1]); set('mode')('offline'); }}>
                  {t('services.mondayPreset')}
                </Button>
              </div>
            </div>
            <Field label={t('services.feedbackDelay')} id="svc-feedback">
              <Input id="svc-feedback" type="number" min={0} max={10080} value={draft.feedbackDelay} onChange={(e) => set('feedbackDelay')(e.target.value)} />
            </Field>
            <Field label={t('services.rebookAfter')} id="svc-rebook">
              <Input id="svc-rebook" type="number" min={1} max={365} value={draft.rebookAfter} onChange={(e) => set('rebookAfter')(e.target.value)} />
            </Field>
            <label className="flex items-center gap-2 text-muted-foreground sm:col-span-2">
              <Switch checked={false} disabled aria-label={t('services.paymentRequired')} />
              {t('services.paymentRequired')} <span className="text-xs">({t('services.paymentComingSoon')})</span>
            </label>
          </div>
          <DialogFooter>
            <Button type="button" disabled={busy || !draft.name.trim()} onClick={() => void save()}>{t('sheet.save')}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function Field({ label, id, help, wide, children }: { label: string; id: string; help?: string; wide?: boolean; children: React.ReactNode }) {
  return (
    <div className={wide ? 'space-y-1 sm:col-span-2' : 'space-y-1'}>
      <Label htmlFor={id}>{label}</Label>
      {children}
      {help && <p className="text-[11px] text-muted-foreground">{help}</p>}
    </div>
  );
}

/** Per location: not offered, a shared calendar, or named practitioners. */
function OfferingsEditor({
  service, config, canEdit, onChanged,
}: { service: ServiceDto; config: AppointmentConfig; canEdit: boolean; onChanged: () => void }) {
  const t = useTranslations('Appointments');
  const failureText = useFailureText();
  const [busy, setBusy] = useState<string | null>(null);
  const locations = config.locations.filter((l) => !l.archived_at);
  const staff = config.staff.filter((s) => !s.archived_at);
  if (locations.length === 0) return null;

  async function put(locationId: string, pooled: boolean, staffIds: string[]) {
    setBusy(locationId);
    const r = await apiRequest('/api/appointments/offerings', {
      method: 'PUT', body: { service_id: service.id, location_id: locationId, pooled, staff_ids: pooled ? [] : staffIds },
    });
    setBusy(null);
    if (!r.ok) return void toast.error(failureText(r));
    onChanged();
  }

  return (
    <div className="mt-3 space-y-2 border-t border-border pt-2">
      <div className="text-xs font-medium text-muted-foreground">{t('services.offerings')}</div>
      {locations.map((loc) => {
        const rows = config.offerings.filter((o) => o.service_id === service.id && o.location_id === loc.id);
        const pooled = rows.some((o) => o.staff_id === null);
        const staffIds = rows.filter((o) => o.staff_id).map((o) => o.staff_id as string);
        const disabled = !canEdit || busy === loc.id;
        return (
          <div key={loc.id} className="flex flex-wrap items-center gap-3 text-xs">
            <span className="w-32 truncate font-medium">{loc.name}</span>
            <label className="flex items-center gap-1.5">
              <Checkbox checked={pooled} disabled={disabled} onCheckedChange={(v) => void put(loc.id, !!v, [])} />
              {t('services.pooled')}
            </label>
            {!pooled && staff.map((s) => (
              <label key={s.id} className="flex items-center gap-1.5">
                <Checkbox checked={staffIds.includes(s.id)} disabled={disabled}
                  onCheckedChange={(v) => void put(loc.id, false, v ? [...staffIds, s.id] : staffIds.filter((x) => x !== s.id))} />
                {s.display_name}
              </label>
            ))}
          </div>
        );
      })}
      {canEdit && <p className="text-[11px] text-muted-foreground">{t('services.offeringConflict')}</p>}
    </div>
  );
}
