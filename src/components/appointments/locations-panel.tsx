'use client';

/** Locations: name, address, type and the IANA time zone every booking time is checked in. */
import { MapPin } from 'lucide-react';
import { EmptyState } from '@/components/ui/empty-state';
import { SegmentedControl } from '@/components/ui/segmented-control';
import { OptionSelect } from '@/components/ui/option-select';
import { useMemo, useState } from 'react';
import { toast } from 'sonner';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { GroupedList, GroupedListRow } from '@/components/ui/grouped-list';
import { Sheet, SheetContent, SheetFooter, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { currentZoneName } from '@/lib/appointments/time-zone-names';
import { apiRequest, browserZone, useFailureText, type AppointmentConfig, type LocationDto } from './shared';

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

  const current = editing && editing !== 'new' ? config.locations.find((l) => l.id === editing) ?? null : null;

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="text-base font-semibold tracking-tight">{t('locations.title')}</h2>
        {canEdit && <Button type="button" className="min-h-11 sm:min-h-8" size="sm" onClick={() => edit('new')}>{t('locations.add')}</Button>}
      </div>
      {config.locations.length === 0 && <EmptyState icon={MapPin} title={t('locations.empty')} />}
      {config.locations.length > 0 && (
        <GroupedList>
          {config.locations.map((l) => {
            const facts = `${t(`locations.kinds.${l.kind}`)} · ${l.timezone}${l.address ? ` · ${l.address}` : ''}`;
            return l.archived_at ? (
              <GroupedListRow key={l.id} title={<span className="text-muted-foreground">{l.name}</span>}
                subtitle={`${t('services.archived')} · ${facts}`}
                trailing={canEdit ? (
                  <Button type="button" size="sm" variant="ghost" className="-mr-2 min-h-11 sm:min-h-8" onClick={() => void archive(l)}>
                    {t('services.restore')}
                  </Button>
                ) : undefined} />
            ) : (
              <GroupedListRow key={l.id} title={l.name} subtitle={facts} onClick={canEdit ? () => edit(l) : undefined} chevron={canEdit} />
            );
          })}
        </GroupedList>
      )}

      <Sheet open={editing !== null} onOpenChange={(v) => { if (!v) setEditing(null); }}>
        <SheetContent size="md" className="overflow-y-auto">
          <SheetHeader className="pr-12"><SheetTitle>{current ? current.name : t('locations.add')}</SheetTitle></SheetHeader>
          <div className="grid gap-3 px-4 pb-4 text-sm sm:grid-cols-2">
            <div className="space-y-1">
              <Label htmlFor="loc-name">{t('locations.name')}</Label>
              <Input id="loc-name" maxLength={120} value={draft.name} onChange={(e) => set('name')(e.target.value)} />
            </div>
            <div className="space-y-1">
              <p className="text-sm font-medium">{t('locations.kind')}</p>
              <SegmentedControl<Draft['kind']> aria-label={t('locations.kind')} value={draft.kind} onValueChange={set('kind')}
                options={[{ value: 'physical', label: t('locations.kinds.physical') }, { value: 'online', label: t('locations.kinds.online') }]} />
            </div>
            <div className="space-y-1 sm:col-span-2">
              <Label htmlFor="loc-address">{t('locations.address')}</Label>
              <Input id="loc-address" maxLength={500} value={draft.address} onChange={(e) => set('address')(e.target.value)} />
            </div>
            <div className="space-y-1 sm:col-span-2">
              <Label htmlFor="loc-tz">{t('locations.timezone')}</Label>
              {zones.length ? (
                <OptionSelect id="loc-tz" value={draft.timezone} onValueChange={set('timezone')}
                  options={[...(zones.includes(draft.timezone) ? [] : [draft.timezone]), ...zones].map((z) => ({ value: z, label: z }))} />
              ) : <Input id="loc-tz" value={draft.timezone} onChange={(e) => set('timezone')(e.target.value)} />}
              <p className="text-[11px] text-muted-foreground">{t('locations.timezoneHelp')}</p>
            </div>
          </div>
          <SheetFooter className="flex-row flex-wrap justify-end border-t border-border/50">
            {current && (
              <Button type="button" variant="outline" disabled={busy} onClick={() => { void archive(current); setEditing(null); }}>
                {t('locations.archive')}
              </Button>
            )}
            <Button type="button" disabled={busy || !draft.name.trim()} onClick={() => void save()}>{t('sheet.save')}</Button>
          </SheetFooter>
        </SheetContent>
      </Sheet>
    </div>
  );
}
