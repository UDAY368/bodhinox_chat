'use client';

/**
 * Small SVG charts for the analytics tabs: a line or grouped-bar chart over an
 * axis, a donut, a bar list and a 24-hour heatmap. Each chart is keyboard
 * readable: focus it and use the arrow keys (Home and End on a line chart) to
 * move through the values, which are read out by a polite live region and
 * shown in a tooltip. Colours come from the theme tokens.
 */

import Link from 'next/link';
import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { useTranslations } from 'next-intl';

import { cn } from '@/lib/utils';

export const CHART_COLORS = {
  primary: 'var(--primary)',
  secondary: 'var(--muted-foreground)',
  whatsapp: 'var(--chart-3)',
  instagram: 'var(--chart-5)',
  bad: 'var(--destructive)',
  soft: 'var(--chart-2)',
} as const;

/** Width of an element, kept current with a ResizeObserver. */
function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const update = () => setWidth(Math.round(el.clientWidth));
    update();
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return [ref, width] as const;
}

/** A round axis maximum at or above `value` (1, 2 or 5 times a power of ten, times 4 ticks). */
export function niceMax(value: number, integer = true): number {
  const raw = Math.max(integer ? 4 : 0.0001, value) / 4;
  const power = 10 ** Math.floor(Math.log10(raw));
  const m = raw / power;
  return (m <= 1 ? 1 : m <= 2 ? 2 : m <= 5 ? 5 : 10) * power * 4;
}

function Tooltip({ x, y, width, title, rows }: { x: number; y: number; width: number; title: string; rows: [string, string, string][] }) {
  const w = 190;
  const left = Math.max(0, Math.min(x - w / 2, width - w));
  return (
    <div
      aria-hidden
      className="pointer-events-none absolute z-10 grid gap-0.5 rounded-lg border border-border bg-popover px-2.5 py-2 text-xs text-popover-foreground shadow-lg"
      style={{ left, top: Math.max(0, y - 12), width: w, transform: 'translateY(-100%)' }}
    >
      <strong className="truncate font-semibold">{title}</strong>
      {rows.map(([color, name, value]) => (
        <span key={name} className="flex items-center gap-1.5 text-muted-foreground">
          <i className="size-2 shrink-0 rounded-full" style={{ background: color }} />
          <span className="truncate">{name}</span>
          <b className="ml-auto pl-3 font-semibold text-foreground tabular-nums">{value}</b>
        </span>
      ))}
    </div>
  );
}

export interface Series {
  key: string;
  name: string;
  color: string;
  values: (number | null)[];
  area?: boolean;
  dash?: boolean;
}

