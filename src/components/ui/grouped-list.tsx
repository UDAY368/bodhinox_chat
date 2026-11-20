/**
 * Grouped list (Apple's way): a small header, one rounded solid group of rows split by hairlines, and
 * a footer note. Groups are separated by space, never nested in a card. Put GroupedListRow children
 * inside; each row is a Link (href), a button (onClick) or plain content, at least 44px tall.
 */

import * as React from "react"
import Link from "next/link"
import { CheckIcon, ChevronRightIcon } from "lucide-react"

import { cn } from "@/lib/utils"

export type GroupedListProps = {
  header?: React.ReactNode
  footer?: React.ReactNode
  children: React.ReactNode
  className?: string
  /** Rounded group with side borders (default). false: full-bleed rows with top and bottom hairlines. */
  inset?: boolean
}

export function GroupedList({ header, footer, children, className, inset = true }: GroupedListProps) {
  return (
    <section data-slot="grouped-list" className={cn("flex flex-col gap-1.5", className)}>
      {header ? (
        <div data-slot="grouped-list-header" className="px-4 text-footnote font-medium text-muted-foreground">
          {header}
        </div>
      ) : null}
      <div
        data-slot="grouped-list-group"
        className={cn(
          "overflow-hidden bg-grouped-surface",
          inset ? "rounded-group border border-separator" : "border-y border-separator"
        )}
      >
        {children}
      </div>
      {footer ? (
        <div data-slot="grouped-list-footer" className="px-4 text-footnote text-muted-foreground">
          {footer}
        </div>
      ) : null}
    </section>
  )
}

export type GroupedListRowProps = {
  title: React.ReactNode
  subtitle?: React.ReactNode
  leading?: React.ReactNode
  trailing?: React.ReactNode
  href?: string
  onClick?: () => void
  /** Defaults to true for a link row. */
  chevron?: boolean
  destructive?: boolean
  selected?: boolean
  className?: string
}

export function GroupedListRow({
  title,
  subtitle,
  leading,
  trailing,
  href,
  onClick,
  chevron = !!href,
  destructive = false,
  selected = false,
  className,
}: GroupedListRowProps) {
  const interactive = !!href || !!onClick
  const classes = cn(
    // Hairline above every row but the first, indented past the leading icon like iOS.
    "relative flex min-h-11 w-full items-center gap-3 px-4 py-2.5 text-left text-body",
    "not-first:before:absolute not-first:before:top-0 not-first:before:right-0 not-first:before:left-4 not-first:before:h-px not-first:before:bg-separator",
    leading && "not-first:before:left-14",
    interactive && "transition-colors duration-(--motion-fast) outline-none hover:bg-muted/60 focus-visible:bg-muted active:bg-muted",
    destructive ? "text-destructive" : "text-foreground",
    className
  )
  const content = (
    <>
      {leading ? (
        <span data-slot="grouped-row-leading" className="flex size-7 shrink-0 items-center justify-center">
          {leading}
        </span>
      ) : null}
      <span className="min-w-0 flex-1">
        <span className="block truncate">{title}</span>
        {subtitle ? <span className="block truncate text-footnote text-muted-foreground">{subtitle}</span> : null}
      </span>
      {trailing ? <span className="shrink-0 text-subhead text-muted-foreground">{trailing}</span> : null}
      {selected ? <CheckIcon aria-hidden className="size-4 shrink-0 text-primary" /> : null}
      {chevron ? <ChevronRightIcon aria-hidden className="size-4 shrink-0 text-muted-foreground/60" /> : null}
    </>
  )
  const shared = { "data-slot": "grouped-row", "data-selected": selected || undefined, className: classes }

  if (href) {
    return (
      <Link href={href} onClick={onClick} aria-current={selected ? "page" : undefined} {...shared}>
        {content}
      </Link>
    )
  }
  if (onClick) {
    return (
      <button type="button" onClick={onClick} aria-pressed={selected || undefined} {...shared}>
        {content}
      </button>
    )
  }
  return <div {...shared}>{content}</div>
}
