'use client';

import Link from 'next/link';
import { useState, type ReactNode } from 'react';
import { useTranslations } from 'next-intl';

import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/dashboard/skeleton';
import { segmentedItem, segmentedTrack } from '@/components/dashboard/segmented';
import { cn } from '@/lib/utils';
import type { Delta } from './format';

/** A titled card in the 12-column analytics grid. `span` is its width from 1000px up. */
export function InsightCard({ title, sub, tools, span = 12, children, className }: {
  title: string;
  sub?: string;
  tools?: ReactNode;
  span?: 4 | 6 | 8 | 12;
  children: ReactNode;
  className?: string;
}) {
  const spans = { 4: 'min-[1000px]:col-span-4', 6: 'min-[1000px]:col-span-6', 8: 'min-[1000px]:col-span-8', 12: '' };
  return (
    <section aria-label={title} className={cn('col-span-12 flex min-w-0 flex-col gap-3.5 rounded-xl border border-border bg-card p-4 sm:p-5', spans[span], className)}>
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-[15px] font-semibold tracking-tight text-foreground">{title}</h2>
          {sub && <p className="mt-0.5 text-xs text-muted-foreground">{sub}</p>}
        </div>
        {tools}
      </header>
      <div className="min-w-0">{children}</div>
    </section>
  );
}

export function Grid({ children }: { children: ReactNode }) {
  return <div className="grid grid-cols-12 gap-3.5">{children}</div>;
}

export interface Stat {
  label: string;
  value: string;
  delta?: Delta | null;
  href?: string;
}

const toneClass = { good: 'text-emerald-600 dark:text-emerald-400', bad: 'text-red-600 dark:text-red-400', neutral: 'text-muted-foreground' };

/** A row of stat cards; a card with `href` links to the tab that explains it. */
export function StatRow({ stats, loading }: { stats: Stat[]; loading?: boolean }) {
  const cols = stats.length >= 6 ? 'min-[761px]:grid-cols-3 min-[1281px]:grid-cols-6' : stats.length === 5 ? 'min-[761px]:grid-cols-3 min-[1281px]:grid-cols-5' : 'min-[761px]:grid-cols-4';
  return (
    <div className={cn('grid grid-cols-2 gap-3', cols)}>
      {stats.map((s) => {
        const body = (
          <>
            <small className="truncate text-xs font-medium text-muted-foreground">{s.label}</small>
            {loading ? <Skeleton className="h-7 w-20" /> : <strong className="text-[21px] leading-tight font-bold tracking-tight [overflow-wrap:anywhere] text-foreground tabular-nums sm:text-2xl">{s.value}</strong>}
            {!loading && s.delta && <em className={cn('text-xs font-semibold not-italic tabular-nums', toneClass[s.delta.tone])}>{s.delta.text}</em>}
          </>
        );
        const cls = 'flex min-w-0 flex-col gap-1 rounded-xl border border-border bg-card p-4 text-left';
        return s.href ? (
          <Link key={s.label} href={s.href} className={cn(cls, 'transition-colors duration-150 outline-none hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring/50')}>{body}</Link>
        ) : (
          <div key={s.label} className={cls}>{body}</div>
        );
      })}
    </div>
  );
}

/** Loading and error states for a card body. */
export function Loadable({ loading, error, onRetry, height = 'h-48', children }: {
  loading: boolean; error: boolean; onRetry: () => void; height?: string; children: ReactNode;
}) {
  const t = useTranslations('Analytics');
  if (loading) return <Skeleton className={cn('w-full', height)} />;
  if (error)
    return (
      <div role="alert" className="flex flex-wrap items-center gap-3 text-sm text-muted-foreground">
        {t('loadFailed')}
        <Button size="sm" variant="outline" onClick={onRetry}>{t('retry')}</Button>
      </div>
    );
  return <>{children}</>;
}

export function Empty({ title, text, action }: { title: string; text?: string; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-1.5 px-4 py-8 text-center">
      <strong className="text-sm font-semibold text-foreground">{title}</strong>
      {text && <p className="max-w-sm text-xs text-muted-foreground">{text}</p>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}

/** A two-option toggle in a card header (Counts / Rates, Runs / Click rate). */
export function MiniToggle<T extends string>({ label, value, options, onChange }: {
  label: string; value: T; options: [T, string][]; onChange: (value: T) => void;
}) {
  return (
    <div role="group" aria-label={label} className={segmentedTrack}>
      {options.map(([v, text]) => (
        <button key={v} type="button" aria-pressed={value === v} onClick={() => onChange(v)} className={segmentedItem(value === v, 'h-[26px] px-2.5 text-xs')}>
          {text}
        </button>
      ))}
    </div>
  );
}

export interface Column<R> {
  key: string;
  label: string;
  numeric?: boolean;
  sort: (row: R) => number | string;
  cell: (row: R) => ReactNode;
}

/** A table whose headers sort it (aria-sort), with an optional row limit and click-through rows. */
export function SortableTable<R>({ caption, columns, rows, rowKey, initial, limit, onRow, rowLabel }: {
  caption: string;
  columns: Column<R>[];
  rows: R[];
  rowKey: (row: R) => string;
  initial: { key: string; dir: 1 | -1 };
  limit?: number;
  /** Clicking a row opens it (its first cell should hold a button for keyboard users). */
  onRow?: (row: R) => void;
  rowLabel?: (row: R) => string;
}) {
  const [sort, setSort] = useState(initial);
  const column = columns.find((c) => c.key === sort.key) ?? columns[0];
  const sorted = [...rows].sort((a, b) => {
    const x = column.sort(a), y = column.sort(b);
    return (typeof x === 'string' && typeof y === 'string' ? x.localeCompare(y) : Number(x) - Number(y)) * sort.dir;
  });
  const shown = limit ? sorted.slice(0, limit) : sorted;
  return (
    <div className="overflow-x-auto rounded-lg border border-border">
      <table className="w-full min-w-[560px] text-sm">
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr className="bg-muted text-left text-xs text-muted-foreground">
            {columns.map((c) => {
              const on = sort.key === c.key;
              return (
                <th key={c.key} scope="col" aria-sort={on ? (sort.dir > 0 ? 'ascending' : 'descending') : 'none'} className={cn('px-3.5 py-2 font-semibold whitespace-nowrap', c.numeric && 'text-right')}>
                  <button
                    type="button"
                    onClick={() => setSort((s) => ({ key: c.key, dir: s.key === c.key ? (s.dir === 1 ? -1 : 1) : c.numeric ? -1 : 1 }))}
                    className={cn('inline-flex items-center gap-1 rounded outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50', on && 'text-foreground')}
                  >
                    {c.label}
                    <span aria-hidden className={cn('text-[9px]', !on && 'opacity-0')}>{on && sort.dir < 0 ? '▼' : '▲'}</span>
                  </button>
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {shown.map((row) => (
            <tr
              key={rowKey(row)}
              onClick={onRow ? () => onRow(row) : undefined}
              aria-label={rowLabel?.(row)}
              className={cn('border-t border-border transition-colors duration-150 hover:bg-muted/50', onRow && 'cursor-pointer')}
            >
              {columns.map((c) => (
                <td key={c.key} className={cn('px-3.5 py-2.5', c.numeric && 'text-right whitespace-nowrap tabular-nums')}>{c.cell(row)}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
