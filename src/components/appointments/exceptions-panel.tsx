'use client';

/**
 * Holidays and exceptions: a local date range at a location (or for one
 * practitioner there), either closed all day or with custom hours that
 * replace that day's ranges. Dates are local dates in the location's zone.
 */
import { CalendarOff, MapPin } from 'lucide-react';
import { useConfirm } from '@/components/ui/confirm-dialog';
import { EmptyState } from '@/components/ui/empty-state';
import { OptionSelect } from '@/components/ui/option-select';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { useLocale, useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { GroupedList, GroupedListRow } from '@/components/ui/grouped-list';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import type { TimeRange } from '@/lib/inbox/working-hours';
import type { ExceptionRow } from '@/lib/appointments/types';
import { localDay } from '@/lib/appointments/time';
import { RangesEditor } from './hours-editor';
import { apiRequest, formatDay, useFailureText, type AppointmentConfig } from './shared';

export function ExceptionsPanel({ config, canEdit }: { config: AppointmentConfig; canEdit: boolean }) {
  const t = useTranslations('Appointments');
  const confirm = useConfirm();
  const locale = useLocale();
  const failureText = useFailureText();
  const locations = config.locations.filter((l) => !l.archived_at);
  const staff = config.staff.filter((s) => !s.archived_at);
  const [rows, setRows] = useState<ExceptionRow[] | null>(null);
  const [locationId, setLocationId] = useState(locations[0]?.id ?? '');
  const tz = locations.find((l) => l.id === locationId)?.timezone ?? 'UTC';
  const [staffId, setStaffId] = useState('');
  const [from, setFrom] = useState(() => localDay(new Date(), tz));
  const [to, setTo] = useState(() => localDay(new Date(), tz));
  const [closed, setClosed] = useState(true);
  const [ranges, setRanges] = useState<TimeRange[]>([{ start: '09:00', end: '13:00' }]);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);

  const [version, setVersion] = useState(0);
  const load = () => setVersion((v) => v + 1);
  useEffect(() => {
    let live = true;
    // Current and future exceptions, from today in the location's zone.
    const params = new URLSearchParams({ from: localDay(new Date(), tz) });
    if (locationId) params.set('location_id', locationId);
    void apiRequest<{ exceptions: ExceptionRow[] }>(`/api/appointments/exceptions?${params}`).then((r) => {
      if (live) setRows(r.ok ? r.data.exceptions ?? [] : []);
    });
    return () => {
      live = false;
    };
  }, [locationId, tz, version]);

  async function add() {
    setBusy(true);
    const r = await apiRequest('/api/appointments/exceptions', {
      method: 'POST',
      body: { location_id: locationId, staff_id: staffId || null, starts_on: from, ends_on: to < from ? from : to, ranges: closed ? null : ranges, reason: reason.trim() || null },
    });
    setBusy(false);
    if (!r.ok) return void toast.error(failureText(r));
    setReason('');
    load();
  }

  async function remove(id: string) {
    if (!(await confirm({ title: t('exceptions.deleteConfirm'), confirmLabel: t('exceptions.delete'), destructive: true }))) return;
    const r = await apiRequest(`/api/appointments/exceptions/${id}`, { method: 'DELETE' });
    if (!r.ok) return void toast.error(failureText(r));
    load();
  }

  const staffName = (id: string | null) => (id ? config.staff.find((s) => s.id === id)?.display_name ?? '' : t('exceptions.scopeLocation'));
  if (locations.length === 0) return <EmptyState icon={MapPin} title={t('locations.empty')} />;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-base font-semibold tracking-tight">{t('exceptions.title')}</h2>
        <OptionSelect aria-label={t('sheet.location')} className="ml-auto w-48" value={locationId} onValueChange={setLocationId}
          options={locations.map((l) => ({ value: l.id, label: l.name }))} />
      </div>
      {rows && rows.length === 0 && <EmptyState icon={CalendarOff} title={t('exceptions.empty')} />}
      {!!rows?.length && (
        <GroupedList>
          {rows.map((e) => (
            <GroupedListRow key={e.id}
              title={`${formatDay(e.starts_on, locale)}${e.ends_on !== e.starts_on ? ` – ${formatDay(e.ends_on, locale)}` : ''}`}
              subtitle={`${staffName(e.staff_id)} · ${e.ranges ? e.ranges.map((r) => `${r.start}–${r.end}`).join(', ') : t('exceptions.closed')}${e.reason ? ` · ${e.reason}` : ''}`}
              trailing={canEdit ? (
                <Button type="button" size="sm" variant="ghost" className="-mr-2 min-h-11 text-destructive hover:bg-destructive/10 sm:min-h-8" onClick={() => void remove(e.id)}>
                  {t('exceptions.delete')}
                </Button>
              ) : undefined} />
          ))}
        </GroupedList>
      )}
      {canEdit && (
        <div className="grid gap-3 rounded-xl border border-border p-3 text-sm sm:grid-cols-2">
          <div className="font-medium sm:col-span-2">{t('exceptions.add')}</div>
          <div className="space-y-1">
            <Label htmlFor="exc-scope">{t('exceptions.scope')}</Label>
            <OptionSelect id="exc-scope" value={staffId} onValueChange={setStaffId}
              options={[{ value: '', label: t('exceptions.scopeLocation') }, ...staff.map((s) => ({ value: s.id, label: `${t('exceptions.scopeStaff')}: ${s.display_name}` }))]} />
          </div>
          <div className="space-y-1">
            <Label htmlFor="exc-reason">{t('exceptions.reason')}</Label>
            <Input id="exc-reason" maxLength={120} value={reason} onChange={(e) => setReason(e.target.value)} />
          </div>
          <div className="space-y-1">
            <Label htmlFor="exc-from">{t('exceptions.from')}</Label>
            <Input id="exc-from" type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
          </div>
          <div className="space-y-1">
            <Label htmlFor="exc-to">{t('exceptions.to')}</Label>
            <Input id="exc-to" type="date" min={from} value={to} onChange={(e) => setTo(e.target.value)} />
          </div>
          <div className="flex gap-4 sm:col-span-2">
            <label className="flex items-center gap-1.5"><input type="radio" checked={closed} onChange={() => setClosed(true)} /> {t('exceptions.closed')}</label>
            <label className="flex items-center gap-1.5"><input type="radio" checked={!closed} onChange={() => setClosed(false)} /> {t('exceptions.customHours')}</label>
          </div>
          {!closed && <div className="sm:col-span-2"><RangesEditor ranges={ranges} onChange={setRanges} label={t('exceptions.customHours')} /></div>}
          <div className="sm:col-span-2">
            <Button type="button" size="sm" disabled={busy || !from || (!closed && ranges.length === 0)} onClick={() => void add()}>{t('exceptions.add')}</Button>
          </div>
        </div>
      )}
    </div>
  );
}
