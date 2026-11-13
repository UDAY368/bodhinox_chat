"use client"
import { authFetch } from "@/lib/auth/client";

import { useEffect, useState } from "react"
import { useRouter } from "next/navigation"
import { Loader2 } from "lucide-react"
import { useTranslations } from "next-intl"

import {
  AutomationBuilder,
  fromServerSteps,
  type BuilderInitial,
  type ServerStepNode,
} from "@/components/automations/automation-builder"
import { channelPath } from "@/lib/channels/routes"
import type { AutomationTriggerType, Channel } from "@/types"

/** A row's channel; a row read without the column is WhatsApp. */
const channelOf = (row: { channel?: unknown } | null | undefined): Channel =>
  row?.channel === "instagram" ? "instagram" : "whatsapp"

/**
 * Edits one automation in its channel's section. An automation of the other
 * channel (a hand-edited URL) is sent to its own section's editor.
 */
export function EditAutomation({ id, channel }: { id: string; channel: Channel }) {
  const router = useRouter()
  const t = useTranslations("Automations.edit")
  const [initial, setInitial] = useState<BuilderInitial | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    async function load() {
      const res = await authFetch(`/api/automations/${id}`)
      if (!res.ok) {
        if (!cancelled) setError(t("loadError", { status: res.status }))
        return
      }
      const body = await res.json()
      if (cancelled) return
      const own = channelOf(body.automation)
      if (own !== channel) {
        router.replace(channelPath(own, "automations", id))
        return
      }
      setInitial({
        id: body.automation.id,
        name: body.automation.name ?? "",
        description: body.automation.description ?? "",
        trigger_type: body.automation.trigger_type as AutomationTriggerType,
        trigger_config: body.automation.trigger_config ?? {},
        is_active: !!body.automation.is_active,
        steps: fromServerSteps((body.steps ?? []) as ServerStepNode[]),
      })
    }
    load()
    return () => {
      cancelled = true
    }
  }, [id, channel])

  if (error) {
    return (
      <div className="flex h-screen flex-col items-center justify-center gap-3">
        <p className="text-sm text-destructive">{error}</p>
        <button
          onClick={() => router.push(channelPath(channel, "automations"))}
          className="text-sm text-primary hover:text-primary/80"
        >
          {t("back")}
        </button>
      </div>
    )
  }

  if (!initial) {
    return (
      <div className="flex h-screen items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-primary" />
      </div>
    )
  }

  return <AutomationBuilder initial={initial} channel={channel} />
}
