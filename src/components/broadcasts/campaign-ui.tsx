'use client';

// Small presentational pieces shared by the Campaigns screens (broadcasts,
// templates, ads, forms) so they read as one calm, consistent system:
// page header and empty state (thin wrappers over the shared PageHeader and
// EmptyState), search box, soft status pill, thin progress bar and stat
// block. Markup only — no data, no handlers of their own.

import type { ComponentType, ReactNode } from 'react';
import { Search } from 'lucide-react';
import { cn } from '@/lib/utils';
import { EmptyState } from '@/components/ui/empty-state';
import { PageHeader } from '@/components/ui/page-header';

/** The Campaigns screens' large title: the shared PageHeader, `actions` as its primary action. */
export function CampaignHeader({
  title,
  description,
  actions,
  className,
}: {
  title: string;
  description?: ReactNode;
  actions?: ReactNode;
  className?: string;
}) {
  return <PageHeader title={title} subtitle={description} primaryAction={actions} className={cn('mb-0', className)} />;
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

/** The Campaigns screens' empty state: the shared EmptyState (one icon, one line, one action). */
export function CampaignEmpty({
  icon,
  title,
  description,
  action,
  className,
}: {
  icon: ComponentType<{ className?: string }>;
  title: string;
  description?: string;
  action?: ReactNode;
  className?: string;
}) {
  return <EmptyState icon={icon} title={title} body={description} action={action} className={className} />;
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
