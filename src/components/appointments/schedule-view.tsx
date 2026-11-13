'use client';

/**
 * Schedule tab: a week calendar (time grid, click an empty slot to book) or an
 * agenda grouped by local date for a day or a week, with filters and the
 * period's counts. Each time is shown in the
 * appointment's own zone with its label; the window follows the filtered
 * location's zone (else the first location's).
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { ChevronLeft, ChevronRight, Clock, Link2, Loader2, Plus } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { AppointmentStatusBadge } from './appointment-status-badge';
import {
  apiRequest, browserZone, FILTER_STATUSES, formatDay, formatTime, groupByLocalDate, scheduleWindow, selectClass,
  type Abilities, type AppointmentConfig,
} from './shared';
import { addDays, localDay, zoneLabel } from '@/lib/appointments/time';
import { WeekGrid, type HoursRow } from './week-grid';
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

type View = 'grid' | 'day' | 'week';

export function ScheduleView({
  config, abilities, onOpen, onNew, refreshKey, onSlot, onOpenTab,
}: {
  config: AppointmentConfig;
  abilities: Abilities;
  onOpen: (id: string) => void;
  onNew: () => void;
  /** Bumped by the page after a change, to reload. */
  refreshKey: number;
  /** Week calendar: book at a picked day and time (members who can book). */
  onSlot?: (day: string, hhmm: string) => void;
  /** Jump to a configuration tab (booking pages, services). */
  onOpenTab?: (tab: 'pages' | 'services') => void;
}) {
  const t = useTranslations('Appointments');
  const ts = useTranslations('Sales.appointments');
  const locale = useLocale();
  // The calendar on wide screens, the list on phones (the grid scrolls sideways there).
  const [view, setView] = useState<View>('grid');
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- the first view depends on the screen, known only in the browser
    if (window.matchMedia('(max-width: 699px)').matches) setView('week');
  }, []);
  const [hours, setHours] = useState<HoursRow[]>([]);
  const [filters, setFilters] = useState<Filters>(NO_FILTERS);
  const zone = useMemo(() => {
    const chosen = config.locations.find((l) => l.id === filters.locationId);
    return chosen?.timezone ?? config.locations.find((l) => !l.archived_at)?.timezone ?? browserZone();
  }, [config.locations, filters.locationId]);
  const [anchor, setAnchor] = useState(() => localDay(new Date(), zone));
  const [rows, setRows] = useState<ScheduleItem[] | null>(null);
  const [totals, setTotals] = useState<Totals | null>(null);
  const [failed, setFailed] = useState(false);

  // The calendar always shows Monday to Sunday; the agenda starts at the anchor day.
  const range = useMemo(() => {
    if (view !== 'grid') return scheduleWindow(view, anchor, zone);
    const weekday = new Date(`${anchor}T12:00:00Z`).getUTCDay();
    return scheduleWindow('week', addDays(anchor, -((weekday + 6) % 7)), zone);
  }, [view, anchor, zone]);

  useEffect(() => {
    if (view !== 'grid') return;
    let live = true;
    void apiRequest<{ hours: HoursRow[] }>('/api/appointments/hours').then((r) => {
      if (live && r.ok) setHours(r.data.hours ?? []);
    });
    return () => {
      live = false;
    };
  }, [view, refreshKey]);

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
  const today = localDay(new Date(), zone);
  const groups = useMemo(() => groupByLocalDate(rows ?? []), [rows]);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <div className="inline-flex rounded-xl bg-muted p-[3px]">
          {(['grid', 'day', 'week'] as const).map((v) => (
            <button key={v} type="button" aria-pressed={view === v} onClick={() => setView(v)}
              className={`h-[26px] rounded-[9px] px-3 text-[13px] font-medium transition-[background-color,color,box-shadow] duration-150 ${
                view === v ? 'bg-card text-foreground shadow-[0_1px_3px_rgb(0_0_0/0.12)] dark:bg-input' : 'text-muted-foreground hover:text-foreground'
              }`}>
              {v === 'grid' ? ts('viewWeek') : v === 'day' ? t('schedule.day') : ts('viewList')}
            </button>
          ))}
        </div>
        <Button type="button" variant="ghost" size="icon" aria-label={t('schedule.previous')} onClick={() => setAnchor((d) => addDays(d, -step))}>
          <ChevronLeft className="h-4 w-4" />
        </Button>
        <Button type="button" variant="outline" size="sm" onClick={() => setAnchor(localDay(new Date(), zone))}>{t('schedule.today')}</Button>
        <Button type="button" variant="ghost" size="icon" aria-label={t('schedule.next')} onClick={() => setAnchor((d) => addDays(d, step))}>
          <ChevronRight className="h-4 w-4" />
        </Button>
        <span className="min-w-0 text-[13px] font-semibold tabular-nums">
          {formatDay(range.days[0], locale)}{view !== 'day' ? ` – ${formatDay(range.days[range.days.length - 1], locale)}` : ''}
        </span>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          {onOpenTab && (
            <>
              <Button type="button" variant="ghost" size="sm" onClick={() => onOpenTab('pages')}><Link2 className="h-4 w-4" /> {ts('bookingLink')}</Button>
              <Button type="button" variant="ghost" size="sm" onClick={() => onOpenTab('services')}><Clock className="h-4 w-4" /> {ts('servicesHours')}</Button>
            </>
          )}
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
        <dl className="grid grid-cols-2 gap-2 sm:grid-cols-3 sm:gap-3 xl:grid-cols-6" data-testid="appointment-stats">
          {([['booked', totals.booked], ['confirmed', totals.confirmed], ['cancelled', totals.cancelled],
            ['completed', totals.completed], ['noShow', totals.no_show]] as const).map(([key, value]) => (
            <div key={key} className="flex flex-col gap-1 rounded-xl border border-border bg-card px-3 py-2.5 sm:px-4 sm:py-3.5">
              <dt className="text-xs font-medium text-muted-foreground">{t(`stats.${key}`)}</dt>
              <dd className="text-[17px] font-bold tracking-tight tabular-nums sm:text-[22px]">{value}</dd>
            </div>
          ))}
          <div className="flex flex-col gap-1 rounded-xl border border-border bg-card px-3 py-2.5 sm:px-4 sm:py-3.5">
            <dt className="text-xs font-medium text-muted-foreground">{t('stats.noShowRate')}</dt>
            <dd className="text-[17px] font-bold tracking-tight tabular-nums sm:text-[22px]">
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
      {rows && !failed && view === 'grid' && !filters.needsOutcome && (
        <WeekGrid days={range.days} rows={rows} hours={hours} locationId={filters.locationId} today={today} staffName={staffName}
          onOpen={onOpen} onSlot={abilities.manage ? onSlot : undefined} />
      )}
      {rows && !failed && (view !== 'grid' || filters.needsOutcome) && rows.length === 0 && (
        <p className="rounded-xl border border-dashed border-border px-4 py-12 text-center text-sm text-muted-foreground">{t('schedule.empty')}</p>
      )}
      {(view !== 'grid' || filters.needsOutcome) && groups.map(([day, items]) => (
        <section key={day} className="space-y-2">
          <h3 className="text-[13px] font-semibold text-muted-foreground">{formatDay(day, locale)}</h3>
          <ul className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-card">
            {items.map((a) => (
              <li key={a.id}>
                <div className="flex flex-wrap items-center gap-x-3.5 gap-y-2 py-2.5 pl-3.5 pr-3 text-sm transition-colors duration-150 hover:bg-muted/60">
                  <button type="button" className="w-[72px] shrink-0 text-left font-semibold tabular-nums" onClick={() => onOpen(a.id)}>
                    {formatTime(a.start_at, a.timezone, locale)}
                    <span className="block text-[11px] font-normal text-muted-foreground">{zoneLabel(new Date(a.start_at), a.timezone, locale)}</span>
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
