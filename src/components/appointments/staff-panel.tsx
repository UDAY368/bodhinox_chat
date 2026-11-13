'use client';

/**
 * Practitioners (optionally linked to a team member, within the plan's
 * appointment_staff limit) and weekly hours per practitioner (or the shared
 * calendar) at each location.
 */
import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { parseWorkingHours, type WorkingHours } from '@/lib/inbox/working-hours';
import { compactHours, WeeklyHoursEditor } from './hours-editor';
import {
  apiRequest, memberLabel, selectClass, useFailureText, useMembers, type AppointmentConfig, type StaffDto,
} from './shared';

interface HoursDto { id: string; staff_id: string | null; location_id: string; hours: WorkingHours }
/** Phase 9: the practitioner's Zoom host (null: the Zoom user who connected the workspace hosts). */
type StaffWithHostDto = StaffDto & { meeting_host_email?: string | null };

/** Whether this workspace has a live Zoom connection (the host email only matters then). */
function useZoomConnected(): boolean {
  const [connected, setConnected] = useState(false);
  useEffect(() => {
    let live = true;
    void apiRequest<{ available?: boolean; connected?: boolean }>('/api/integrations/zoom').then((r) => {
      if (live) setConnected(r.ok && r.data.available === true && r.data.connected === true);
    });
    return () => { live = false; };
  }, []);
  return connected;
}

function ZoomHostEmail({ staff, canEdit, onSave }: { staff: StaffWithHostDto; canEdit: boolean; onSave: (email: string | null) => Promise<void> }) {
  const t = useTranslations('Appointments');
  const stored = staff.meeting_host_email ?? '';
  const [value, setValue] = useState(stored);
  const [busy, setBusy] = useState(false);
  const id = `zoom-host-${staff.id}`;
  return (
    <div className="flex w-full flex-wrap items-end gap-2">
      <div className="min-w-0 flex-1 space-y-1">
        <Label htmlFor={id} className="text-xs">{t('staff.zoomHostEmail')}</Label>
        <Input id={id} type="email" maxLength={254} className="h-8" placeholder={t('staff.zoomHostPlaceholder')} value={value}
          disabled={!canEdit || busy || !!staff.archived_at} onChange={(e) => setValue(e.target.value)} />
      </div>
      {canEdit && value.trim() !== stored && (
        <Button type="button" size="sm" variant="outline" disabled={busy}
          onClick={() => { setBusy(true); void onSave(value.trim() || null).finally(() => setBusy(false)); }}>{t('sheet.save')}</Button>
      )}
    </div>
  );
}

export function StaffPanel({ config, canEdit, onChanged }: { config: AppointmentConfig; canEdit: boolean; onChanged: () => void }) {
  const t = useTranslations('Appointments');
  const failureText = useFailureText();
  const members = useMembers();
  const [name, setName] = useState('');
  const [linked, setLinked] = useState('');
  const [busy, setBusy] = useState(false);
  const zoomConnected = useZoomConnected();

  async function add() {
    setBusy(true);
    const r = await apiRequest('/api/appointments/staff', { method: 'POST', body: { display_name: name.trim(), user_id: linked || null } });
    setBusy(false);
    if (!r.ok) return void toast.error(r.status === 402 ? t('staff.limitReachedGeneric') : failureText(r));
    setName('');
    setLinked('');
    onChanged();
  }

  async function update(s: StaffDto, body: Record<string, unknown>) {
    const r = await apiRequest(`/api/appointments/staff/${s.id}`, { method: 'PATCH', body });
    if (!r.ok) return void toast.error(r.status === 402 ? t('staff.limitReachedGeneric') : failureText(r));
    onChanged();
  }

  return (
    <div className="space-y-6">
      <section className="space-y-3">
        <h2 className="text-base font-semibold tracking-tight">{t('staff.title')}</h2>
        {config.staff.length === 0 && <p className="text-sm text-muted-foreground">{t('staff.empty')}</p>}
        <ul className="divide-y divide-border rounded-xl border border-border bg-card text-sm">
          {config.staff.map((s) => (
            <li key={s.id} className="flex flex-wrap items-center gap-2 p-3">
              <span className="font-medium">{s.display_name}</span>
              {s.archived_at && <span className="text-xs text-muted-foreground">({t('services.archived')})</span>}
              <select aria-label={t('staff.linkedMember')} className={`${selectClass} ml-auto w-48`} disabled={!canEdit || !!s.archived_at}
                value={s.user_id ?? ''} onChange={(e) => void update(s, { user_id: e.target.value || null })}>
                <option value="">{t('staff.noMember')}</option>
                {members.map((m) => <option key={m.user_id} value={m.user_id}>{memberLabel(m)}</option>)}
              </select>
              {canEdit && (
                <Button type="button" size="sm" variant="ghost" onClick={() => void update(s, { archived: !s.archived_at })}>
                  {s.archived_at ? t('services.restore') : t('staff.archive')}
                </Button>
              )}
              {zoomConnected && (
                <ZoomHostEmail key={(s as StaffWithHostDto).meeting_host_email ?? ''} staff={s as StaffWithHostDto} canEdit={canEdit}
                  onSave={(email) => update(s, { meeting_host_email: email })} />
              )}
            </li>
          ))}
        </ul>
        {canEdit && (
          <div className="flex flex-wrap items-end gap-2">
            <div className="space-y-1">
              <Label htmlFor="staff-name">{t('staff.name')}</Label>
              <Input id="staff-name" maxLength={80} value={name} onChange={(e) => setName(e.target.value)} />
            </div>
            <div className="space-y-1">
              <Label htmlFor="staff-member">{t('staff.linkedMember')}</Label>
              <select id="staff-member" className={`${selectClass} w-48`} value={linked} onChange={(e) => setLinked(e.target.value)}>
                <option value="">{t('staff.noMember')}</option>
                {members.map((m) => <option key={m.user_id} value={m.user_id}>{memberLabel(m)}</option>)}
              </select>
            </div>
            <Button type="button" disabled={busy || !name.trim()} onClick={() => void add()}>{t('staff.add')}</Button>
          </div>
        )}
        {zoomConnected && <p className="text-xs text-muted-foreground">{t('staff.zoomHostHelp')}</p>}
      </section>

      <HoursSection config={config} canEdit={canEdit} />
    </div>
  );
}

