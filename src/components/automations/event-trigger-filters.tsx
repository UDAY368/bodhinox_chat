"use client";

/**
 * The optional filters of an event-feed trigger (orders, payments, forms, deal moves, carts),
 * shared by the rule builder and the flow builder's trigger form. Every filter defaults to
 * "any"; the values a message can use are listed under them. The server checks the same
 * filters (src/lib/events/trigger-filters.ts).
 */

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";

import { createClient } from "@/lib/data/client";
import { OptionSelect } from "./option-select";
import { usePublishedForms } from "@/components/flows/forms/use-pickers";
import { EVENT_ORDER_SOURCES, EVENT_TRIGGER_FILTERS, EVENT_TRIGGER_VARS, isAppointmentTrigger } from "@/lib/events/trigger-filters";
import type { EventTriggerType } from "@/lib/events/types";

type Config = Record<string, unknown>;
interface Option { id: string; name: string; pipeline_id?: string }

const LABEL = "text-muted-foreground mb-1 block text-xs font-medium";

function usePipelines(enabled: boolean): { pipelines: Option[]; stages: Option[] } {
  const [lists, setLists] = useState<{ pipelines: Option[]; stages: Option[] }>({ pipelines: [], stages: [] });
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    const db = createClient();
    void Promise.all([
      db.from<Option>("pipelines").select("id, name").order("name"),
      db.from<Option>("pipeline_stages").select("id, name, pipeline_id").order("position"),
    ]).then(([p, s]) => {
      if (live) setLists({ pipelines: p.data ?? [], stages: s.data ?? [] });
    }).catch(() => {});
    return () => { live = false; };
  }, [enabled]);
  return lists;
}

export function EventTriggerFilters({ trigger, config, onChange }: {
  trigger: EventTriggerType;
  config: Config;
  onChange: (config: Config) => void;
}) {
  const t = useTranslations("Automations.eventTriggers");
  const fields = EVENT_TRIGGER_FILTERS[trigger];
  const forms = usePublishedForms();
  const { pipelines, stages } = usePipelines(fields.includes("pipeline_id"));
  const value = (key: string) => (typeof config[key] === "string" ? (config[key] as string) : "");
  const set = (patch: Config) => {
    const next = { ...config, ...patch };
    for (const [key, v] of Object.entries(next)) if (v === "") delete next[key];
    onChange(next);
  };
  const pipelineId = value("pipeline_id");
  return (
    <div className="space-y-3">
      <p className="text-muted-foreground text-[11px]">{t("help")}</p>
      {fields.includes("source") && (
        <div>
          <label htmlFor="event-source" className={LABEL}>{t("source")}</label>
          <OptionSelect id="event-source" value={value("source")} onValueChange={(source) => set({ source })}
            options={[{ value: "", label: t("anySource") }, ...EVENT_ORDER_SOURCES.map((source) => ({ value: source, label: t(`sources.${source}`) }))]} />
        </div>
      )}
      {fields.includes("form_id") && (
        <div>
          <label htmlFor="event-form" className={LABEL}>{t("form")}</label>
          <OptionSelect id="event-form" value={value("form_id")} onValueChange={(form_id) => set({ form_id })}
            options={[
              { value: "", label: t("anyForm") },
              ...forms.map((form) => ({ value: form.id, label: form.name })),
              ...(value("form_id") && !forms.some((f) => f.id === value("form_id")) ? [{ value: value("form_id"), label: t("missing") }] : []),
            ]} />
        </div>
      )}
      {fields.includes("pipeline_id") && (
        <>
          <div>
            <label htmlFor="event-pipeline" className={LABEL}>{t("pipeline")}</label>
            <OptionSelect id="event-pipeline" value={pipelineId}
              onValueChange={(pipeline_id) => set({ pipeline_id, to_stage_id: "" })}
              options={[
                { value: "", label: t("anyPipeline") },
                ...pipelines.map((p) => ({ value: p.id, label: p.name })),
                ...(pipelineId && !pipelines.some((p) => p.id === pipelineId) ? [{ value: pipelineId, label: t("missing") }] : []),
              ]} />
          </div>
          <div>
            <label htmlFor="event-stage" className={LABEL}>{t("stage")}</label>
            <OptionSelect id="event-stage" value={value("to_stage_id")} disabled={!pipelineId}
              onValueChange={(to_stage_id) => set({ to_stage_id })}
              options={[
                { value: "", label: t("anyStage") },
                ...stages.filter((s) => s.pipeline_id === pipelineId).map((s) => ({ value: s.id, label: s.name })),
              ]} />
          </div>
        </>
      )}
      {!isAppointmentTrigger(trigger) && (
        <div>
          <p className={LABEL}>{t("vars")}</p>
          <p className="text-muted-foreground font-mono text-[11px] break-all">
            {EVENT_TRIGGER_VARS[trigger].map((name) => `{{vars.${name}}}`).join("  ")}
          </p>
        </div>
      )}
    </div>
  );
}
