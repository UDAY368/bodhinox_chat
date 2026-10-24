"use client"

import Link from 'next/link'
import { UserPlus, Briefcase, Radio, Zap, ArrowUpRight } from 'lucide-react'
import type { ComponentType } from 'react'

import { useTranslations } from 'next-intl'

// Quick-action shortcuts. Each navigates to the page that owns the
// relevant "create" flow. We deliberately don't try to auto-open any
// modal on the target page — that'd require touching those pages,
// which is out of scope here.
interface Action {
  labelKey: string
  href: string
  icon: ComponentType<{ className?: string }>
  tint: string
}

const ACTIONS: Action[] = [
  { labelKey: 'newContact', href: '/contacts', icon: UserPlus, tint: 'text-primary' },
  { labelKey: 'newDeal', href: '/pipelines', icon: Briefcase, tint: 'text-primary' },
  { labelKey: 'newBroadcast', href: '/broadcasts/new', icon: Radio, tint: 'text-primary' },
  { labelKey: 'newAutomation', href: '/automations/new', icon: Zap, tint: 'text-primary' },
]

export function QuickActions() {
  const t = useTranslations('Dashboard.quickActions')
  
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
      {ACTIONS.map((a) => {
        const Icon = a.icon
        return (
          <Link
            key={a.href}
            href={a.href}
            className="group flex items-center gap-3 rounded-2xl border border-border bg-card/60 px-4 py-3 transition-colors hover:border-primary/30 hover:bg-card"
          >
            <div className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-muted ${a.tint}`}>
              <Icon className="h-4 w-4" />
            </div>
            <span className="flex-1 text-xs font-medium text-foreground">{t(a.labelKey as string)}</span>
            <ArrowUpRight className="hidden h-3.5 w-3.5 text-muted-foreground transition-colors group-hover:text-primary sm:block" aria-hidden />
          </Link>
        )
      })}
    </div>
  )
}