function HoursSection({ config, canEdit }: { config: AppointmentConfig; canEdit: boolean }) {
  const t = useTranslations('Appointments');
  const failureText = useFailureText();
  const locations = config.locations.filter((l) => !l.archived_at);
  const staff = config.staff.filter((s) => !s.archived_at);
  const [rows, setRows] = useState<HoursDto[]>([]);
  const [locationId, setLocationId] = useState(locations[0]?.id ?? '');
  const [staffId, setStaffId] = useState('');
  const [hours, setHours] = useState<WorkingHours>({});
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const r = await apiRequest<{ hours: HoursDto[] }>('/api/appointments/hours');
    if (r.ok) setRows(r.data.hours ?? []);
  }, []);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  // Show the stored hours of the chosen (practitioner or pool, location).
  useEffect(() => {
    const row = rows.find((h) => h.location_id === locationId && (h.staff_id ?? '') === staffId);
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setHours(row ? (parseWorkingHours(row.hours) ?? {}) : {});
  }, [rows, locationId, staffId]);

  async function save(clear: boolean) {
    setBusy(true);
    const r = await apiRequest('/api/appointments/hours', {
      method: 'PUT', body: { location_id: locationId, staff_id: staffId || null, hours: clear ? null : compactHours(hours) },
    });
    setBusy(false);
    if (!r.ok) return void toast.error(failureText(r));
    toast.success(t('sheet.saved'));
    void load();
  }

  if (locations.length === 0) return null;
  const location = locations.find((l) => l.id === locationId);
  return (
    <section className="space-y-3">
      <h2 className="text-base font-semibold tracking-tight">{t('staff.hours')}</h2>
      <div className="flex flex-wrap gap-2">
        <select aria-label={t('sheet.location')} className={`${selectClass} w-48`} value={locationId} onChange={(e) => setLocationId(e.target.value)}>
          {locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
        </select>
        <select aria-label={t('sheet.practitioner')} className={`${selectClass} w-48`} value={staffId} onChange={(e) => setStaffId(e.target.value)}>
          <option value="">{t('staff.poolHours')}</option>
          {staff.map((s) => <option key={s.id} value={s.id}>{s.display_name}</option>)}
        </select>
      </div>
      {location && <p className="text-xs text-muted-foreground">{t('staff.hoursAt', { location: location.name })} · {location.timezone}</p>}
      <WeeklyHoursEditor hours={hours} onChange={setHours} disabled={!canEdit || busy} />
      {canEdit && (
        <div className="flex gap-2">
          <Button type="button" disabled={busy || !locationId} onClick={() => void save(false)}>{t('sheet.save')}</Button>
          <Button type="button" variant="outline" disabled={busy || !locationId} onClick={() => void save(true)}>{t('staff.clearHours')}</Button>
        </div>
      )}
    </section>
  );
}
