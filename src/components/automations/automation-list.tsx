"use client"
import { authFetch } from "@/lib/auth/client";

import { useEffect, useState } from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import {
  Zap,
  Plus,
  MoreHorizontal,
  Copy,
  Pencil,
  Trash2,
  FileText,
  MessageCircle,
  Clock,
  Users,
  PhoneCall,
  Loader2,
} from "lucide-react"

import { createClient } from "@/lib/data/client"
import { useCan } from "@/hooks/use-can"
import { useTranslations } from "next-intl"
import type { Automation } from "@/types"
import { Button } from "@/components/ui/button"
import { GatedButton } from "@/components/ui/gated-button"
import { Switch } from "@/components/ui/switch"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { AUTOMATION_TEMPLATES, templateOnChannel, type TemplateSlug } from "@/lib/automations/templates"
import { channelPath } from "@/lib/channels/routes"
import type { Channel } from "@/types"
import { formatRelative, isKnownTrigger } from "@/lib/automations/trigger-meta"
import { cn } from "@/lib/utils"

const TEMPLATE_ORDER: TemplateSlug[] = [
  "welcome_message",
  "out_of_office",
  "lead_qualifier",
  "follow_up_reminder",
]

const TEMPLATE_ICON: Record<TemplateSlug, typeof Zap> = {
  welcome_message: MessageCircle,
  out_of_office: Clock,
  lead_qualifier: Users,
  follow_up_reminder: PhoneCall,
}

/**
 * One channel's automations (/whatsapp/automations, /instagram/automations):
 * only that channel's rows, templates and links. The channel layout gates the
 * section; every API re-checks role, tenancy and the channel rules.
 */
