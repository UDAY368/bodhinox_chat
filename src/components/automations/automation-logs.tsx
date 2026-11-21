"use client"

import { useEffect, useState } from "react"
import { useRouter } from "next/navigation"
import {
  ArrowLeft,
  Check,
  History,
  X,
  ChevronDown,
  ChevronRight,
} from "lucide-react"
import { useTranslations } from "next-intl"

import { createClient } from "@/lib/data/client"
import type {
  Automation,
  AutomationLog,
  AutomationLogStepResult,
} from "@/types"
import { EmptyState } from "@/components/ui/empty-state"
import { GroupedList } from "@/components/ui/grouped-list"
import { InlineError } from "@/components/ui/inline-error"
import { PageHeader } from "@/components/ui/page-header"
import { PageLoading } from "@/components/ui/page-loading"
import { cn } from "@/lib/utils"
import { formatRelative } from "@/lib/automations/trigger-meta"
import { channelPath } from "@/lib/channels/routes"
import type { Channel } from "@/types"

/** A row's channel; a row read without the column is WhatsApp. */
const channelOf = (row: { channel?: unknown } | null | undefined): Channel =>
  row?.channel === "instagram" ? "instagram" : "whatsapp"

/**
 * One automation's run log in its channel's section. An automation of the
 * other channel is sent to its own section's log.
 */
export function AutomationLogs({ id, channel }: { id: string; channel: Channel }) {
  const router = useRouter()
  const t = useTranslations("Automations.logs")
  const tRelative = useTranslations("Automations.relative")

  const [automation, setAutomation] = useState<Automation | null>(null)
  const [logs, setLogs] = useState<AutomationLog[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [openLogId, setOpenLogId] = useState<string | null>(null)
  const [retryToken, setRetryToken] = useState(0)

  useEffect(() => {
    async function load() {
      setError(null)
      try {
        const db = createClient()
        const [autRes, logRes] = await Promise.all([
          db
            .from("automations")
            .select("*")
            .eq("id", id)
            .maybeSingle(),
          db
            .from("automation_logs")
            .select("*, contact:contacts(id, name, phone)")
            .eq("automation_id", id)
            .order("created_at", { ascending: false })
            .limit(100),
        ])
        if (autRes.error) throw autRes.error
        if (logRes.error) throw logRes.error
        const row = autRes.data as Automation | null
        if (row && channelOf(row) !== channel) {
          router.replace(channelPath(channelOf(row), "automationLogs", id))
          return
        }
        setAutomation(row)
        setLogs((logRes.data ?? []) as AutomationLog[])
      } catch (err) {
        setError(err instanceof Error ? err.message : t("loadError"))
      }
    }
    load()
  }, [id, channel, retryToken])

  if (error) {
    return <InlineError message={t("loadError")} onRetry={() => setRetryToken((n) => n + 1)} />
  }

  if (!automation || logs === null) {
    return <PageLoading />
  }

  return (
    <div className="space-y-6">
      <div>
        <button
          type="button"
          onClick={() => router.push(channelPath(channel, "automations"))}
          className="mb-2 -ml-1 flex size-8 items-center justify-center rounded-full text-muted-foreground transition-colors duration-150 hover:bg-muted hover:text-foreground"
          aria-label={t("backAria")}
        >
          <ArrowLeft className="h-4 w-4" />
        </button>
        <PageHeader className="mb-0" title={automation.name} subtitle={t("title")} />
      </div>

      {logs.length === 0 ? (
        <EmptyState icon={History} title={t("emptyTitle")} body={t("emptyDesc")} />
      ) : (
        <GroupedList>
        <ul className="divide-y divide-border/60">
          {logs.map((log) => {
            const isOpen = openLogId === log.id
            return (
              <li
                key={log.id}
                className="transition-colors duration-150 hover:bg-muted/40"
              >
                <button
                  type="button"
                  onClick={() => setOpenLogId(isOpen ? null : log.id)}
                  className="flex w-full items-center gap-3 px-4 py-3 text-left"
                >
                  {isOpen ? (
                    <ChevronDown className="h-4 w-4 text-muted-foreground" />
                  ) : (
                    <ChevronRight className="h-4 w-4 text-muted-foreground" />
                  )}
                  <StatusBadge status={log.status} t={t} />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium text-foreground">
                      {log.contact?.name ?? log.contact?.phone ?? t("unknownContact")}
                    </div>
                    <div className="truncate text-xs text-muted-foreground">
                      {log.trigger_event} · {log.steps_executed?.length ?? 0}{" "}
                      {log.steps_executed?.length === 1 ? t("step", { count: 1 }).replace("1 ", "") : t("stepPlural", { count: log.steps_executed?.length ?? 0 }).replace(/^[0-9]+ /, "")}
                    </div>
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {formatRelative(log.created_at, tRelative)}
                  </div>
                </button>
                {isOpen && (
                  <div className="border-t border-border px-4 py-3">
                    {log.error_message && (
                      <p className="mb-3 rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-700 dark:text-red-300">
                        {log.error_message}
                      </p>
                    )}
                    <ul className="space-y-1.5">
                      {(log.steps_executed ?? []).map((r, i) => (
                        <StepRow key={i} result={r} />
                      ))}
                      {(log.steps_executed ?? []).length === 0 && (
                        <li className="text-xs text-muted-foreground">{t("noSteps")}</li>
                      )}
                    </ul>
                  </div>
                )}
              </li>
            )
          })}
        </ul>
        </GroupedList>
      )}
    </div>
  )
}

function StatusBadge({ status, t }: { status: AutomationLog["status"], t: ReturnType<typeof useTranslations> }) {
  const classes =
    status === "success"
      ? "border-primary/30 bg-primary/10 text-primary"
      : status === "partial"
      ? "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300"
      : "border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-300"
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium",
        classes,
      )}
    >
      {t(`status.${status}`)}
    </span>
  )
}

function StepRow({ result }: { result: AutomationLogStepResult }) {
  const ok = result.status === "success"
  return (
    <li className="flex items-start gap-2 text-xs">
      <span
        className={cn(
          "mt-0.5 flex h-4 w-4 flex-shrink-0 items-center justify-center rounded-full",
          ok ? "bg-primary/20 text-primary" : "bg-red-500/15 text-red-700 dark:text-red-300",
        )}
        aria-hidden
      >
        {ok ? <Check className="h-3 w-3" /> : <X className="h-3 w-3" />}
      </span>
      <span className="text-muted-foreground">{result.step_type}</span>
      {result.detail && (
        <span className="truncate text-muted-foreground">— {result.detail}</span>
      )}
    </li>
  )
}
