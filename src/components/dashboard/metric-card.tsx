import { ArrowDown, ArrowUp, Minus } from 'lucide-react'
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
}

export function MetricCard({ title, value, icon: Icon, delta, subtitle }: MetricCardProps) {
  return (
    <div className="studio-metric rounded-2xl border border-border bg-card p-6 shadow-[0_4px_20px_rgba(60,37,14,0.02)]">
      <div className="flex items-start justify-between">
        <p className="text-xs font-medium text-muted-foreground">{title}</p>
        <div className="flex h-7 w-7 items-center justify-center rounded-full bg-primary/7 text-primary">
          <Icon className="h-3.5 w-3.5" />
        </div>
      </div>
      <p className="mt-5 text-[32px] leading-none font-semibold tracking-[-1px] tabular-nums text-foreground">
        {value}
      </p>
      {delta ? <DeltaRow sign={delta.sign} label={delta.label} /> : subtitle ? (
        <p className="mt-3 text-xs text-muted-foreground">{subtitle}</p>
      ) : null}
    </div>
  )
}

function DeltaRow({ sign, label }: { sign: number; label: string }) {
  const tone =
    sign > 0
      ? 'text-emerald-700 dark:text-emerald-400'
      : sign < 0
      ? 'text-red-700 dark:text-red-400'
      : 'text-muted-foreground'
  const Arrow = sign > 0 ? ArrowUp : sign < 0 ? ArrowDown : Minus
  return (
    <div className={cn('mt-3 flex items-center gap-1 text-xs', tone)}>
      <Arrow className="h-3 w-3" aria-hidden />
      <span className="tabular-nums">{label}</span>
    </div>
  )
}
