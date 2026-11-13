'use client';

/**
 * Appointments week calendar: seven day columns on an hourly grid. Bookings
 * sit at their own local time (each in its location's zone) and overlapping
 * ones share the column side by side. Days with no working hours in the
 * filtered location (any location when none is chosen) are shaded as closed.
 * Clicking an empty spot asks to book at that half hour (staff who can book).
 * The grid scrolls sideways inside its own box on narrow screens.
 */
import { useMemo } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import type { ScheduleItem } from './schedule-view';

export interface HoursRow { staff_id: string | null; location_id: string; hours: Record<string, Array<{ start: string; end: string }>> | null }

const HOUR_PX = 56;
/** The shortest a booking block is drawn (px), so a 15-minute booking stays readable. */
const MIN_BLOCK_PX = 26;
/** Minutes a block of MIN_BLOCK_PX covers: lanes use the drawn size so short bookings never overlap the next one. */
const MIN_BLOCK_MINUTES = Math.ceil(((MIN_BLOCK_PX + 2) / HOUR_PX) * 60);
const WEEKDAY_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;
const pad = (n: number) => String(n).padStart(2, '0');
const toMinutes = (hhmm: string) => {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
};

/** Minutes after local midnight of an instant in a zone. */
export function zonedMinutes(iso: string, tz: string): number {
  const parts = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: tz })
    .formatToParts(new Date(iso));
  const h = Number(parts.find((p) => p.type === 'hour')?.value ?? 0);
  const m = Number(parts.find((p) => p.type === 'minute')?.value ?? 0);
  return h * 60 + m;
}

const weekdayOf = (day: string) => new Date(`${day}T12:00:00Z`).getUTCDay();

/** Side-by-side lanes for overlapping bookings of one day (pure; tested). */
export function layoutLanes<T extends { id: string; start: number; end: number }>(items: T[]): { lane: Map<string, number>; lanes: number } {
  const ends: number[] = [];
  const lane = new Map<string, number>();
  for (const item of [...items].sort((a, b) => a.start - b.start || a.end - b.end)) {
    let i = ends.findIndex((end) => end <= item.start);
    if (i < 0) i = ends.push(0) - 1;
    ends[i] = item.end;
    lane.set(item.id, i);
  }
  return { lane, lanes: Math.max(1, ends.length) };
}

/** The hour range to draw (working hours, widened to fit every booking) and the closed weekdays (pure; tested). */
export function gridFrame(hours: HoursRow[], locationId: string, bookings: Array<{ start: number; end: number }>) {
  const rows = hours.filter((h) => h.hours && (!locationId || h.location_id === locationId));
  const open = new Set<number>();
  let first = Infinity, last = -Infinity;
  for (const row of rows) {
    for (const [day, ranges] of Object.entries(row.hours ?? {})) {
      const index = WEEKDAY_KEYS.indexOf(day as (typeof WEEKDAY_KEYS)[number]);
      if (index < 0 || !ranges?.length) continue;
      open.add(index);
      for (const r of ranges) {
        first = Math.min(first, toMinutes(r.start));
        last = Math.max(last, toMinutes(r.end));
      }
    }
  }
  if (!Number.isFinite(first)) { first = 9 * 60; last = 19 * 60; }
  for (const b of bookings) {
    first = Math.min(first, b.start);
    last = Math.max(last, b.end);
  }
  const startHour = Math.max(0, Math.floor(first / 60));
  const endHour = Math.min(24, Math.max(startHour + 1, Math.ceil(last / 60)));
  // No hours set anywhere: nothing is known to be closed.
  const closed = rows.length === 0 ? new Set<number>() : new Set([0, 1, 2, 3, 4, 5, 6].filter((d) => !open.has(d)));
  return { startHour, endHour, closed };
}

