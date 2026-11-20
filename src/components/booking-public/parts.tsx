'use client';

/**
 * The few pieces the public booking and manage pages need on top of the
 * shared kit (PageHeader, GroupedList, InlineError, PageLoading): a back
 * link above the title, a label/value row that wraps long values, the one
 * primary button pinned to the bottom on phones, and the calendar buttons.
 */
import type { ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { CalendarPlus, ChevronLeft } from 'lucide-react';
import { buttonVariants } from '@/components/ui/button';
import { PageHeader } from '@/components/ui/page-header';
import { cn } from '@/lib/utils';

/** Minimum touch height (44 px) for every tappable control here. */
export const TAP = 'min-h-11';

/** The page's large title, with the business (and step) under it and an optional Back above it. */
export function BookingHeader({ title, subtitle, onBack, backLabel }: {
  title: string; subtitle?: string | null; onBack?: () => void; backLabel?: string;
}) {
  return (
    <div>
      {onBack && (
        <button type="button" onClick={onBack}
          className={cn(TAP, '-ml-2 mb-1 inline-flex items-center gap-1 rounded-control px-2 text-callout text-primary hover:bg-muted')}>
          <ChevronLeft className="size-4" aria-hidden />
          {backLabel}
        </button>
      )}
      <PageHeader title={title} subtitle={subtitle ?? undefined} className="mb-0" />
    </div>
  );
}

/** A label/value row inside a GroupedList; the value wraps instead of being cut. */
export function InfoRow({ label, children, testId }: { label: string; children: ReactNode; testId?: string }) {
  return (
    <div className="relative flex min-h-11 items-start justify-between gap-4 px-4 py-2.5 text-body
      not-first:before:absolute not-first:before:top-0 not-first:before:right-0 not-first:before:left-4 not-first:before:h-px not-first:before:bg-separator">
      <span className="shrink-0 text-muted-foreground">{label}</span>
      <span className="min-w-0 text-right" data-testid={testId}>{children}</span>
    </div>
  );
}

/** The one primary action: pinned to the bottom of the screen on phones, inline from `sm` up. */
export function BottomBar({ children }: { children: ReactNode }) {
  return (
    <>
      {/* Room for the pinned bar so it never covers the last row. */}
      <div className="h-24 sm:hidden" aria-hidden />
      <div className="material-chrome fixed inset-x-0 bottom-0 z-20 border-t border-separator px-4 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]
        sm:static sm:z-auto sm:border-0 sm:bg-transparent sm:p-0 sm:backdrop-blur-none">
        <div className="mx-auto flex max-w-lg flex-col gap-2 sm:flex-row sm:justify-end">{children}</div>
      </div>
    </>
  );
}

/** "Add to calendar" (.ics) and "Google Calendar". */
export function CalendarButtons({ icsHref, googleHref }: { icsHref: string | null; googleHref: string }) {
  const t = useTranslations('BookingPublic');
  return (
    <div className="grid gap-2 sm:grid-cols-2">
      {icsHref && (
        <a href={icsHref} download="booking.ics" className={cn(buttonVariants({ variant: 'outline' }), TAP)} data-testid="add-to-calendar">
          <CalendarPlus className="size-4" aria-hidden />
          {t('addToCalendar')}
        </a>
      )}
      <a href={googleHref} target="_blank" rel="noopener noreferrer" className={cn(buttonVariants({ variant: 'outline' }), TAP)}
        data-testid="google-calendar">
        <CalendarPlus className="size-4" aria-hidden />
        {t('googleCalendar')}
      </a>
    </div>
  );
}
