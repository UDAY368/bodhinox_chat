"use client"

import Link from 'next/link'
import { UserPlus, Briefcase, Radio, Zap, ArrowUpRight, House } from 'lucide-react'
import type { ComponentType } from 'react'

import { useTranslations } from 'next-intl'
import { useWorkspaceChannels } from '@/hooks/use-workspace-channels'
import { channelPath } from '@/lib/channels/routes'

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

// Stage 5: the Instagram home page, for workspaces that use Instagram.
const INSTAGRAM_HOME: Action = { labelKey: 'instagramHome', href: channelPath('instagram', 'home'), icon: House, tint: 'text-primary' }

export function QuickActions() {
  const t = useTranslations('Dashboard.quickActions')
  // Broadcasts are WhatsApp-only: no shortcut once the channel state says WhatsApp is not used.
  const { data: channels } = useWorkspaceChannels()
  const whatsapp = channels ? channels.enabled.includes('whatsapp') : true
  const instagram = !!channels?.enabled.includes('instagram')
  const actions = [
    ...(whatsapp ? ACTIONS : ACTIONS.filter((a) => a.labelKey !== 'newBroadcast')),
    ...(instagram ? [INSTAGRAM_HOME] : []),
  ]

  return (
    <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,10.5rem),1fr))] gap-2.5">
      {actions.map((a) => {
        const Icon = a.icon
        return (
          <Link
            key={a.href}
            href={a.href}
            className="group flex min-w-0 items-center gap-3 rounded-xl border border-border bg-card px-3 py-2.5 transition-colors duration-150 hover:bg-muted/60"
          >
            <div className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-[10px] bg-primary/10 ${a.tint}`}>
              <Icon className="h-4 w-4" />
            </div>
            <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-foreground">{t(a.labelKey as string)}</span>
            <ArrowUpRight className="hidden h-3.5 w-3.5 shrink-0 text-muted-foreground transition-colors duration-150 group-hover:text-foreground sm:block" aria-hidden />
          </Link>
        )
      })}
    </div>
  )
}
