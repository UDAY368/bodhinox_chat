"use client"

/**
 * Two to four choices (Apple's way): a segmented control with a sliding selected pill. A radio group
 * for assistive tech; arrow keys, Home and End move and select (skipping disabled options). Scrolls
 * sideways when it does not fit; 44px items on touch screens (studio.css). The look matches the
 * section tabs (src/components/layout/section-tabs.tsx).
 */

import * as React from "react"

import { cn } from "@/lib/utils"

export type SegmentedOption<T extends string> = {
  value: T
  label: React.ReactNode
  count?: number
  disabled?: boolean
}

export type SegmentedControlProps<T extends string> = {
  value: T
  onValueChange: (value: T) => void
  options: SegmentedOption<T>[]
  "aria-label": string
  size?: "sm" | "md"
  className?: string
}

/**
 * The option a key press moves to, or null when the key is not a navigation key or nothing is
 * enabled. Arrow keys wrap around; Home and End go to the first and last enabled option.
 */
export function nextIndex(current: number, key: string, disabled: readonly boolean[]): number | null {
  const count = disabled.length
  if (count === 0 || disabled.every(Boolean)) return null
  const step = (from: number, delta: 1 | -1) => {
    let index = from
    for (let i = 0; i < count; i++) {
      index = (index + delta + count) % count
      if (!disabled[index]) return index
    }
    return null
  }
  switch (key) {
    case "ArrowRight":
    case "ArrowDown":
      return step(current, 1)
    case "ArrowLeft":
    case "ArrowUp":
      return step(current, -1)
    case "Home":
      return step(-1, 1)
    case "End":
      return step(count, -1)
    default:
      return null
  }
}

// useLayoutEffect without the server-render warning.
const useIsomorphicLayoutEffect = typeof window === "undefined" ? React.useEffect : React.useLayoutEffect

export function SegmentedControl<T extends string>({
  value,
  onValueChange,
  options,
  "aria-label": ariaLabel,
  size = "md",
  className,
}: SegmentedControlProps<T>) {
  const listRef = React.useRef<HTMLDivElement>(null)
  const itemRefs = React.useRef<(HTMLButtonElement | null)[]>([])
  const selectedIndex = options.findIndex((option) => option.value === value)
  const [pill, setPill] = React.useState<{ left: number; width: number } | null>(null)

  useIsomorphicLayoutEffect(() => {
    const item = itemRefs.current[selectedIndex]
    const list = listRef.current
    if (!item || !list) {
      setPill(null)
      return
    }
    const update = () => setPill({ left: item.offsetLeft, width: item.offsetWidth })
    update()
    if (typeof ResizeObserver === "undefined") return
    const observer = new ResizeObserver(update)
    observer.observe(item)
    observer.observe(list)
    return () => observer.disconnect()
  }, [selectedIndex, options.length])

  const onKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>, index: number) => {
    const target = nextIndex(index, event.key, options.map((option) => !!option.disabled))
    if (target === null) return
    event.preventDefault()
    itemRefs.current[target]?.focus()
    onValueChange(options[target].value)
  }

  // Roving tab stop: the selected option, or the first enabled one when nothing is selected.
  const tabStop = selectedIndex >= 0 && !options[selectedIndex]?.disabled
    ? selectedIndex
    : options.findIndex((option) => !option.disabled)

  return (
    <div
      data-slot="segmented-control"
      className={cn("max-w-full overflow-x-auto [scrollbar-width:none]", className)}
    >
      <div
        ref={listRef}
        role="radiogroup"
        aria-label={ariaLabel}
        className="relative inline-flex min-w-max gap-0.5 rounded-xl bg-muted p-[3px]"
      >
        {pill ? (
          <span
            aria-hidden
            data-slot="segmented-pill"
            className="absolute inset-y-[3px] rounded-[9px] bg-card shadow-[0_1px_3px_rgb(0_0_0/0.12)] transition-[left,width] duration-(--motion-base) ease-(--motion-ease-out) dark:bg-[#3a3a3e]"
            style={{ left: pill.left, width: pill.width }}
          />
        ) : null}
        {options.map((option, index) => {
          const checked = index === selectedIndex
          return (
            <button
              key={option.value}
              ref={(node) => {
                itemRefs.current[index] = node
              }}
              type="button"
              role="radio"
              aria-checked={checked}
              data-slot="segmented-item"
              data-state={checked ? "checked" : "unchecked"}
              disabled={option.disabled}
              tabIndex={index === tabStop ? 0 : -1}
              onClick={() => {
                if (!checked) onValueChange(option.value)
              }}
              onKeyDown={(event) => onKeyDown(event, index)}
              className={cn(
                "relative z-10 flex items-center justify-center gap-1.5 rounded-[9px] font-medium whitespace-nowrap transition-colors duration-(--motion-fast) outline-none focus-visible:outline-2 focus-visible:outline-primary disabled:pointer-events-none disabled:opacity-40",
                size === "sm" ? "h-7 px-3 text-[12px]" : "h-8 px-3.5 text-[13px]",
                "pointer-coarse:h-11",
                checked ? "text-foreground" : "text-muted-foreground hover:text-foreground",
                // Before the pill is measured (first paint), the selected item draws its own background.
                checked && !pill && "bg-card shadow-[0_1px_3px_rgb(0_0_0/0.12)] dark:bg-[#3a3a3e]"
              )}
            >
              {option.label}
              {option.count !== undefined ? (
                <span className="text-[11px] tabular-nums text-muted-foreground">{option.count}</span>
              ) : null}
            </button>
          )
        })}
      </div>
    </div>
  )
}
