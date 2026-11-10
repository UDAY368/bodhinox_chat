"use client"

import { Suspense, useMemo } from "react"
import { useSearchParams } from "next/navigation"

import {
  AutomationBuilder,
  type BuilderInitial,
  type BuilderStep,
} from "@/components/automations/automation-builder"
import { getTemplate, templateOnChannel } from "@/lib/automations/templates"
import type { AutomationStepType, AutomationTriggerType, Channel } from "@/types"

/**
 * A new automation in a channel's section (/{channel}/automations/new),
 * optionally from a starter template (`?template=`) the channel offers.
 *
 * `useSearchParams` requires a Suspense boundary or the production build
 * bails to CSR and errors out. Thin wrapper supplies it; the inner
 * component reads the `?template=` query string.
 */
export function NewAutomation({ channel }: { channel: Channel }) {
  return (
    <Suspense fallback={null}>
      <NewAutomationInner channel={channel} />
    </Suspense>
  )
}

function NewAutomationInner({ channel }: { channel: Channel }) {
  const params = useSearchParams()
  const slug = params.get("template")

  const initial: BuilderInitial = useMemo(() => {
    const template = slug ? getTemplate(slug) : null
    if (template && templateOnChannel(template, channel)) {
      const t = template
      const steps = expandFromSeeds(
        t.steps.map((seed, idx) => ({
          index: idx,
          step_type: seed.step_type,
          step_config: seed.step_config as Record<string, unknown>,
          branch: seed.branch ?? null,
          parent_index: seed.parent_index ?? null,
        })),
      )
      return {
        name: t.name,
        description: t.description,
        trigger_type: t.trigger_type,
        trigger_config: t.trigger_config as Record<string, unknown>,
        is_active: false,
        steps,
      }
    }
    return {
      name: "",
      description: "",
      trigger_type: "new_message_received" as AutomationTriggerType,
      trigger_config: {},
      is_active: false,
      steps: [],
    }
  }, [slug, channel])

  return <AutomationBuilder initial={initial} channel={channel} />
}

interface SeedRow {
  index: number
  step_type: AutomationStepType
  step_config: Record<string, unknown>
  branch: "yes" | "no" | null
  parent_index: number | null
}

function uid(): string {
  return (
    "c_" +
    (typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : Math.random().toString(36).slice(2) + Date.now().toString(36))
  )
}

/** Template seeds are flat with parent_index references. Expand into the
 *  builder's nested tree, preserving order within each scope. */
function expandFromSeeds(rows: SeedRow[]): BuilderStep[] {
  const nodes: BuilderStep[] = rows.map((r) => ({
    cid: uid(),
    step_type: r.step_type,
    step_config: r.step_config,
    branches:
      r.step_type === "condition" ? { yes: [], no: [] } : undefined,
  }))
  const roots: BuilderStep[] = []
  rows.forEach((r, i) => {
    if (r.parent_index == null) {
      roots.push(nodes[i])
      return
    }
    const parent = nodes[r.parent_index]
    if (!parent.branches) parent.branches = { yes: [], no: [] }
    parent.branches[r.branch ?? "yes"].push(nodes[i])
  })
  return roots
}
