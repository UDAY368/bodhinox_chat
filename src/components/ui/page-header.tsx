"use client"

/**
 * The page's large title and its actions (Apple's way): one <h1> per screen, one primary button top
 * right, every other action in a single "more" menu. `children` render as a row under the title for
 * filters or a segmented control. At phone width the title takes its own line and the actions sit
 * right below it, aligned right.
 */

import * as React from "react"
import Link from "next/link"
import { MoreHorizontalIcon, type LucideIcon } from "lucide-react"
import { useTranslations } from "next-intl"

import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"

export type PageHeaderAction = {
  label: string
  onSelect?: () => void
  href?: string
  icon?: LucideIcon | React.ComponentType<{ className?: string }>
  destructive?: boolean
  disabled?: boolean
}

export type PageHeaderProps = {
  title: string
  subtitle?: React.ReactNode
  primaryAction?: React.ReactNode
  moreActions?: PageHeaderAction[]
  children?: React.ReactNode
  className?: string
}

function MoreMenu({ actions }: { actions: PageHeaderAction[] }) {
  const t = useTranslations("UiKit")
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={<Button variant="outline" size="icon" aria-label={t("more")} />}
      >
        <MoreHorizontalIcon aria-hidden />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-auto min-w-48">
        {actions.map((action) => {
          const Icon = action.icon
          const content = (
            <>
              {Icon ? <Icon className="size-4" /> : null}
              {action.label}
            </>
          )
          return (
            <DropdownMenuItem
              key={action.label}
              variant={action.destructive ? "destructive" : "default"}
              disabled={action.disabled}
              onClick={action.onSelect}
              render={action.href ? <Link href={action.href} /> : undefined}
            >
              {content}
            </DropdownMenuItem>
          )
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

export function PageHeader({
  title,
  subtitle,
  primaryAction,
  moreActions,
  children,
  className,
}: PageHeaderProps) {
  const hasMore = !!moreActions && moreActions.length > 0
  return (
    <header data-slot="page-header" className={cn("mb-6 flex flex-col gap-4", className)}>
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-3">
        <div className="min-w-0 basis-full sm:flex-1 sm:basis-auto">
          <h1 className="text-large-title text-balance text-foreground">{title}</h1>
          {subtitle ? (
            <div className="mt-1 text-subhead text-muted-foreground">{subtitle}</div>
          ) : null}
        </div>
        {hasMore || primaryAction ? (
          <div className="ml-auto flex shrink-0 items-center gap-2">
            {hasMore ? <MoreMenu actions={moreActions} /> : null}
            {primaryAction}
          </div>
        ) : null}
      </div>
      {children ? <div className="flex flex-wrap items-center gap-2">{children}</div> : null}
    </header>
  )
}
