'use client';

// Small presentational pieces shared by the Campaigns screens (broadcasts,
// templates, ads, forms) so they read as one calm, consistent system:
// page header, segmented filter, search box, soft status pill, thin
// progress bar, stat block and a centred empty state. Markup only — no
// data, no handlers of their own.

import type { ComponentType, ReactNode } from 'react';
import { Search } from 'lucide-react';
import { cn } from '@/lib/utils';

export function CampaignHeader({
  title,
  description,
  actions,
  className,
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('flex flex-wrap items-start justify-between gap-4', className)}>
      <div className="min-w-0 flex-1 basis-64">
        <h1 className="text-[22px] font-bold leading-tight tracking-tight text-foreground">{title}</h1>
        {description && <p className="mt-1 text-sm text-muted-foreground">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

export interface SegmentItem<V extends string> {
  value: V;
  label: ReactNode;
  count?: number;
}

/** Segmented control rendered as a tablist (keeps role="tab" names). */
export function SegmentedTabs<V extends string>({
  items,
  value,
  onChange,
  ariaLabel,
  className,
}: {
  items: SegmentItem<V>[];
  value: V;
  onChange: (value: V) => void;
  ariaLabel: string;
  className?: string;
}) {
  return (
    <div
      role="tablist"
      aria-label={ariaLabel}
      className={cn('flex max-w-full gap-0.5 overflow-x-auto rounded-xl bg-muted p-[3px] [scrollbar-width:none]', className)}
    >
      {items.map((item) => {
        const on = item.value === value;
        return (
          <button
            key={item.value}
            type="button"
            role="tab"
            aria-selected={on}
            onClick={() => onChange(item.value)}
            className={cn(
              'inline-flex h-[30px] shrink-0 items-center gap-1.5 whitespace-nowrap rounded-[9px] px-3 text-[13px] font-medium transition-colors duration-150',
              on ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {item.label}
            {item.count !== undefined && <span className="tabular-nums text-muted-foreground">{item.count}</span>}
          </button>
        );
      })}
    </div>
  );
}

export function SearchField({
  value,
  onChange,
  placeholder,
  ariaLabel,
  className,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  ariaLabel: string;
  className?: string;
}) {
  return (
    <label
      className={cn(
        'flex h-9 w-full items-center gap-2 rounded-xl bg-muted px-3 text-muted-foreground transition-shadow duration-150 focus-within:ring-2 focus-within:ring-ring sm:w-64',
        className,
      )}
    >
      <Search className="size-4 shrink-0" aria-hidden />
      <input
        type="search"
        aria-label={ariaLabel}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="min-w-0 flex-1 bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground"
      />
    </label>
  );
}

export type PillTone = 'neutral' | 'ok' | 'warn' | 'bad' | 'accent';

const PILL_TONES: Record<PillTone, string> = {
  neutral: 'bg-muted text-muted-foreground',
  ok: 'bg-emerald-500/12 text-emerald-700 dark:text-emerald-400',
  warn: 'bg-amber-500/12 text-amber-700 dark:text-amber-400',
  bad: 'bg-red-500/12 text-red-600 dark:text-red-400',
  accent: 'bg-primary/10 text-primary',
};

export function StatusPill({
  tone = 'neutral',
  pulse,
  children,
  className,
}: {
  tone?: PillTone;
  pulse?: boolean;
  children: ReactNode;
  className?: string;
}) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 py-0.5 text-xs font-medium',
        PILL_TONES[tone],
        className,
      )}
    >
      {pulse && <span className="size-1.5 animate-pulse rounded-full bg-current" aria-hidden />}
      {children}
    </span>
  );
}

export function ProgressBar({ pct, className, label }: { pct: number; className?: string; label?: string }) {
  const width = Math.max(0, Math.min(100, pct));
  return (
    <div className={cn('h-1.5 w-20 overflow-hidden rounded-full bg-muted', className)} title={label}>
      <div className="h-full rounded-full bg-primary transition-[width] duration-300" style={{ width: `${width}%` }} />
    </div>
  );
}

export function StatBlock({ label, value, className }: { label: ReactNode; value: ReactNode; className?: string }) {
  return (
    <div className={cn('flex min-w-0 flex-col leading-tight', className)}>
      <b className="text-sm font-semibold tabular-nums text-foreground">{value}</b>
      <small className="truncate text-[11px] text-muted-foreground">{label}</small>
    </div>
  );
}

export function IconTile({ icon: Icon, className }: { icon: ComponentType<{ className?: string }>; className?: string }) {
  return (
    <span className={cn('inline-flex size-9 shrink-0 items-center justify-center rounded-[10px] bg-primary/10 text-primary', className)} aria-hidden>
      <Icon className="size-[18px]" />
    </span>
  );
}

export function CampaignEmpty({
  icon: Icon,
  title,
  description,
  action,
  className,
}: {
  icon: ComponentType<{ className?: string }>;
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('flex flex-col items-center gap-2 rounded-xl border border-border bg-card px-4 py-12 text-center', className)}>
      <span className="mb-1 inline-flex size-13 items-center justify-center rounded-2xl bg-primary/10 text-primary" aria-hidden>
        <Icon className="size-6" />
      </span>
      <p className="text-[15px] font-semibold text-foreground">{title}</p>
      {description && <p className="max-w-sm text-sm text-muted-foreground">{description}</p>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}

/** Soft pill tone per broadcast status (presentation only; labels come from the shared status config). */
export const BROADCAST_STATUS_TONE: Record<string, PillTone> = {
  draft: 'neutral',
  scheduled: 'accent',
  sending: 'warn',
  sent: 'ok',
  failed: 'bad',
  cancelled: 'neutral',
  paused: 'warn',
};
