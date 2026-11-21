'use client';

/**
 * The Schedule tab: Today (the day's bookings in time order with quick
 * outcome actions, and what needs attention), Week (the time grid: click an
 * empty slot to book, drag a booking to move it) and List (paged, 50 at a
 * time, with "Load more"). The view lives in ?view=. Each time is shown in
 * the booking's own zone; the window follows the filtered location's zone
 * (else the first location's). A list cut at its limit says so.
 */
import { OptionSelect } from '@/components/contacts/option-select';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { CalendarDays, ChevronLeft, ChevronRight } from 'lucide-react';
import { toast } from 'sonner';
import { useLocale, useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { useConfirm } from '@/components/ui/confirm-dialog';
import { EmptyState } from '@/components/ui/empty-state';
import { GroupedList, GroupedListRow } from '@/components/ui/grouped-list';
import { InlineError } from '@/components/ui/inline-error';
import { PageLoading } from '@/components/ui/page-loading';
import { SegmentedControl } from '@/components/ui/segmented-control';
import { Switch } from '@/components/ui/switch';
import { AppointmentStatusBadge } from './appointment-status-badge';
import {
  apiRequest, browserZone, FILTER_STATUSES, formatDateTime, formatDay, formatTime, groupByLocalDate, scheduleWindow,
  useFailureText, zonedStartIso, type Abilities, type AppointmentConfig, type ScheduleViewName,
} from './shared';
import { addDays, localDay, zoneLabel } from '@/lib/appointments/time';
import { WeekGrid, type GridMove, type HoursRow } from './week-grid';
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
  payment_status?: string;
}

interface Totals { booked: number; confirmed: number; cancelled: number; completed: number; no_show: number; no_show_rate: number | null }
interface Filters { status: string; staffId: string; locationId: string; serviceId: string; needsOutcome: boolean }
const NO_FILTERS: Filters = { status: '', staffId: '', locationId: '', serviceId: '', needsOutcome: false };
interface Page { appointments: ScheduleItem[]; next_cursor: string | null; truncated: boolean }

const LIST_PAGE = 50;
/** List view: how far ahead of the anchor day it reads (the API allows 62 days). */
const LIST_DAYS = 31;

