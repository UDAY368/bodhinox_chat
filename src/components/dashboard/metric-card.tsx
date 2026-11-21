import { ArrowDown, ArrowUp, Minus } from 'lucide-react'
import Link from 'next/link'
import type { ComponentType } from 'react'
import { cn } from '@/lib/utils'

interface MetricCardProps {
  title: string
  /** Pre-formatted value for display (e.g. "42" or "$1,250"). */
  value: string
  icon: ComponentType<{ className?: string }>
  /**
   * Delta-mode secondary row: arrow + delta text. Omit when the metric
   * doesn't have a sensible comparison (e.g. total pipeline value).
   */
  delta?: {
    /** Positive / negative / zero drives arrow + color. */
    sign: number
    /** Pre-formatted delta, e.g. "+3 vs yesterday". */
    label: string
  }
  /** Used instead of `delta` when the metric has a static subtitle. */
  subtitle?: string
  /** When set, the whole card opens the records behind the figure. */
  href?: string
}

export function MetricCard({ title, value, icon: Icon, delta, subtitle, href }: MetricCardProps) {
  const body = (
    <>
      <div className="flex items-center justify-between gap-2">
        <p className="truncate text-xs font-medium text-muted-foreground">{title}</p>
        <Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground/70" aria-hidden />
      </div>
      <p className="text-xl leading-tight font-bold tracking-tight tabular-nums text-foreground [overflow-wrap:anywhere] sm:text-2xl">
        {value}
      </p>
      {delta ? <DeltaRow sign={delta.sign} label={delta.label} /> : subtitle ? (
        <p className="text-xs text-muted-foreground">{subtitle}</p>
      ) : null}
    </>
  )
  const cls = 'flex min-w-0 flex-col gap-1 rounded-xl border border-border bg-card p-4'
  return href ? (
    <Link href={href} className={cn(cls, 'outline-none transition-colors duration-150 hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring/50')}>
      {body}
    </Link>
  ) : (
    <div className={cls}>{body}</div>
  )
}

function DeltaRow({ sign, label }: { sign: number; label: string }) {
  const tone =
    sign > 0
      ? 'text-emerald-600 dark:text-emerald-400'
      : sign < 0
      ? 'text-red-600 dark:text-red-400'
      : 'text-muted-foreground'
  const Arrow = sign > 0 ? ArrowUp : sign < 0 ? ArrowDown : Minus
  return (
    <div className={cn('flex items-center gap-1 text-xs font-semibold', tone)}>
      <Arrow className="h-3 w-3" aria-hidden />
      <span className="tabular-nums">{label}</span>
    </div>
  )
}