/** Line (or grouped bars) over an x axis, with a keyboard-readable tooltip. */
export function XYChart({
  label,
  labels,
  long,
  series,
  type = 'line',
  format,
  axisFormat,
  height = 220,
  integer = true,
}: {
  label: string;
  labels: string[];
  /** Full names of each point for the tooltip (defaults to labels). */
  long?: string[];
  series: Series[];
  type?: 'line' | 'bars';
  format: (value: number | null) => string;
  axisFormat?: (value: number) => string;
  height?: number;
  integer?: boolean;
}) {
  const t = useTranslations('Analytics.insights.chart');
  const [ref, width] = useWidth<HTMLDivElement>();
  const [active, setActive] = useState<number | null>(null);
  const n = labels.length;
  const bars = type === 'bars';
  const names = long ?? labels;
  if (!n) return <p className="py-6 text-center text-sm text-muted-foreground">{t('nothing')}</p>;

  const pl = 46, pr = 10, pt = 10, pb = 24;
  const iw = Math.max(40, width - pl - pr), ih = height - pt - pb, gw = iw / n, base = pt + ih;
  const max = niceMax(Math.max(0, ...series.flatMap((s) => s.values.map((v) => v ?? 0))), integer);
  const X = (i: number) => (bars || n === 1 ? pl + (i + 0.5) * gw : pl + (i * iw) / (n - 1));
  const Y = (v: number | null) => base - ((v ?? 0) / max) * ih;
  const every = Math.max(1, Math.ceil(n / Math.max(2, Math.floor(iw / 62))));
  const axis = axisFormat ?? ((v: number) => format(v));
  const point = (i: number) => Math.max(0, Math.min(n - 1, i));
  const fromPointer = (clientX: number, rect: DOMRect) => {
    const px = clientX - rect.left - pl;
    return point(bars || n === 1 ? Math.floor(px / gw) : Math.round((px / iw) * (n - 1)));
  };
  const onKey = (event: KeyboardEvent<SVGSVGElement>) => {
    const current = active ?? n - 1;
    const next = ({ ArrowRight: current + 1, ArrowLeft: current - 1, Home: 0, End: n - 1 } as Record<string, number>)[event.key];
    if (next !== undefined) {
      event.preventDefault();
      setActive(point(next));
    } else if (event.key === 'Escape') setActive(null);
  };
  const tipTop = active == null ? 0 : Math.min(...series.map((s) => Y(s.values[active])));
  const announce = active == null ? '' : `${names[active]}: ${series.map((s) => `${s.name} ${format(s.values[active])}`).join(', ')}`;

  return (
    <div ref={ref} className="relative min-w-0">
      {width > 0 && (
        <svg
          viewBox={`0 0 ${width} ${height}`}
          width={width}
          height={height}
          tabIndex={0}
          role="group"
          aria-roledescription={t('roleDescription')}
          aria-label={t('lineLabel', { label, count: n })}
          className="block cursor-crosshair touch-pan-y overflow-visible rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
          onPointerMove={(e) => setActive(fromPointer(e.clientX, e.currentTarget.getBoundingClientRect()))}
          onPointerDown={(e) => setActive(fromPointer(e.clientX, e.currentTarget.getBoundingClientRect()))}
          onPointerLeave={() => setActive(null)}
          onFocus={(e) => { if (e.currentTarget.matches(':focus-visible')) setActive((a) => a ?? n - 1); }}
          onBlur={() => setActive(null)}
          onKeyDown={onKey}
        >
          {[0, 1, 2, 3, 4].map((tick) => {
            const y = Y((max * tick) / 4);
            return (
              <g key={tick}>
                <line x1={pl} x2={width - pr} y1={y} y2={y} className="stroke-border" strokeWidth={1} />
                <text x={pl - 8} y={y + 4} textAnchor="end" className="fill-muted-foreground text-[11px] tabular-nums">{axis((max * tick) / 4)}</text>
              </g>
            );
          })}
          {labels.map((l, i) =>
            i % every === 0 && (n - 1 - i >= every / 2 || i === n - 1 || every === 1) ? (
              <text key={i} x={X(i)} y={height - 5} textAnchor="middle" className="fill-muted-foreground text-[11px]">{l}</text>
            ) : null,
          )}
          {active != null && bars && <rect x={pl + active * gw} y={pt} width={gw} height={ih} rx={4} className="fill-muted" />}
          {active != null && !bars && <line x1={X(active)} x2={X(active)} y1={pt} y2={base} className="stroke-muted-foreground" strokeDasharray="3 3" />}
          {series.map((s, j) => {
            if (bars) {
              const bw = Math.min(28, (gw * 0.72) / series.length);
              return s.values.map((v, i) => (
                <rect key={`${s.key}-${i}`} x={X(i) - (series.length * bw) / 2 + j * bw + 1} y={Y(v)} width={Math.max(1, bw - 2)}
                  height={Math.max(0, base - Y(v))} rx={Math.min(3, bw / 3)} style={{ fill: s.color }} />
              ));
            }
            const d = s.values.map((v, i) => `${i ? 'L' : 'M'}${X(i).toFixed(1)} ${Y(v).toFixed(1)}`).join('');
            return (
              <g key={s.key}>
                {s.area && n > 1 && <path d={`${d}L${X(n - 1)} ${base}L${X(0)} ${base}Z`} style={{ fill: s.color }} fillOpacity={0.1} />}
                {n > 1
                  ? <path d={d} fill="none" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" style={{ stroke: s.color }} strokeDasharray={s.dash ? '5 5' : undefined} />
                  : <circle cx={X(0)} cy={Y(s.values[0])} r={4} style={{ fill: s.color }} />}
              </g>
            );
          })}
          {active != null && !bars && series.map((s) => (
            <circle key={s.key} cx={X(active)} cy={Y(s.values[active])} r={4.5} className="stroke-card" strokeWidth={2} style={{ fill: s.color }} />
          ))}
        </svg>
      )}
      {active != null && width > 0 && (
        <Tooltip x={X(active)} y={tipTop} width={width} title={names[active]}
          rows={series.map((s) => [s.color, s.name, format(s.values[active])])} />
      )}
      <p className="sr-only" aria-live="polite">{announce}</p>
    </div>
  );
}

