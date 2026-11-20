'use client';

/**
 * Appointments week calendar: seven day columns on an hourly grid. Bookings
 * sit at their own local time (each in its location's zone) and overlapping
 * ones share the column side by side. Days with no working hours in the
 * filtered location (any location when none is chosen) are shaded as closed.
 * Clicking an empty spot asks to book at that half hour (staff who can book).
 * The grid scrolls sideways inside its own box on narrow screens.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { snapDrag } from './shared';
import type { ScheduleItem } from './schedule-view';

/** A proposed move from a drag or the keyboard: the booking, its new local day and start minute. */
export interface GridMove { item: ScheduleItem; day: string; minutes: number }

const LONG_PRESS_MS = 400;
const DRAG_THRESHOLD_PX = 4;

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

/**
 * Where a dragged booking lands: its day moved by whole columns (kept inside
 * the shown week) and its start snapped to the step; null when nothing moved
 * (pure; tested).
 */
export function dropTarget(
  item: { day: string; start: number; end: number }, dx: number, dy: number, columnPx: number, days: string[], step: number, hourPx = HOUR_PX,
): { day: string; minutes: number } | null {
  const index = days.indexOf(item.day);
  const shift = columnPx > 0 ? Math.round(dx / columnPx) : 0;
  const day = days[Math.min(Math.max(0, index + shift), days.length - 1)] ?? item.day;
  const minutes = snapDrag(item.start, dy, hourPx, step, item.end - item.start);
  return day === item.day && minutes === item.start ? null : { day, minutes };
}

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
  days, rows, hours, locationId, today, staffName, onOpen, onSlot, onMove, stepFor, now,
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
  /** Ask to move a confirmed, not-yet-started booking (members who can reschedule). */
  onMove?: (move: GridMove) => void;
  /** The snap step in minutes for a booking's service. */
  stepFor?: (item: ScheduleItem) => number;
  /** "Now" in ms, so started bookings stay put. */
  now?: number;
}) {
  // The booking being moved and how far, in px (pointer) or in steps and days (keyboard).
  const [drag, setDrag] = useState<{ id: string; dx: number; dy: number } | null>(null);
  const [keyMove, setKeyMove] = useState<{ id: string; minutes: number; dayShift: number } | null>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const t = useTranslations('Sales.appointments');
  const tStatus = useTranslations('Appointments.status');
  const tDrag = useTranslations('Appointments.drag');
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

  // ---------------------------------------------------------------- moving a booking
  type Placed = (typeof items)[number];
  const movable = (a: Placed) => !!onMove && a.status === 'confirmed' && new Date(a.start_at).getTime() > (now ?? 0);
  const press = useRef<{ id: string; x: number; y: number; active: boolean; timer: ReturnType<typeof setTimeout> | null; columnPx: number } | null>(null);
  const suppressClick = useRef(false);
  const step = (a: Placed) => Math.max(5, stepFor?.(a) ?? 15);

  // While a touch drag is active the page must not scroll (a passive listener cannot stop it).
  useEffect(() => {
    const el = gridRef.current;
    if (!el) return;
    const block = (event: TouchEvent) => { if (press.current?.active) event.preventDefault(); };
    el.addEventListener('touchmove', block, { passive: false });
    return () => el.removeEventListener('touchmove', block);
  }, []);

  const endPress = () => {
    if (press.current?.timer) clearTimeout(press.current.timer);
    press.current = null;
    setDrag(null);
  };
  const dragHandlers = (a: Placed) => movable(a) ? {
    onPointerDown: (e: React.PointerEvent<HTMLButtonElement>) => {
      if (e.button !== 0) return;
      const columnPx = e.currentTarget.parentElement?.getBoundingClientRect().width ?? 0;
      const touch = e.pointerType === 'touch';
      press.current = { id: a.id, x: e.clientX, y: e.clientY, active: false, columnPx, timer: null };
      if (touch) press.current.timer = setTimeout(() => {
        if (press.current?.id !== a.id) return;
        press.current.active = true;
        setDrag({ id: a.id, dx: 0, dy: 0 });
      }, LONG_PRESS_MS);
      e.currentTarget.setPointerCapture?.(e.pointerId);
    },
    onPointerMove: (e: React.PointerEvent<HTMLButtonElement>) => {
      const p = press.current;
      if (!p || p.id !== a.id) return;
      const dx = e.clientX - p.x, dy = e.clientY - p.y;
      if (!p.active) {
        if (Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return;
        // A touch that moves before the long press is a scroll, not a drag.
        if (e.pointerType === 'touch') return endPress();
        p.active = true;
      }
      setDrag({ id: a.id, dx, dy });
    },
    onPointerUp: (e: React.PointerEvent<HTMLButtonElement>) => {
      const p = press.current;
      if (!p || p.id !== a.id) return;
      if (p.active) {
        suppressClick.current = true;
        const target = dropTarget(a, e.clientX - p.x, e.clientY - p.y, p.columnPx, days, step(a));
        if (target) onMove?.({ item: a, ...target });
      }
      endPress();
    },
    onPointerCancel: endPress,
    onKeyDown: (e: React.KeyboardEvent<HTMLButtonElement>) => {
      const k = keyMove?.id === a.id ? keyMove : null;
      const cur = k ?? { id: a.id, minutes: a.start, dayShift: 0 };
      const s = step(a);
      const index = days.indexOf(a.day);
      if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        e.preventDefault();
        setKeyMove({ ...cur, minutes: snapDrag(cur.minutes, e.key === 'ArrowUp' ? -s : s, 60, s, a.end - a.start) });
      } else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        e.preventDefault();
        const dayShift = Math.min(Math.max(-index, cur.dayShift + (e.key === 'ArrowLeft' ? -1 : 1)), days.length - 1 - index);
        setKeyMove({ ...cur, dayShift });
      } else if (e.key === 'Escape' && k) {
        e.preventDefault();
        setKeyMove(null);
      } else if (e.key === 'Enter' && k) {
        e.preventDefault();
        suppressClick.current = true;
        setKeyMove(null);
        const day = days[index + k.dayShift] ?? a.day;
        if (day !== a.day || k.minutes !== a.start) onMove?.({ item: a, day, minutes: k.minutes });
      }
    },
  } : {};
  const open = (id: string) => {
    if (suppressClick.current) { suppressClick.current = false; return; }
    onOpen(id);
  };

  return (
    <div>
      <div className="overflow-x-auto rounded-xl border border-border bg-card">
        <div ref={gridRef} className="min-w-[760px]" role="grid" aria-label={t('gridLabel')}>
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
                    const k = keyMove?.id === a.id ? keyMove : null;
                    const d = drag?.id === a.id ? drag : null;
                    const shownStart = k ? k.minutes : a.start;
                    const top = ((shownStart - frame.startHour * 60) / 60) * HOUR_PX;
                    const moving = !!(k || d);
                    const shift = d ? `translate(${d.dx}px, ${d.dy}px)` : k ? `translateX(${k.dayShift * 100}%)` : undefined;
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
                        onClick={() => open(a.id)}
                        onBlur={() => { if (k) setKeyMove(null); }}
                        data-movable={movable(a) ? 'true' : undefined}
                        {...dragHandlers(a)}
                        className={`absolute flex overflow-hidden rounded-lg border-l-[3px] px-2 text-left text-xs leading-tight transition-shadow duration-150 hover:z-10 hover:shadow-md focus-visible:z-10 focus-visible:outline-2 focus-visible:outline-primary ${tone} ${short ? 'flex-row items-center gap-1.5' : 'flex-col items-start py-1'} ${moving ? 'z-20 shadow-lg ring-2 ring-primary' : ''} ${movable(a) ? 'cursor-grab select-none' : ''}`}
                        style={{ top, height, left: `calc(${(index / lanes) * 100}% + 2px)`, width: `calc(${100 / lanes}% - 4px)`, transform: shift }}
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
      {onMove && <p className="mt-1 text-xs text-muted-foreground">{tDrag('hint')}</p>}
    </div>
  );
}
