'use client';

/**
 * Schedule tab: an agenda of appointments grouped by local date, with a day or
 * week window, filters and the period's counts. Each time is shown in the
 * appointment's own zone with its label; the window follows the filtered
 * location's zone (else the first location's).
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { ChevronLeft, ChevronRight, Loader2, Plus } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { AppointmentStatusBadge } from './appointment-status-badge';
import {
  apiRequest, browserZone, FILTER_STATUSES, formatDay, formatTime, groupByLocalDate, scheduleWindow, selectClass,
  type Abilities, type AppointmentConfig,
} from './shared';
import { addDays, localDay, zoneLabel } from '@/lib/appointments/time';
import type { AppointmentStatus } from '@/lib/appointments/types';

export interface ScheduleItem {
  id: string;
  status: AppointmentStatus;
  start_at: string;
  end_at: string;
  timezone: string;
  local_date: string;
  service_name: string;
  service_id: string;
  staff_id: string | null;
  location_id: string;
  contact_id: string | null;
  contact_name: string | null;
  conversation_id: string | null;
  version: number;
}

interface Totals { booked: number; confirmed: number; cancelled: number; completed: number; no_show: number; no_show_rate: number | null }

interface Filters { status: string; staffId: string; locationId: string; serviceId: string; needsOutcome: boolean }
const NO_FILTERS: Filters = { status: '', staffId: '', locationId: '', serviceId: '', needsOutcome: false };

export function ScheduleView({
  config, abilities, onOpen, onNew, refreshKey,
}: {
  config: AppointmentConfig;
  abilities: Abilities;
  onOpen: (id: string) => void;
  onNew: () => void;
  /** Bumped by the page after a change, to reload. */
  refreshKey: number;
}) {
  const t = useTranslations('Appointments');
  const locale = useLocale();
  const [view, setView] = useState<'day' | 'week'>('week');
  const [filters, setFilters] = useState<Filters>(NO_FILTERS);
  const zone = useMemo(() => {
    const chosen = config.locations.find((l) => l.id === filters.locationId);
    return chosen?.timezone ?? config.locations.find((l) => !l.archived_at)?.timezone ?? browserZone();
  }, [config.locations, filters.locationId]);
  const [anchor, setAnchor] = useState(() => localDay(new Date(), zone));
  const [rows, setRows] = useState<ScheduleItem[] | null>(null);
  const [totals, setTotals] = useState<Totals | null>(null);
  const [failed, setFailed] = useState(false);

  const range = useMemo(() => scheduleWindow(view, anchor, zone), [view, anchor, zone]);

  const load = useCallback(async () => {
    setFailed(false);
    const params = new URLSearchParams({ from: range.from.toISOString(), to: range.to.toISOString() });
    if (filters.status) params.set('status', filters.status);
    if (filters.staffId) params.set('staff_id', filters.staffId);
    if (filters.locationId) params.set('location_id', filters.locationId);
    if (filters.serviceId) params.set('service_id', filters.serviceId);
    if (filters.needsOutcome) {
      // "Needs outcome" looks back over the last 60 days, whatever the window.
      params.set('needs_outcome', '1');
      params.set('from', new Date(Date.now() - 60 * 86_400_000).toISOString());
      params.set('to', new Date().toISOString());
    }
    const stats = new URLSearchParams({ from: range.days[0], to: range.days[range.days.length - 1] });
    if (filters.serviceId) stats.set('service_id', filters.serviceId);
    const [list, counts] = await Promise.all([
      apiRequest<{ appointments: ScheduleItem[] }>(`/api/appointments?${params}`),
      apiRequest<{ totals: Totals }>(`/api/appointments/stats?${stats}`),
    ]);
    if (!list.ok) {
      setFailed(true);
      setRows([]);
      return;
    }
    setRows(list.data.appointments ?? []);
    setTotals(counts.ok ? counts.data.totals : null);
  }, [range, filters]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load, refreshKey]);

  const staffName = useMemo(() => new Map(config.staff.map((s) => [s.id, s.display_name])), [config.staff]);
  const locationName = useMemo(() => new Map(config.locations.map((l) => [l.id, l.name])), [config.locations]);
  const set = <K extends keyof Filters>(key: K) => (value: Filters[K]) => setFilters((f) => ({ ...f, [key]: value }));
  const step = view === 'day' ? 1 : 7;
  const groups = useMemo(() => groupByLocalDate(rows ?? []), [rows]);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex rounded-md border border-border">
          {(['day', 'week'] as const).map((v) => (
            <Button key={v} type="button" size="sm" variant={view === v ? 'default' : 'ghost'} onClick={() => setView(v)}>
              {t(`schedule.${v}`)}
            </Button>
          ))}
        </div>
        <Button type="button" variant="ghost" size="icon" aria-label={t('schedule.previous')} onClick={() => setAnchor((d) => addDays(d, -step))}>
          <ChevronLeft className="h-4 w-4" />
        </Button>
        <Button type="button" variant="outline" size="sm" onClick={() => setAnchor(localDay(new Date(), zone))}>{t('schedule.today')}</Button>
        <Button type="button" variant="ghost" size="icon" aria-label={t('schedule.next')} onClick={() => setAnchor((d) => addDays(d, step))}>
          <ChevronRight className="h-4 w-4" />
        </Button>
        <span className="text-sm font-medium">
          {formatDay(range.days[0], locale)}{view === 'week' ? ` – ${formatDay(range.days[6], locale)}` : ''}
        </span>
        <div className="ml-auto">
          {abilities.manage && (
            <Button type="button" size="sm" onClick={onNew}><Plus className="h-4 w-4" /> {t('schedule.newAppointment')}</Button>
          )}
        </div>
      </div>

      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-5">
        <select aria-label={t('schedule.filterStatus')} className={selectClass} value={filters.status} onChange={(e) => set('status')(e.target.value)}>
          <option value="">{t('schedule.filterStatus')}: {t('schedule.all')}</option>
          {FILTER_STATUSES.map((s) => <option key={s} value={s}>{t(`status.${s}`)}</option>)}
        </select>
        <select aria-label={t('schedule.filterService')} className={selectClass} value={filters.serviceId} onChange={(e) => set('serviceId')(e.target.value)}>
          <option value="">{t('schedule.filterService')}: {t('schedule.all')}</option>
          {config.services.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
        <select aria-label={t('schedule.filterStaff')} className={selectClass} value={filters.staffId} onChange={(e) => set('staffId')(e.target.value)}>
          <option value="">{t('schedule.filterStaff')}: {t('schedule.all')}</option>
          {config.staff.map((s) => <option key={s.id} value={s.id}>{s.display_name}</option>)}
        </select>
        <select aria-label={t('schedule.filterLocation')} className={selectClass} value={filters.locationId} onChange={(e) => set('locationId')(e.target.value)}>
          <option value="">{t('schedule.filterLocation')}: {t('schedule.all')}</option>
          {config.locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
        </select>
        <label className="flex items-center gap-2 text-sm">
          <Switch checked={filters.needsOutcome} onCheckedChange={(v) => set('needsOutcome')(v)} aria-label={t('schedule.needsOutcome')} />
          {t('schedule.needsOutcome')}
        </label>
      </div>

      {totals && (
        <dl className="grid grid-cols-3 gap-2 text-center sm:grid-cols-6" data-testid="appointment-stats">
          {([['booked', totals.booked], ['confirmed', totals.confirmed], ['cancelled', totals.cancelled],
            ['completed', totals.completed], ['noShow', totals.no_show]] as const).map(([key, value]) => (
            <div key={key} className="rounded-lg border border-border bg-card p-2">
              <dt className="text-[11px] text-muted-foreground">{t(`stats.${key}`)}</dt>
              <dd className="text-lg font-semibold tabular-nums">{value}</dd>
            </div>
          ))}
          <div className="rounded-lg border border-border bg-card p-2">
            <dt className="text-[11px] text-muted-foreground">{t('stats.noShowRate')}</dt>
            <dd className="text-lg font-semibold tabular-nums">
              {totals.no_show_rate === null ? t('stats.notAvailable') : `${Math.round(totals.no_show_rate * 100)}%`}
            </dd>
          </div>
        </dl>
      )}

      {rows === null && <Loader2 className="h-5 w-5 animate-spin text-primary" />}
      {failed && (
        <div className="flex items-center gap-2 text-sm text-destructive">
          {t('loadFailed')}
          <Button type="button" variant="outline" size="sm" onClick={() => void load()}>{t('retry')}</Button>
        </div>
      )}
      {rows && !failed && rows.length === 0 && (
        <p className="rounded-lg border border-dashed border-border p-6 text-center text-sm text-muted-foreground">{t('schedule.empty')}</p>
      )}
      {groups.map(([day, items]) => (
        <section key={day} className="space-y-2">
          <h3 className="text-sm font-semibold text-foreground">{formatDay(day, locale)}</h3>
          <ul className="divide-y divide-border rounded-lg border border-border bg-card">
            {items.map((a) => (
              <li key={a.id}>
                <div className="flex flex-wrap items-center gap-3 p-3 text-sm">
                  <button type="button" className="w-28 shrink-0 text-left font-medium tabular-nums hover:underline" onClick={() => onOpen(a.id)}>
                    {formatTime(a.start_at, a.timezone, locale)}
                    <span className="block text-[10px] font-normal text-muted-foreground">{zoneLabel(new Date(a.start_at), a.timezone, locale)}</span>
                  </button>
                  <button type="button" className="min-w-0 flex-1 text-left" onClick={() => onOpen(a.id)}>
                    <span className="block truncate font-medium">{a.service_name}</span>
                    <span className="block truncate text-xs text-muted-foreground">
                      {(a.staff_id ? staffName.get(a.staff_id) : t('schedule.pool')) ?? ''} · {locationName.get(a.location_id) ?? ''}
                    </span>
                  </button>
                  <span className="min-w-0 max-w-[12rem] truncate text-xs">
                    {a.contact_id ? (
                      a.conversation_id
                        ? <Link className="text-primary hover:underline" href={`/inbox?c=${a.conversation_id}`}>{a.contact_name || t('sheet.contact')}</Link>
                        : (a.contact_name || t('sheet.contact'))
                    ) : <span className="text-muted-foreground">{t('schedule.awaitingContact')}</span>}
                  </span>
                  <AppointmentStatusBadge status={a.status} />
                </div>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