/** Legend buttons that show or hide series; the last visible one cannot be hidden. */
export function Legend({ series, hidden, onToggle }: { series: { key: string; name: string; color: string }[]; hidden: Set<string>; onToggle: (key: string) => void }) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {series.map((s) => {
        const on = !hidden.has(s.key);
        const last = on && series.filter((x) => !hidden.has(x.key)).length === 1;
        return (
          <button
            key={s.key}
            type="button"
            aria-pressed={on}
            aria-disabled={last || undefined}
            onClick={() => !last && onToggle(s.key)}
            className={cn(
              'inline-flex h-7 items-center gap-1.5 rounded-full border border-border px-2.5 text-xs font-medium text-muted-foreground transition-[opacity,background-color] duration-150 outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring/50',
              !on && 'opacity-45',
            )}
          >
            <i className="size-2 rounded-full" style={{ background: s.color }} />
            {s.name}
          </button>
        );
      })}
    </div>
  );
}

export interface DonutSegment {
  key: string;
  name: string;
  color: string;
  value: number;
}

/** A ring split into segments; arrow keys read each part, Enter picks it when `onPick` is given. */
export function Donut({
  label,
  segments,
  centre,
  sub,
  format,
  onPick,
}: {
  label: string;
  segments: DonutSegment[];
  centre: string;
  sub: string;
  format: (value: number) => string;
  onPick?: (key: string) => void;
}) {
  const t = useTranslations('Analytics.insights.chart');
  const [active, setActive] = useState<number | null>(null);
  const sum = segments.reduce((a, s) => a + s.value, 0);
  const R = 46, C = 2 * Math.PI * R;
  const lengths = segments.map((s) => (sum ? (s.value / sum) * C : 0));
  const starts = lengths.map((_, i) => lengths.slice(0, i).reduce((a, b) => a + b, 0));
  const share = (v: number) => (sum ? `${Math.round((v / sum) * 100)}%` : '0%');
  const onKey = (event: KeyboardEvent<SVGSVGElement>) => {
    const step = ({ ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 } as Record<string, number>)[event.key];
    if (step) {
      event.preventDefault();
      setActive((a) => (((a ?? (step > 0 ? -1 : 0)) + step) % segments.length + segments.length) % segments.length);
    } else if (event.key === 'Escape') setActive(null);
    else if (event.key === 'Enter' && onPick && active != null) onPick(segments[active].key);
  };
  const current = active == null ? null : segments[active];
  return (
    <div className="relative">
      <svg
        viewBox="0 0 120 120"
        tabIndex={0}
        role="group"
        aria-roledescription={t('roleDescription')}
        aria-label={t('donutLabel', { label, parts: segments.map((s) => `${s.name} ${format(s.value)}`).join(', ') })}
        className="block size-[148px] overflow-visible rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
        onKeyDown={onKey}
        onBlur={() => setActive(null)}
      >
        <circle cx={60} cy={60} r={R} fill="none" className="stroke-muted" strokeWidth={13} />
        <g transform="rotate(-90 60 60)">
          {segments.map((s, i) => {
            const len = lengths[i];
            const dash = Math.max(0, len - (len > 4 && len < C - 1 ? 1.5 : 0));
            return (
              <circle
                key={s.key}
                cx={60}
                cy={60}
                r={R}
                fill="none"
                strokeWidth={active === i ? 17 : 13}
                strokeDasharray={`${dash} ${C}`}
                strokeDashoffset={-starts[i]}
                style={{ stroke: s.color, transition: 'stroke-width 150ms' }}
                className={onPick ? 'cursor-pointer' : undefined}
                onPointerMove={() => setActive(i)}
                onPointerLeave={() => setActive(null)}
                onClick={onPick ? () => onPick(s.key) : undefined}
              />
            );
          })}
        </g>
        <text x={60} y={62} textAnchor="middle" className="fill-foreground text-[19px] font-bold">{centre}</text>
        <text x={60} y={76} textAnchor="middle" className="fill-muted-foreground text-[9px]">{sub}</text>
      </svg>
      {current && (
        <Tooltip x={74} y={8} width={148} title={current.name} rows={[[current.color, format(current.value), share(current.value)]]} />
      )}
      <p className="sr-only" aria-live="polite">{current ? `${current.name}: ${format(current.value)}, ${share(current.value)}` : ''}</p>
    </div>
  );
}

/** A donut with its key beside it (wraps under it on narrow cards). */
export function DonutWithKey({ donut, children }: { donut: ReactNode; children: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center justify-center gap-4">
      {donut}
      <div className="grid min-w-[150px] flex-1 gap-0.5">{children}</div>
    </div>
  );
}

