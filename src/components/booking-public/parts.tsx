'use client';

/**
 * Small phone-first building blocks shared by the public booking and manage
 * pages (design section 6): a large title, grouped rows, a primary button
 * pinned to the bottom on phones, content-shaped placeholders and an error
 * with Retry. Built on the existing UI kit; batch 2's shared pieces replace
 * them once merged.
 */
import type { ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { AlertTriangle, CalendarPlus, Check, ChevronLeft } from 'lucide-react';
import { Button, buttonVariants } from '@/components/ui/button';
import { cn } from '@/lib/utils';

/** Minimum touch height (44 px) for every tappable row and button here. */
export const TAP = 'min-h-11';

export function PageTitle({ eyebrow, title, step, onBack, backLabel }: {
  eyebrow?: string | null; title: string; step?: string | null; onBack?: () => void; backLabel?: string;
}) {
  return (
    <header className="space-y-1">
      {onBack && (
        <button type="button" onClick={onBack} className={cn(TAP, '-ml-2 inline-flex items-center gap-1 rounded-md px-2 text-sm text-primary hover:bg-muted')}>
          <ChevronLeft className="size-4" aria-hidden />
          {backLabel}
        </button>
      )}
      {(eyebrow || step) && (
        <p className="text-muted-foreground text-sm">
          {eyebrow}
          {eyebrow && step && ' · '}
          {step}
        </p>
      )}
      <h1 className="text-3xl font-bold tracking-tight">{title}</h1>
    </header>
  );
}

export function Group({ title, children, footer }: { title?: string; children: ReactNode; footer?: ReactNode }) {
  return (
    <section className="space-y-2">
      {title && <h2 className="text-muted-foreground px-1 text-xs font-medium uppercase tracking-wide">{title}</h2>}
      <div className="divide-border overflow-hidden rounded-xl border bg-card divide-y">{children}</div>
      {footer && <p className="text-muted-foreground px-1 text-xs">{footer}</p>}
    </section>
  );
}

/** A tappable row in a group; `selected` shows a check. */
export function ChoiceRow({ selected, onClick, title, detail, trailing, disabled }: {
  selected: boolean; onClick: () => void; title: ReactNode; detail?: ReactNode; trailing?: ReactNode; disabled?: boolean;
}) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={onClick}
      disabled={disabled}
      className={cn(TAP, 'flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-muted disabled:opacity-50',
        selected && 'bg-primary/5')}
    >
      <span className="min-w-0 flex-1">
        <span className="block font-medium">{title}</span>
        {detail && <span className="text-muted-foreground block text-sm">{detail}</span>}
      </span>
      {trailing && <span className="shrink-0 text-sm">{trailing}</span>}
      <Check className={cn('size-4 shrink-0 text-primary', !selected && 'invisible')} aria-hidden />
    </button>
  );
}

/** A label/value row in a group. */
export function InfoRow({ label, children, testId }: { label: string; children: ReactNode; testId?: string }) {
  return (
    <div className={cn(TAP, 'flex items-start justify-between gap-4 px-4 py-3 text-sm')}>
      <span className="text-muted-foreground shrink-0">{label}</span>
      <span className="min-w-0 text-right" data-testid={testId}>{children}</span>
    </div>
  );
}

/** The one primary action: pinned to the bottom of the screen on phones, inline from `sm` up. */
export function BottomBar({ children }: { children: ReactNode }) {
  return (
    <div className="fixed inset-x-0 bottom-0 z-20 border-t bg-background/90 px-4 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] backdrop-blur
      sm:static sm:z-auto sm:border-0 sm:bg-transparent sm:p-0 sm:backdrop-blur-none">
      <div className="mx-auto flex max-w-lg flex-col gap-2 sm:flex-row sm:justify-end">{children}</div>
    </div>
  );
}

/** Content-shaped placeholder: a title and a few rows. */
export function PageSkeleton({ label, rows = 3 }: { label: string; rows?: number }) {
  return (
    <div className="w-full max-w-lg space-y-6" role="status" aria-label={label} aria-busy>
      <div className="space-y-2">
        <div className="h-4 w-32 animate-pulse rounded bg-muted motion-reduce:animate-none" />
        <div className="h-8 w-56 animate-pulse rounded bg-muted motion-reduce:animate-none" />
      </div>
      <div className="divide-y overflow-hidden rounded-xl border">
        {Array.from({ length: rows }, (_, i) => (
          <div key={i} className="space-y-2 px-4 py-4">
            <div className="h-4 w-2/3 animate-pulse rounded bg-muted motion-reduce:animate-none" />
            <div className="h-3 w-1/3 animate-pulse rounded bg-muted motion-reduce:animate-none" />
          </div>
        ))}
      </div>
    </div>
  );
}

/** What happened, then Retry (when there is something to retry). */
export function ErrorState({ title, message, onRetry }: { title: string; message?: string; onRetry?: () => void }) {
  const t = useTranslations('BookingPublic');
  return (
    <div className="flex w-full max-w-lg flex-col items-center gap-3 py-16 text-center" role="alert">
      <AlertTriangle className="text-muted-foreground size-8" aria-hidden />
      <p className="text-lg font-semibold">{title}</p>
      {message && <p className="text-muted-foreground text-sm">{message}</p>}
      {onRetry && <Button type="button" className={cn(TAP, 'px-6')} onClick={onRetry}>{t('retry')}</Button>}
    </div>
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

export function InlineError({ text }: { text: string }) {
  return (
    <div className="flex items-start gap-2 rounded-xl border border-destructive/30 bg-destructive/10 p-3 text-sm" role="alert">
      <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
      <span>{text}</span>
    </div>
  );
}
