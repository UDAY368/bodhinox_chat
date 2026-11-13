'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { useFormatter, useTranslations } from 'next-intl';

import { authFetch } from '@/lib/auth/client';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/dashboard/skeleton';
import { EmptyState } from '@/components/dashboard/empty-state';

/** Query string for a report: the range plus any filters (empty values dropped). */
export function reportQuery(values: Record<string, string | null | undefined>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) if (value) params.set(key, value);
  return params.toString();
}

/**
 * Loads one report. The result is keyed by its URL so a stale response for an
 * earlier range is never shown, and nothing is set synchronously in the effect.
 */
export function useReport<T>(path: string, query: string, enabled = true) {
  const url = `/api/analytics/${path}?${query}`;
  const [result, setResult] = useState<{ url: string; data: T | null; error: boolean } | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    authFetch(url, { cache: 'no-store', signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error('report');
        const data = (await response.json()) as T;
        if (!controller.signal.aborted) setResult({ url, data, error: false });
      })
      .catch(() => {
        if (!controller.signal.aborted) setResult({ url, data: null, error: true });
      });
    return () => controller.abort();
  }, [url, enabled, attempt]);
  const current = result?.url === url ? result : null;
  return {
    data: current?.data ?? null,
    error: current?.error ?? false,
    loading: enabled && !current,
    retry: () => {
      setResult(null);
      setAttempt((n) => n + 1);
    },
  };
}

/** Formats seconds as the two largest units ("4m 12s", "3h 5m", "2d 4h"). */
export function useDuration() {
  const t = useTranslations('Analytics.duration');
  return (seconds: number | null | undefined): string => {
    if (seconds == null) return t('none');
    const s = Math.max(0, Math.round(seconds));
    if (s < 60) return t('seconds', { s });
    if (s < 3600) return t('minutes', { m: Math.floor(s / 60), s: s % 60 });
    if (s < 86_400) return t('hours', { h: Math.floor(s / 3600), m: Math.floor((s % 3600) / 60) });
    return t('days', { d: Math.floor(s / 86_400), h: Math.floor((s % 86_400) / 3600) });
  };
}

export function Panel({
  title,
  description,
  actions,
  children,
}: {
  title: string;
  description?: string;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="flex min-w-0 flex-col gap-4 rounded-xl border border-border bg-card p-4 sm:p-5" aria-label={title}>
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-[15px] font-semibold tracking-tight text-foreground">{title}</h2>
          {description && <p className="mt-0.5 text-xs text-muted-foreground">{description}</p>}
        </div>
        {actions}
      </header>
      <div className="min-w-0">{children}</div>
    </section>
  );
}

/** Loading, error and empty states shared by every report panel. */
export function ReportState({
  loading,
  error,
  empty,
  onRetry,
  children,
}: {
  loading: boolean;
  error: boolean;
  empty?: boolean;
  onRetry: () => void;
  children: ReactNode;
}) {
  const t = useTranslations('Analytics');
  if (loading) return <Skeleton className="h-48 w-full" />;
  if (error)
    return (
      <div role="alert" className="flex flex-wrap items-center gap-3 text-sm text-muted-foreground">
        {t('loadFailed')}
        <Button size="sm" variant="outline" onClick={onRetry}>
          {t('retry')}
        </Button>
      </div>
    );
  if (empty) return <EmptyState title={t('emptyTitle')} hint={t('emptyHint')} />;
  return <>{children}</>;
}

/**
 * A chart with its data as a table. The chart is decorative for assistive
 * technology (labelled as an image); the table holds the same numbers.
 */
export function ChartWithTable({
  label,
  chart,
  columns,
  rows,
}: {
  label: string;
  chart: ReactNode;
  columns: string[];
  rows: (string | number)[][];
}) {
  const t = useTranslations('Analytics');
  const format = useFormatter();
  return (
    <div className="space-y-3">
      <div role="img" aria-label={label}>
        {chart}
      </div>
      <details className="text-sm">
        <summary className="w-fit cursor-pointer rounded-md text-xs font-medium text-muted-foreground transition-colors duration-150 hover:text-foreground">{t('showTable')}</summary>
        <DataTable
          caption={label}
          columns={columns}
          rows={rows.map((row) => row.map((cell) => (typeof cell === 'number' ? format.number(cell) : cell)))}
        />
      </details>
    </div>
  );
}

export function DataTable({
  caption,
  columns,
  rows,
  captionHidden = true,
}: {
  caption: string;
  columns: string[];
  rows: ReactNode[][];
  captionHidden?: boolean;
}) {
  return (
    <div className="relative mt-2 overflow-x-auto rounded-lg border border-border">
      <table className="w-full text-sm">
        <caption className={captionHidden ? 'sr-only' : 'px-3.5 pt-2.5 pb-2 text-left text-xs text-muted-foreground'}>{caption}</caption>
        <thead>
          <tr className="bg-muted text-left text-xs text-muted-foreground">
            {columns.map((column, i) => (
              <th key={column} scope="col" className={i === 0 ? 'px-3.5 py-2 font-semibold whitespace-nowrap' : 'px-3.5 py-2 text-right font-semibold whitespace-nowrap'}>
                {column}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, r) => (
            <tr key={r} className="border-t border-border transition-colors duration-150 hover:bg-muted/50">
              {row.map((cell, i) =>
                i === 0 ? (
                  <th key={i} scope="row" className="px-3.5 py-2.5 text-left font-normal text-foreground">
                    {cell}
                  </th>
                ) : (
                  <td key={i} className="px-3.5 py-2.5 text-right whitespace-nowrap tabular-nums">
                    {cell}
                  </td>
                ),
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