export function KeyRow({ color, name, value, share, pressed, onClick }: {
  color: string; name: string; value: string; share?: string; pressed?: boolean; onClick?: () => void;
}) {
  const body = (
    <>
      <i className="size-2.5 shrink-0 rounded-full" style={{ background: color }} />
      <span className="min-w-0 flex-1 truncate">{name}</span>
      <b className="font-semibold tabular-nums">{value}</b>
      {share !== undefined && <small className="w-9 text-right text-muted-foreground tabular-nums">{share}</small>}
    </>
  );
  const cls = 'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px]';
  if (!onClick) return <div className={cls}>{body}</div>;
  return (
    <button type="button" aria-pressed={pressed} onClick={onClick}
      className={cn(cls, 'transition-colors duration-150 outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring/50', pressed && 'bg-primary-soft')}>
      {body}
    </button>
  );
}

export interface BarRow {
  key: string;
  name: string;
  value: number;
  text: string;
  color?: string;
  lead?: ReactNode;
  /** A button or a link per row. */
  onClick?: () => void;
  href?: string;
  /** Accessible name of the row's button or link. */
  action?: string;
}

/** Horizontal bars with their values; rows can be buttons or links. */
export function BarList({ rows, max, label }: { rows: BarRow[]; max?: number; label: string }) {
  const top = max || Math.max(1, ...rows.map((r) => r.value));
  const cls = 'grid w-full grid-cols-[minmax(84px,36%)_minmax(0,1fr)_auto] items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] sm:grid-cols-[minmax(96px,30%)_minmax(0,1fr)_auto] sm:gap-3';
  const interactive = 'transition-colors duration-150 outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring/50';
  return (
    <ul className="grid gap-0.5" aria-label={label}>
      {rows.map((r) => {
        const inner = (
          <>
            <span className="flex min-w-0 items-center gap-2">{r.lead}<span className="truncate">{r.name}</span></span>
            <span className="h-2 overflow-hidden rounded-full bg-muted" aria-hidden>
              <i className="block h-full min-w-[2px] rounded-full" style={{ width: `${Math.max(0, Math.min(100, (r.value / top) * 100)).toFixed(1)}%`, background: r.color ?? CHART_COLORS.primary }} />
            </span>
            <b className="min-w-[46px] text-right font-semibold whitespace-nowrap tabular-nums">{r.text}</b>
          </>
        );
        return (
          <li key={r.key}>
            {r.href ? (
              <Link href={r.href} className={cn(cls, interactive)} aria-label={r.action}>{inner}</Link>
            ) : r.onClick ? (
              <button type="button" onClick={r.onClick} className={cn(cls, interactive)} aria-label={r.action}>{inner}</button>
            ) : (
              <div className={cls}>{inner}</div>
            )}
          </li>
        );
      })}
    </ul>
  );
}

/** New conversations by hour of day as 24 shaded cells. */
export function Heatmap({ values, hourLabel, describe }: { values: number[]; hourLabel: (hour: number) => string; describe: (hour: number, value: number) => string }) {
  const t = useTranslations('Analytics.insights.chart');
  const id = useId();
  const [active, setActive] = useState<number | null>(null);
  const peak = Math.max(1, ...values);
  return (
    <div className="relative">
      <div className="grid grid-cols-24 gap-0.5 sm:gap-[3px]" role="list" aria-label={t('heatmapLabel')} id={id}>
        {values.map((v, hour) => (
          <span
            key={hour}
            role="listitem"
            tabIndex={0}
            aria-label={describe(hour, v)}
            onPointerEnter={() => setActive(hour)}
            onPointerLeave={() => setActive(null)}
            onFocus={() => setActive(hour)}
            onBlur={() => setActive(null)}
            className="h-9 rounded-[3px] outline-none transition-transform duration-150 hover:scale-y-105 focus-visible:ring-2 focus-visible:ring-ring/50 sm:h-[46px] sm:rounded-[5px]"
            style={{ background: `color-mix(in srgb, var(--primary) ${Math.round((v / peak) * 92)}%, var(--muted))` }}
          />
        ))}
      </div>
      <div className="mt-1.5 flex justify-between text-[11px] text-muted-foreground" aria-hidden>
        {[0, 6, 12, 18, 23].map((h) => <span key={h}>{hourLabel(h)}</span>)}
      </div>
      {active != null && (
        <p className="pointer-events-none absolute -top-2 left-1/2 z-10 -translate-x-1/2 -translate-y-full rounded-lg border border-border bg-popover px-2.5 py-1.5 text-xs whitespace-nowrap text-popover-foreground shadow-lg" aria-hidden>
          {describe(active, values[active])}
        </p>
      )}
    </div>
  );
}
