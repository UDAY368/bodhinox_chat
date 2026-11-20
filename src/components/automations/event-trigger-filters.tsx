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
import { usePublishedForms } from "@/components/flows/forms/use-pickers";
import { EVENT_ORDER_SOURCES, EVENT_TRIGGER_FILTERS, EVENT_TRIGGER_VARS, isAppointmentTrigger } from "@/lib/events/trigger-filters";
import type { EventTriggerType } from "@/lib/events/types";

type Config = Record<string, unknown>;
interface Option { id: string; name: string; pipeline_id?: string }

const SELECT = "border-border bg-muted text-foreground focus:border-primary w-full rounded-md border px-2 py-1.5 text-sm focus:outline-none";
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
          <select id="event-source" className={SELECT} value={value("source")} onChange={(e) => set({ source: e.target.value })}>
            <option value="">{t("anySource")}</option>
            {EVENT_ORDER_SOURCES.map((source) => <option key={source} value={source}>{t(`sources.${source}`)}</option>)}
          </select>
        </div>
      )}
      {fields.includes("form_id") && (
        <div>
          <label htmlFor="event-form" className={LABEL}>{t("form")}</label>
          <select id="event-form" className={SELECT} value={value("form_id")} onChange={(e) => set({ form_id: e.target.value })}>
            <option value="">{t("anyForm")}</option>
            {forms.map((form) => <option key={form.id} value={form.id}>{form.name}</option>)}
            {value("form_id") && !forms.some((f) => f.id === value("form_id")) && <option value={value("form_id")}>{t("missing")}</option>}
          </select>
        </div>
      )}
      {fields.includes("pipeline_id") && (
        <>
          <div>
            <label htmlFor="event-pipeline" className={LABEL}>{t("pipeline")}</label>
            <select id="event-pipeline" className={SELECT} value={pipelineId}
              onChange={(e) => set({ pipeline_id: e.target.value, to_stage_id: "" })}>
              <option value="">{t("anyPipeline")}</option>
              {pipelines.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              {pipelineId && !pipelines.some((p) => p.id === pipelineId) && <option value={pipelineId}>{t("missing")}</option>}
            </select>
          </div>
          <div>
            <label htmlFor="event-stage" className={LABEL}>{t("stage")}</label>
            <select id="event-stage" className={SELECT} value={value("to_stage_id")} disabled={!pipelineId}
              onChange={(e) => set({ to_stage_id: e.target.value })}>
              <option value="">{t("anyStage")}</option>
              {stages.filter((s) => s.pipeline_id === pipelineId).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
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