export function WeekGrid({
  days, rows, hours, locationId, today, staffName, onOpen, onSlot,
}: {
  days: string[];
  rows: ScheduleItem[];
  hours: HoursRow[];
  locationId: string;
  today: string;
  staffName: Map<string, string>;
  onOpen: (id: string) => void;
  /** Book at a picked half hour; absent for members who cannot book. */
  onSlot?: (day: string, hhmm: string) => void;
}) {
  const t = useTranslations('Sales.appointments');
  const tStatus = useTranslations('Appointments.status');
  const locale = useLocale();

  const items = useMemo(() => rows.filter((r) => r.status !== 'cancelled' && r.status !== 'expired').map((r) => {
    const start = zonedMinutes(r.start_at, r.timezone);
    const span = Math.max(15, Math.round((new Date(r.end_at).getTime() - new Date(r.start_at).getTime()) / 60_000));
    return { ...r, day: String(r.local_date).slice(0, 10), start, end: Math.min(24 * 60, start + span) };
  }), [rows]);
  const frame = useMemo(
    () => gridFrame(hours, locationId, items.map((i) => ({ start: i.start, end: Math.min(24 * 60, Math.max(i.end, i.start + MIN_BLOCK_MINUTES)) }))),
    [hours, locationId, items],
  );
  const hourList = Array.from({ length: frame.endHour - frame.startHour }, (_, i) => frame.startHour + i);
  const timeLabel = (minutes: number) => new Intl.DateTimeFormat(locale, { hour: 'numeric', minute: minutes % 60 ? '2-digit' : undefined, timeZone: 'UTC' })
    .format(new Date(Date.UTC(2020, 0, 1, Math.floor(minutes / 60), minutes % 60)));
  const dayName = (day: string, style: 'short' | 'long') => new Intl.DateTimeFormat(locale, { weekday: style, timeZone: 'UTC' }).format(new Date(`${day}T12:00:00Z`));
  const dayNumber = (day: string) => Number(day.slice(8, 10));
  const fullDay = (day: string) => new Intl.DateTimeFormat(locale, { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' }).format(new Date(`${day}T12:00:00Z`));

  const pick = (day: string, event: React.MouseEvent<HTMLDivElement>) => {
    if (!onSlot || event.target !== event.currentTarget) return;
    const y = event.clientY - event.currentTarget.getBoundingClientRect().top;
    const minutes = frame.startHour * 60 + Math.max(0, Math.floor((y / HOUR_PX) * 2)) * 30;
    onSlot(day, `${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`);
  };

  return (
    <div>
      <div className="overflow-x-auto rounded-xl border border-border bg-card">
        <div className="min-w-[760px]" role="grid" aria-label={t('gridLabel')}>
          <div className="grid grid-cols-[58px_repeat(7,minmax(0,1fr))] border-b border-border bg-muted" role="row">
            <span role="columnheader" />
            {days.map((day) => (
              <div key={day} role="columnheader" className={`flex items-baseline gap-1.5 border-l border-border/60 px-2.5 py-2 ${day === today ? 'text-primary' : ''}`}>
                <small className={`text-xs font-medium ${day === today ? '' : 'text-muted-foreground'}`}>{dayName(day, 'short')}</small>
                <b className="text-[15px] font-semibold tabular-nums">{dayNumber(day)}</b>
              </div>
            ))}
          </div>
          <div className="grid grid-cols-[58px_repeat(7,minmax(0,1fr))]" role="row">
            <div aria-hidden>
              {hourList.map((h) => (
                <span key={h} className="block pr-2 pt-1 text-right text-[11px] tabular-nums text-muted-foreground" style={{ height: HOUR_PX }}>
                  {timeLabel(h * 60)}
                </span>
              ))}
            </div>
            {days.map((day) => {
              const dayItems = items.filter((i) => i.day === day);
              const { lane, lanes } = layoutLanes(dayItems.map((i) => ({ id: i.id, start: i.start, end: Math.max(i.end, i.start + MIN_BLOCK_MINUTES) })));
              const closed = frame.closed.has(weekdayOf(day));
              return (
                <div
                  key={day}
                  role="gridcell"
                  aria-label={`${fullDay(day)}${closed ? ` · ${t('closed')}` : ''}`}
                  title={onSlot ? t('clickToBook') : undefined}
                  onClick={(e) => pick(day, e)}
                  className={`relative border-l border-border/60 ${onSlot ? 'cursor-copy' : ''} ${closed ? 'bg-muted/70' : day === today ? 'bg-primary/5' : ''}`}
                  style={{
                    height: HOUR_PX * hourList.length,
                    backgroundImage: 'linear-gradient(var(--border) 1px, transparent 1px)',
                    backgroundSize: `100% ${HOUR_PX}px`,
                  }}
                >
                  {dayItems.map((a) => {
                    const top = ((a.start - frame.startHour * 60) / 60) * HOUR_PX;
                    const height = Math.max(MIN_BLOCK_PX, ((a.end - a.start) / 60) * HOUR_PX - 2);
                    const index = lane.get(a.id) ?? 0;
                    const short = height < 40;
                    const tone = a.status === 'completed' ? 'border-emerald-500 bg-emerald-500/14'
                      : a.status === 'no_show' ? 'border-destructive bg-destructive/12' : 'border-primary bg-primary/14';
                    const who = a.contact_name || t('noContact');
                    const label = `${who}, ${timeLabel(a.start)}, ${a.service_name}, ${tStatus(a.status)}`;
                    return (
                      <button
                        key={a.id}
                        type="button"
                        aria-label={label}
                        title={`${label}${a.staff_id ? ` · ${staffName.get(a.staff_id) ?? ''}` : ''}`}
                        onClick={() => onOpen(a.id)}
                        className={`absolute flex overflow-hidden rounded-lg border-l-[3px] px-2 text-left text-xs leading-tight transition-shadow duration-150 hover:z-10 hover:shadow-md focus-visible:z-10 focus-visible:outline-2 focus-visible:outline-primary ${tone} ${short ? 'flex-row items-center gap-1.5' : 'flex-col items-start py-1'}`}
                        style={{ top, height, left: `calc(${(index / lanes) * 100}% + 2px)`, width: `calc(${100 / lanes}% - 4px)` }}
                      >
                        <strong className="max-w-full truncate font-semibold">{who}</strong>
                        <small className="min-w-0 max-w-full truncate text-[11px] text-muted-foreground">{timeLabel(a.start)} · {a.service_name}</small>
                      </button>
                    );
                  })}
                </div>
              );
            })}
          </div>
        </div>
      </div>
      <p className="mt-2 text-xs text-muted-foreground">{onSlot ? t('hint') : t('hintReadOnly')}</p>
    </div>
  );
}
