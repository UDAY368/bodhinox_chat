import { cn } from '@/lib/utils'

/**
 * Class names for the redesign's segmented control: a muted track with the
 * chosen option raised on a card-coloured pill. Callers keep their own
 * buttons, handlers and aria-pressed state; this is presentation only.
 */
export const segmentedTrack = 'inline-flex max-w-full items-center gap-0.5 overflow-x-auto rounded-lg bg-muted p-[3px] [scrollbar-width:none]'

export function segmentedItem(selected: boolean, className?: string) {
  return cn(
    'inline-flex h-[30px] shrink-0 items-center justify-center gap-1.5 rounded-[7px] px-3 text-[13px] font-medium whitespace-nowrap transition-[background-color,color,box-shadow] duration-150 outline-none focus-visible:ring-2 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-40 [&_svg]:size-3.5',
    selected
      ? 'bg-card text-foreground shadow-[0_1px_3px_rgb(0_0_0/0.12)] dark:bg-input'
      : 'text-muted-foreground hover:text-foreground disabled:hover:text-muted-foreground',
    className,
  )
}

/** A native select styled to sit beside a segmented control. */
export const quietSelect = 'h-9 rounded-lg border border-border bg-card px-2.5 text-[13px] text-foreground transition-colors duration-150 hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring/50 outline-none'