export function AutomationList({ channel }: { channel: Channel }) {
  const router = useRouter()
  const canCreate = useCan("send-messages")
  const t = useTranslations("Automations.list")
  const tSection = useTranslations("Automations.channelSection")
  const tGate = useTranslations("GatedButton")
  const [automations, setAutomations] = useState<Automation[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [pendingDelete, setPendingDelete] = useState<Automation | null>(null)
  const [deleting, setDeleting] = useState(false)

  async function load() {
    try {
      const db = createClient()
      const { data, error: fetchErr } = await db
        .from("automations")
        .select("*")
        .eq("channel", channel)
        .order("created_at", { ascending: false })
      if (fetchErr) throw fetchErr
      setAutomations((data ?? []) as Automation[])
    } catch (err) {
      setError(err instanceof Error ? err.message : t("loadFailed"))
    }
  }

  useEffect(() => {
    load()
  }, [channel])

  async function toggleActive(a: Automation, next: boolean) {
    // Optimistic flip so the switch feels instant.
    setAutomations((prev) =>
      prev?.map((x) => (x.id === a.id ? { ...x, is_active: next } : x)) ?? prev,
    )
    const res = await authFetch(`/api/automations/${a.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ is_active: next }),
    })
    if (!res.ok) {
      // Roll back on error.
      setAutomations((prev) =>
        prev?.map((x) => (x.id === a.id ? { ...x, is_active: !next } : x)) ?? prev,
      )
      const body = await res.json().catch(() => ({}))
      toast.error(body?.error ?? t("toasts.updateError"))
      return
    }
    toast.success(next ? t("toasts.activated") : t("toasts.paused"))
  }

  async function duplicate(a: Automation) {
    const res = await authFetch(`/api/automations/${a.id}/duplicate`, { method: "POST" })
    if (!res.ok) {
      const body = await res.json().catch(() => ({}))
      toast.error(body?.error ?? t("toasts.duplicateError"))
      return
    }
    toast.success(t("toasts.duplicated"))
    load()
  }

  async function confirmDelete() {
    if (!pendingDelete) return
    setDeleting(true)
    const res = await authFetch(`/api/automations/${pendingDelete.id}`, { method: "DELETE" })
    setDeleting(false)
    if (!res.ok) {
      const body = await res.json().catch(() => ({}))
      toast.error(body?.error ?? t("toasts.deleteError"))
      return
    }
    toast.success(t("toasts.deleted"))
    setPendingDelete(null)
    load()
  }

  async function startFromTemplate(slug: TemplateSlug) {
    router.push(`${channelPath(channel, "automationNew")}?template=${slug}`)
  }

  if (error) {
    return (
      <div className="flex h-64 flex-col items-center justify-center gap-2">
        <p className="text-sm text-destructive">{error}</p>
        <Button variant="outline" onClick={() => window.location.reload()}>
          {t("retry")}
        </Button>
      </div>
    )
  }

  if (automations === null) {
    return (
      <div className="flex h-64 items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-primary" />
      </div>
    )
  }

  const showTemplates = automations.length < 3
  const templates = TEMPLATE_ORDER.filter((slug) => templateOnChannel(AUTOMATION_TEMPLATES[slug], channel))

  return (
    <div>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <h1 className="text-[22px] font-bold tracking-tight text-foreground">
            {tSection(channel === "instagram" ? "instagramTitle" : "whatsappTitle")}
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {tSection(channel === "instagram" ? "instagramDescription" : "whatsappDescription")}
          </p>
          {channel === "instagram" && (
            <p className="mt-1 text-xs text-muted-foreground">{tSection("instagramWindowHint")}</p>
          )}
        </div>
        <GatedButton
          canAct={canCreate}
          gateReason={tGate("reasons.createAutomations")}
          onClick={() => router.push(channelPath(channel, "automationNew"))}
        >
          <Plus className="h-4 w-4" />
          {t("create")}
        </GatedButton>
      </div>

      {showTemplates && templates.length > 0 && (
        <section className="mt-6">
          <h2 className="mb-3 text-[13px] font-semibold text-foreground">{t("templatesTitle")}</h2>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
            {templates.map((slug) => {
              const t = AUTOMATION_TEMPLATES[slug]
              const Icon = TEMPLATE_ICON[slug]
              return (
                <button
                  key={slug}
                  onClick={() => startFromTemplate(slug)}
                  className="flex flex-col items-start gap-1.5 rounded-xl border border-border bg-card p-3.5 text-left transition-[border-color,background-color,transform] duration-150 hover:border-primary hover:bg-muted/50 active:scale-[.985]"
                >
                  <span className="mb-1 inline-flex h-[34px] w-[34px] items-center justify-center rounded-[10px] bg-primary/10 text-primary">
                    <Icon className="h-4 w-4" />
                  </span>
                  <span className="text-sm font-semibold text-foreground">{t.name}</span>
                  <span className="text-[13px] text-muted-foreground">{t.description}</span>
                </button>
              )
            })}
          </div>
        </section>
      )}

      {automations.length === 0 ? (
        <div className="mt-6 flex flex-col items-center gap-2 rounded-xl border border-border bg-card px-4 py-12 text-center">
          <span className="mb-2 inline-flex h-[52px] w-[52px] items-center justify-center rounded-2xl bg-primary/10 text-primary">
            <Zap className="h-6 w-6" />
          </span>
          <p className="text-[15px] font-semibold text-foreground">{t("emptyTitle")}</p>
          <p className="text-sm text-muted-foreground">
            {t("emptyDesc")}
          </p>
        </div>
      ) : (
        <ul className="mt-6 divide-y divide-border/60 overflow-hidden rounded-xl border border-border bg-card">
          {automations.map((a) => (
            <AutomationCard
              key={a.id}
              automation={a}
              onToggle={(next) => toggleActive(a, next)}
              onEdit={() => router.push(channelPath(channel, "automations", a.id))}
              onDuplicate={() => duplicate(a)}
              onLogs={() => router.push(channelPath(channel, "automationLogs", a.id))}
              onDelete={() => setPendingDelete(a)}
              t={t}
            />
          ))}
        </ul>
      )}

      <Dialog open={!!pendingDelete} onOpenChange={(v) => !v && setPendingDelete(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("deleteTitle")}</DialogTitle>
            <DialogDescription>
              {t("deleteDesc", { name: pendingDelete?.name ?? "" })}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="ghost"
              onClick={() => setPendingDelete(null)}
              disabled={deleting}
            >
              {t("cancel")}
            </Button>
            <Button
              variant="destructive"
              onClick={confirmDelete}
              disabled={deleting}
            >
              {deleting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
              {t("delete")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

function AutomationCard({
  automation,
  onToggle,
  onEdit,
  onDuplicate,
  onLogs,
  onDelete,
  t,
}: {
  automation: Automation
  onToggle: (next: boolean) => void
  onEdit: () => void
  onDuplicate: () => void
  onLogs: () => void
  onDelete: () => void
  t: ReturnType<typeof useTranslations>
}) {
  const tTriggers = useTranslations("Automations.builder.triggers")
  const tRelative = useTranslations("Automations.relative")
  const triggerLabel = isKnownTrigger(automation.trigger_type)
    ? tTriggers(`${automation.trigger_type}.label`)
    : automation.trigger_type
  return (
    <li className="flex items-center gap-3 px-4 py-3 transition-colors duration-150 hover:bg-muted/50">
      <span
        className="inline-flex h-[34px] w-[34px] shrink-0 items-center justify-center rounded-[10px] bg-primary/10 text-primary"
        aria-hidden
      >
        <Zap className="h-4 w-4" />
      </span>

      <button
        type="button"
        onClick={onEdit}
        className="group min-w-0 flex-1 text-left"
      >
        <span className="flex min-w-0 items-center gap-2">
          <span className="truncate text-sm font-semibold text-foreground transition-colors duration-150 group-hover:text-primary">
            {automation.name}
          </span>
          {automation.is_active && (
            <span className="inline-flex h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-500" aria-label={t("activeIndicator")} />
          )}
        </span>
        {automation.description && (
          <span className="block truncate text-xs text-muted-foreground">{automation.description}</span>
        )}
        <span className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
          <span className="inline-flex items-center gap-1.5 rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium text-foreground/80">
            <span className={cn("h-1.5 w-1.5 rounded-full", automation.channel === "instagram" ? "bg-gradient-to-br from-amber-400 via-pink-500 to-violet-600" : "bg-emerald-500")} aria-hidden />
            {triggerLabel}
          </span>
          <span className="tabular-nums">
            {automation.execution_count === 1
              ? t("runs", { count: automation.execution_count })
              : t("runsPlural", { count: automation.execution_count })}
          </span>
          <span aria-hidden>·</span>
          <span>{t("lastRun", { time: formatRelative(automation.last_executed_at, tRelative) })}</span>
        </span>
      </button>

      <div className="flex shrink-0 items-center gap-2">
        <Switch
          checked={automation.is_active}
          onCheckedChange={(v) => onToggle(!!v)}
          aria-label={automation.is_active ? t("deactivate") : t("activate")}
        />

          <DropdownMenu>
            <DropdownMenuTrigger
              aria-label={t("openMenu")}
              className="inline-flex h-8 w-8 items-center justify-center rounded-full text-muted-foreground transition-colors duration-150 hover:bg-muted hover:text-foreground data-[popup-open]:bg-muted"
            >
              <MoreHorizontal className="h-4 w-4" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={onEdit}>
                <Pencil className="h-4 w-4" />
                {t("edit")}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={onDuplicate}>
                <Copy className="h-4 w-4" />
                {t("duplicate")}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={onLogs}>
                <FileText className="h-4 w-4" />
                {t("viewLogs")}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem variant="destructive" onClick={onDelete}>
                <Trash2 className="h-4 w-4" />
                {t("delete")}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
      </div>
    </li>
  )
}
