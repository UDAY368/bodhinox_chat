'use client';

/** Locations: name, address, type and the IANA time zone every booking time is checked in. */
import { useMemo, useState } from 'react';
import { toast } from 'sonner';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { currentZoneName } from '@/lib/appointments/time-zone-names';
import { apiRequest, browserZone, selectClass, useFailureText, type AppointmentConfig, type LocationDto } from './shared';

function timeZones(): string[] {
  try {
    const zones = (Intl as unknown as { supportedValuesOf?: (key: string) => string[] }).supportedValuesOf?.('timeZone') ?? [];
    // Offer the current names (Asia/Kolkata, not Asia/Calcutta), once each.
    return [...new Set(zones.map(currentZoneName))].sort();
  } catch {
    return [];
  }
}

interface Draft { name: string; address: string; timezone: string; kind: 'physical' | 'online' }

export function LocationsPanel({ config, canEdit, onChanged }: { config: AppointmentConfig; canEdit: boolean; onChanged: () => void }) {
  const t = useTranslations('Appointments');
  const failureText = useFailureText();
  const zones = useMemo(() => timeZones(), []);
  const blank = (): Draft => ({ name: '', address: '', timezone: browserZone(), kind: 'physical' });
  const [editing, setEditing] = useState<string | 'new' | null>(null);
  const [draft, setDraft] = useState<Draft>(blank);
  const [busy, setBusy] = useState(false);
  const set = <K extends keyof Draft>(k: K) => (v: Draft[K]) => setDraft((d) => ({ ...d, [k]: v }));

  const edit = (l: LocationDto | 'new') => {
    setDraft(l === 'new' ? blank() : { name: l.name, address: l.address ?? '', timezone: l.timezone, kind: l.kind });
    setEditing(l === 'new' ? 'new' : l.id);
  };

  async function save() {
    setBusy(true);
    const body = { name: draft.name.trim(), address: draft.address.trim() || null, timezone: draft.timezone, kind: draft.kind };
    const r = editing === 'new'
      ? await apiRequest('/api/appointments/locations', { method: 'POST', body })
      : await apiRequest(`/api/appointments/locations/${editing}`, { method: 'PATCH', body });
    setBusy(false);
    if (!r.ok) return void toast.error(failureText(r));
    setEditing(null);
    onChanged();
  }

  async function archive(l: LocationDto) {
    const r = await apiRequest(`/api/appointments/locations/${l.id}`, { method: 'PATCH', body: { archived: !l.archived_at } });
    if (!r.ok) return void toast.error(failureText(r));
    onChanged();
  }

  const form = (
    <div className="grid gap-3 rounded-xl border border-border p-3 text-sm sm:grid-cols-2">
      <div className="space-y-1">
        <Label htmlFor="loc-name">{t('locations.name')}</Label>
        <Input id="loc-name" maxLength={120} value={draft.name} onChange={(e) => set('name')(e.target.value)} />
      </div>
      <div className="space-y-1">
        <Label htmlFor="loc-kind">{t('locations.kind')}</Label>
        <select id="loc-kind" className={selectClass} value={draft.kind} onChange={(e) => set('kind')(e.target.value as Draft['kind'])}>
          <option value="physical">{t('locations.kinds.physical')}</option>
          <option value="online">{t('locations.kinds.online')}</option>
        </select>
      </div>
      <div className="space-y-1 sm:col-span-2">
        <Label htmlFor="loc-address">{t('locations.address')}</Label>
        <Input id="loc-address" maxLength={500} value={draft.address} onChange={(e) => set('address')(e.target.value)} />
      </div>
      <div className="space-y-1 sm:col-span-2">
        <Label htmlFor="loc-tz">{t('locations.timezone')}</Label>
        {zones.length ? (
          <select id="loc-tz" className={selectClass} value={draft.timezone} onChange={(e) => set('timezone')(e.target.value)}>
            {!zones.includes(draft.timezone) && <option value={draft.timezone}>{draft.timezone}</option>}
            {zones.map((z) => <option key={z} value={z}>{z}</option>)}
          </select>
        ) : <Input id="loc-tz" value={draft.timezone} onChange={(e) => set('timezone')(e.target.value)} />}
        <p className="text-[11px] text-muted-foreground">{t('locations.timezoneHelp')}</p>
      </div>
      <div className="flex gap-2 sm:col-span-2">
        <Button type="button" size="sm" disabled={busy || !draft.name.trim()} onClick={() => void save()}>{t('sheet.save')}</Button>
        <Button type="button" size="sm" variant="ghost" onClick={() => setEditing(null)}>{t('sheet.close')}</Button>
      </div>
    </div>
  );

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="text-base font-semibold tracking-tight">{t('locations.title')}</h2>
        {canEdit && editing === null && <Button type="button" size="sm" onClick={() => edit('new')}>{t('locations.add')}</Button>}
      </div>
      {editing === 'new' && form}
      {config.locations.length === 0 && editing !== 'new' && <p className="text-sm text-muted-foreground">{t('locations.empty')}</p>}
      <ul className="space-y-2">
        {config.locations.map((l) => (
          <li key={l.id}>
            {editing === l.id ? form : (
              <div className="flex flex-wrap items-center gap-2 rounded-xl border border-border bg-card p-3 text-sm">
                <span className="font-medium">{l.name}</span>
                <span className="text-xs text-muted-foreground">{t(`locations.kinds.${l.kind}`)} · {l.timezone}{l.address ? ` · ${l.address}` : ''}</span>
                {l.archived_at && <span className="text-xs text-muted-foreground">({t('services.archived')})</span>}
                {canEdit && (
                  <span className="ml-auto flex gap-1">
                    {!l.archived_at && <Button type="button" size="sm" variant="ghost" onClick={() => edit(l)}>{t('form.edit')}</Button>}
                    <Button type="button" size="sm" variant="ghost" onClick={() => void archive(l)}>
                      {l.archived_at ? t('services.restore') : t('locations.archive')}
                    </Button>
                  </span>
                )}
              </div>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
