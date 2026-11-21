'use client';

// Small shared pieces for the Ads tabs: the status chip (Meta's delivery
// status in plain words) and the loading placeholder.

import { useTranslations } from 'next-intl';
import { cn } from '@/lib/utils';

export type StatusTone = 'active' | 'paused' | 'review' | 'rejected' | 'issues' | 'ended' | 'billing' | 'other';

/** Meta's status (effective_status or status) to a plain-word group. */
export function statusTone(status: string | null | undefined): StatusTone {
  switch (status) {
    case 'ACTIVE': return 'active';
    case 'PAUSED': case 'CAMPAIGN_PAUSED': case 'ADSET_PAUSED': return 'paused';
    case 'PENDING_REVIEW': case 'IN_PROCESS': case 'PREAPPROVED': return 'review';
    case 'DISAPPROVED': return 'rejected';
    case 'WITH_ISSUES': return 'issues';
    case 'ARCHIVED': case 'DELETED': case 'COMPLETED': return 'ended';
    case 'PENDING_BILLING_INFO': return 'billing';
    default: return 'other';
  }
}

const TONE_CLASS: Record<StatusTone, string> = {
  active: 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300',
  paused: 'bg-muted text-muted-foreground',
  review: 'bg-sky-500/10 text-sky-700 dark:text-sky-300',
  rejected: 'bg-destructive/10 text-destructive',
  issues: 'bg-amber-500/10 text-amber-800 dark:text-amber-200',
  ended: 'bg-muted text-muted-foreground',
  billing: 'bg-amber-500/10 text-amber-800 dark:text-amber-200',
  other: 'bg-muted text-muted-foreground',
};

/** A colored chip; the hover title keeps Meta's own status (and the rejection reason, when there is one). */
export function StatusChip({ status, reason }: { status: string | null | undefined; reason?: string | null }) {
  const t = useTranslations('Ads.statusChip');
  if (!status) return <span className="text-muted-foreground">-</span>;
  const tone = statusTone(status);
  const title = [status, reason].filter(Boolean).join(' · ');
  return (
    <span title={title} data-tone={tone}
      className={cn('inline-flex items-center gap-1 whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium', TONE_CLASS[tone])}>
      <span aria-hidden className="size-1.5 rounded-full bg-current opacity-70" />
      {tone === 'other' ? status.toLowerCase().replace(/_/g, ' ') : t(tone)}
    </span>
  );
}

/** Grey rows in place of a spinner, so the tab keeps its shape while it loads. */
export function LoadingRows({ rows = 5, label }: { rows?: number; label?: string }) {
  const t = useTranslations('Ads');
  return (
    <div role="status" aria-label={label ?? t('loading')} className="space-y-2 rounded-xl border border-border bg-card p-3" data-testid="ads-loading">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="flex items-center gap-3">
          <div className="size-8 shrink-0 animate-pulse rounded-md bg-muted" />
          <div className="h-3 flex-1 animate-pulse rounded bg-muted" style={{ maxWidth: `${70 - i * 7}%` }} />
          <div className="hidden h-3 w-16 animate-pulse rounded bg-muted sm:block" />
          <div className="hidden h-3 w-16 animate-pulse rounded bg-muted sm:block" />
        </div>
      ))}
    </div>
  );
}

/** A table header with a plain-word explanation on hover and focus. */
export function MetricHeader({ label, help }: { label: string; help: string }) {
  return (
    <span title={help} tabIndex={0} className="cursor-help whitespace-nowrap underline decoration-dotted decoration-muted-foreground/60 underline-offset-4 outline-none focus-visible:ring-2 focus-visible:ring-ring">
      {label}
    </span>
  );
}