export function ScheduleView({
  config, abilities, onOpen, onNew, refreshKey, onSlot, view, onViewChange, onChanged,
}: {
  config: AppointmentConfig;
  abilities: Abilities;
  onOpen: (id: string) => void;
  onNew: () => void;
  /** Bumped by the page after a change, to reload. */
  refreshKey: number;
  /** Week calendar: book at a picked day and time (members who can book). */
  onSlot?: (day: string, hhmm: string) => void;
  view: ScheduleViewName;
  onViewChange: (view: ScheduleViewName) => void;
  /** A booking changed here (moved, outcome). */
  onChanged: () => void;
}) {
  const t = useTranslations('Appointments');
  const locale = useLocale();
  const failureText = useFailureText();
  const confirm = useConfirm();
  const [hours, setHours] = useState<HoursRow[]>([]);
  const [filters, setFilters] = useState<Filters>(NO_FILTERS);
  const zone = useMemo(() => {
    const chosen = config.locations.find((l) => l.id === filters.locationId);
    return chosen?.timezone ?? config.locations.find((l) => !l.archived_at)?.timezone ?? browserZone();
  }, [config.locations, filters.locationId]);
  const [anchor, setAnchor] = useState(() => localDay(new Date(), zone));
  const [rows, setRows] = useState<ScheduleItem[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [totals, setTotals] = useState<Totals | null>(null);
  const [failed, setFailed] = useState(false);
  const [moveError, setMoveError] = useState<string | null>(null);
  const [attention, setAttention] = useState<ScheduleItem[]>([]);
  const [loadedAt, setLoadedAt] = useState(0);

  // Week: Monday to Sunday around the anchor. Today: the anchor day. List: a month from the anchor.
  const range = useMemo(() => {
    if (view === 'today') return scheduleWindow('day', anchor, zone);
    if (view === 'week') {
      const weekday = new Date(`${anchor}T12:00:00Z`).getUTCDay();
      return scheduleWindow('week', addDays(anchor, -((weekday + 6) % 7)), zone);
    }
    const w = scheduleWindow('week', anchor, zone);
    return { ...w, to: scheduleWindow('day', addDays(anchor, LIST_DAYS - 1), zone).to, days: [anchor, addDays(anchor, LIST_DAYS - 1)] };
  }, [view, anchor, zone]);

  useEffect(() => {
    if (view !== 'week') return;
    let live = true;
    void apiRequest<{ hours: HoursRow[] }>('/api/appointments/hours').then((r) => {
      if (live && r.ok) setHours(r.data.hours ?? []);
    });
    return () => {
      live = false;
    };
  }, [view, refreshKey]);

  const query = useCallback((after: string | null) => {
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
    if (view === 'list') params.set('limit', String(LIST_PAGE));
    if (after) params.set('cursor', after);
    return `/api/appointments?${params}`;
  }, [range, filters, view]);

  const load = useCallback(async () => {
    setFailed(false);
    const stats = new URLSearchParams({ from: range.days[0], to: range.days[range.days.length - 1] });
    if (filters.serviceId) stats.set('service_id', filters.serviceId);
    const [list, counts] = await Promise.all([
      apiRequest<Page>(query(null)),
      apiRequest<{ totals: Totals }>(`/api/appointments/stats?${stats}`),
    ]);
    setLoadedAt(Date.now());
    if (!list.ok) {
      setFailed(true);
      setRows([]);
      return;
    }
    setRows(list.data.appointments ?? []);
    setCursor(list.data.next_cursor ?? null);
    setTruncated(!!list.data.truncated);
    setTotals(counts.ok ? counts.data.totals : null);
  }, [range, filters, query]);

  async function loadMore() {
    if (!cursor) return;
    setLoadingMore(true);
    const r = await apiRequest<Page>(query(cursor));
    setLoadingMore(false);
    if (!r.ok) return void toast.error(failureText(r));
    setRows((prev) => [...(prev ?? []), ...(r.data.appointments ?? [])]);
    setCursor(r.data.next_cursor ?? null);
    setTruncated(!!r.data.truncated);
  }

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load, refreshKey]);

  // Today: confirmed bookings that ended and still need an outcome (last 60 days, at most 20).
  useEffect(() => {
    if (view !== 'today') return;
    let live = true;
    const params = new URLSearchParams({
      from: new Date(Date.now() - 60 * 86_400_000).toISOString(), to: new Date().toISOString(), needs_outcome: '1', limit: '20',
    });
    void apiRequest<Page>(`/api/appointments?${params}`).then((r) => {
      if (live) setAttention(r.ok ? r.data.appointments ?? [] : []);
    });
    return () => {
      live = false;
    };
  }, [view, refreshKey]);

  async function outcome(a: ScheduleItem, value: 'completed' | 'no_show') {
    const r = await apiRequest(`/api/appointments/${a.id}`, { method: 'PATCH', body: { action: 'outcome', outcome: value, expected_version: a.version } });
    if (!r.ok) return void toast.error(failureText(r));
    toast.success(t('sheet.saved'));
    onChanged();
  }

  async function move(m: GridMove) {
    setMoveError(null);
    const startAt = zonedStartIso(m.day, m.minutes, m.item.timezone);
    if (!startAt) return setMoveError(t('errors.slot_unavailable'));
    const ok = await confirm({
      title: t('drag.moveTitle'),
      body: t('drag.moveBody', { from: formatDateTime(m.item.start_at, m.item.timezone, locale), to: formatDateTime(startAt, m.item.timezone, locale) }),
      confirmLabel: t('drag.move'),
    });
    if (!ok) return;
    const r = await apiRequest(`/api/appointments/${m.item.id}`, {
      method: 'PATCH',
      body: { action: 'reschedule', expected_version: m.item.version, start_at: startAt, staff_id: m.item.staff_id ?? undefined },
    });
    if (!r.ok) {
      setMoveError(failureText(r));
      return;
    }
    toast.success(t('drag.moved'));
    onChanged();
  }

  const staffName = useMemo(() => new Map(config.staff.map((s) => [s.id, s.display_name])), [config.staff]);
  const locationName = useMemo(() => new Map(config.locations.map((l) => [l.id, l.name])), [config.locations]);
  const serviceStep = useMemo(() => new Map(config.services.map((s) => [s.id, s.slot_step_minutes ?? s.duration_minutes])), [config.services]);
  const set = <K extends keyof Filters>(key: K) => (value: Filters[K]) => setFilters((f) => ({ ...f, [key]: value }));
  const step = view === 'today' ? 1 : view === 'week' ? 7 : LIST_DAYS;
  const today = localDay(new Date(), zone);
  const groups = useMemo(() => groupByLocalDate(rows ?? []), [rows]);
  const who = (a: ScheduleItem) => a.contact_id ? (a.contact_name || t('sheet.contact')) : t('schedule.awaitingContact');
  const where = (a: ScheduleItem) => `${(a.staff_id ? staffName.get(a.staff_id) : t('schedule.pool')) ?? ''} · ${locationName.get(a.location_id) ?? ''}`;
  const started = (a: ScheduleItem) => new Date(a.start_at).getTime() <= loadedAt;

  const row = (a: ScheduleItem, quick: boolean) => (
    <GroupedListRow key={a.id} onClick={() => onOpen(a.id)} chevron={!quick}
      leading={(
        <span className="w-16 shrink-0 font-semibold tabular-nums">
          {formatTime(a.start_at, a.timezone, locale)}
          <span className="block text-caption font-normal text-muted-foreground">{zoneLabel(new Date(a.start_at), a.timezone, locale)}</span>
        </span>
      )}
      title={`${who(a)} · ${a.service_name}`}
      subtitle={where(a)}
      trailing={(
        <span className="flex items-center gap-1.5">
          {quick && abilities.manage && a.status === 'confirmed' && started(a) && (
            <>
              <Button type="button" size="sm" variant="outline" onClick={(e) => { e.stopPropagation(); void outcome(a, 'completed'); }}>{t('sheet.markCompleted')}</Button>
              <Button type="button" size="sm" variant="ghost" onClick={(e) => { e.stopPropagation(); void outcome(a, 'no_show'); }}>{t('sheet.markNoShow')}</Button>
            </>
          )}
          <AppointmentStatusBadge status={a.status} />
        </span>
      )} />
  );

  const listed = view !== 'week' || filters.needsOutcome;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <SegmentedControl<ScheduleViewName> aria-label={t('screen.viewsLabel')} value={view} onValueChange={onViewChange}
          options={[{ value: 'today', label: t('screen.viewToday') }, { value: 'week', label: t('screen.viewWeek') }, { value: 'list', label: t('screen.viewList') }]} />
        <Button type="button" variant="ghost" size="icon" aria-label={t('schedule.previous')} onClick={() => setAnchor((d) => addDays(d, -step))}>
          <ChevronLeft className="h-4 w-4" />
        </Button>
        <Button type="button" variant="outline" size="sm" onClick={() => setAnchor(localDay(new Date(), zone))}>{t('schedule.today')}</Button>
        <Button type="button" variant="ghost" size="icon" aria-label={t('schedule.next')} onClick={() => setAnchor((d) => addDays(d, step))}>
          <ChevronRight className="h-4 w-4" />
        </Button>
        <span className="min-w-0 text-subhead font-semibold tabular-nums">
          {formatDay(range.days[0], locale)}{view !== 'today' ? ` – ${formatDay(range.days[range.days.length - 1], locale)}` : ''}
        </span>
      </div>

      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-5">
        <OptionSelect aria-label={t('schedule.filterStatus')} value={filters.status} onValueChange={set('status')}
          options={[{ value: '', label: `${t('schedule.filterStatus')}: ${t('schedule.all')}` }, ...FILTER_STATUSES.map((s) => ({ value: s, label: t(`status.${s}`) }))]} />
        <OptionSelect aria-label={t('schedule.filterService')} value={filters.serviceId} onValueChange={set('serviceId')}
          options={[{ value: '', label: `${t('schedule.filterService')}: ${t('schedule.all')}` }, ...config.services.map((s) => ({ value: s.id, label: s.name }))]} />
        <OptionSelect aria-label={t('schedule.filterStaff')} value={filters.staffId} onValueChange={set('staffId')}
          options={[{ value: '', label: `${t('schedule.filterStaff')}: ${t('schedule.all')}` }, ...config.staff.map((s) => ({ value: s.id, label: s.display_name }))]} />
        <OptionSelect aria-label={t('schedule.filterLocation')} value={filters.locationId} onValueChange={set('locationId')}
          options={[{ value: '', label: `${t('schedule.filterLocation')}: ${t('schedule.all')}` }, ...config.locations.map((l) => ({ value: l.id, label: l.name }))]} />
        <label className="flex min-h-11 items-center gap-2 text-sm">
          <Switch checked={filters.needsOutcome} onCheckedChange={(v) => set('needsOutcome')(v)} aria-label={t('schedule.needsOutcome')} />
          {t('schedule.needsOutcome')}
        </label>
      </div>

      {totals && (
        <dl className="grid grid-cols-2 gap-2 sm:grid-cols-3 sm:gap-3 xl:grid-cols-6" data-testid="appointment-stats">
          {([['booked', totals.booked], ['confirmed', totals.confirmed], ['cancelled', totals.cancelled],
            ['completed', totals.completed], ['noShow', totals.no_show]] as const).map(([key, value]) => (
            <div key={key} className="flex flex-col gap-1 rounded-group border border-separator bg-grouped-surface px-3 py-2.5 sm:px-4 sm:py-3.5">
              <dt className="text-footnote font-medium text-muted-foreground">{t(`stats.${key}`)}</dt>
              <dd className="text-title-3 font-bold tabular-nums">{value}</dd>
            </div>
          ))}
          <div className="flex flex-col gap-1 rounded-group border border-separator bg-grouped-surface px-3 py-2.5 sm:px-4 sm:py-3.5">
            <dt className="text-footnote font-medium text-muted-foreground">{t('stats.noShowRate')}</dt>
            <dd className="text-title-3 font-bold tabular-nums">
              {totals.no_show_rate === null ? t('stats.notAvailable') : `${Math.round(totals.no_show_rate * 100)}%`}
            </dd>
          </div>
        </dl>
      )}

      {view === 'today' && attention.length > 0 && !filters.needsOutcome && (
        <GroupedList header={t('screen.attention')} footer={t('screen.outcomeDue')}>
          {attention.map((a) => row(a, true))}
        </GroupedList>
      )}

      {rows === null && <PageLoading rows={4} />}
      {failed && <InlineError message={t('loadFailed')} onRetry={() => void load()} />}
      {moveError && <InlineError message={moveError} onRetry={() => { setMoveError(null); void load(); }} />}

      {rows && !failed && view === 'week' && !filters.needsOutcome && (
        <WeekGrid days={range.days} rows={rows} hours={hours} locationId={filters.locationId} today={today} staffName={staffName}
          onOpen={onOpen} onSlot={abilities.manage ? onSlot : undefined} onMove={abilities.manage ? (m) => void move(m) : undefined}
          stepFor={(a) => serviceStep.get(a.service_id) ?? 15} now={loadedAt} />
      )}
      {rows && !failed && listed && rows.length === 0 && (
        <EmptyState icon={CalendarDays} title={view === 'today' ? t('screen.noBookingsToday') : t('screen.noBookings')}
          action={abilities.manage ? <Button type="button" onClick={onNew}>{t('screen.newBooking')}</Button> : undefined} />
      )}
      {rows && !failed && listed && (view === 'today' && !filters.needsOutcome
        ? rows.length > 0 && <GroupedList>{rows.map((a) => row(a, true))}</GroupedList>
        : groups.map(([day, items]) => (
          <GroupedList key={day} header={formatDay(day, locale)}>{items.map((a) => row(a, false))}</GroupedList>
        )))}

      {rows && !failed && truncated && (
        <div className="flex flex-wrap items-center gap-3 text-footnote text-muted-foreground" data-testid="schedule-truncated">
          <span>{t('screen.truncated', { count: rows.length })}</span>
          <Button type="button" size="sm" variant="outline" disabled={loadingMore} onClick={() => void loadMore()}>{t('screen.loadMore')}</Button>
        </div>
      )}
    </div>
  );
}
