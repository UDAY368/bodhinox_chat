"use client";

/**
 * Stage 5 AI step editor (Instagram flows): what the AI should do (a goal
 * sentence and an ordered task list, each task optionally saving the reply to
 * a field), background context, and up to three ordered goals (share a link,
 * grow followers, capture a lead) with the "Goals finished" port. The engine
 * and the AI calls are 5G's; nothing here talks to a model.
 */

import { ArrowDown, ArrowUp, Plus, Trash2 } from "lucide-react";
import { useTranslations } from "next-intl";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { validHttpsUrl } from "@/lib/instagram/graph-limits";
import {
  AI_GOAL_LIMITS,
  AI_GOAL_TYPES,
  AI_LEAD_FIELDS,
  type AiGoal,
  type AiGoalType,
  type AiTask,
  type FlowSaveTo,
} from "@/lib/flows/types";
import type { BuilderNode } from "../shared";
import { moveItem } from "./actions-form";
import { NextNodeRow } from "./fields";
import { useCustomFields } from "./use-pickers";

type Patch = (patch: Record<string, unknown>) => void;
const label = "mb-1 block text-xs text-muted-foreground";
const help = "mt-1 text-[10px] text-muted-foreground";
const NO_SAVE = "__none__";

export function defaultGoal(type: AiGoalType): AiGoal {
  switch (type) {
    case "share_link":
      return { type, url: "" };
    case "grow_followers":
      return { type };
    case "capture_lead":
      return { type, fields: ["email"], on_refusal: "continue" };
  }
}

export function readGoals(value: unknown): AiGoal[] {
  return (Array.isArray(value) ? value : []).filter((g): g is AiGoal =>
    !!g && typeof g === "object" && (AI_GOAL_TYPES as readonly string[]).includes((g as { type?: string }).type ?? ""));
}

export function readTasks(value: unknown): AiTask[] {
  return (Array.isArray(value) ? value : []).filter((t): t is AiTask => !!t && typeof t === "object" && typeof (t as AiTask).text === "string");
}

/** Adds or removes a lead field, keeping at most AI_GOAL_LIMITS.leadFields and the order picked. */
export function toggleLeadField(fields: readonly string[], field: string): string[] {
  if (fields.includes(field)) return fields.filter((f) => f !== field);
  return fields.length >= AI_GOAL_LIMITS.leadFields ? [...fields] : [...fields, field];
}

/** The goal types still free to add (each type once). */
export function freeGoalTypes(goals: readonly AiGoal[]): AiGoalType[] {
  return AI_GOAL_TYPES.filter((type) => !goals.some((g) => g.type === type));
}

export function AiGoalsEditor({ node, allNodes, onUpdateConfig }: { node: BuilderNode; allNodes: BuilderNode[]; onUpdateConfig: Patch }) {
  const t = useTranslations("Flows.aiGoals");
  const ts = useTranslations("Flows.saveTo");
  const customFields = useCustomFields();
  const cfg = node.config;
  const goals = readGoals(cfg.goals);
  const tasks = readTasks(cfg.tasks);
  const id = (s: string) => `ai-goals-${node.node_key}-${s}`;
  const saveGoals = (next: AiGoal[]) => onUpdateConfig(next.length ? { goals: next } : { goals: undefined, finish_next: undefined });
  const saveTasks = (next: AiTask[]) => onUpdateConfig({ tasks: next.length ? next : undefined });
  const setGoal = (i: number, next: AiGoal) => saveGoals(goals.map((g, j) => (j === i ? next : g)));
  const free = freeGoalTypes(goals);
  const leadOptions = [
    ...AI_LEAD_FIELDS.map((f) => ({ id: f, name: f })),
    ...customFields.map((f) => ({ id: `custom:${f.id}`, name: f.field_name })),
  ];

  return (
    <div className="space-y-4 rounded-md border border-border p-3">
      {/* What the AI should do: goal sentence, task list, context. */}
      <div>
        <label htmlFor={id("goal-text")} className={label}>{t("goalText")}</label>
        <Textarea id={id("goal-text")} rows={2} maxLength={AI_GOAL_LIMITS.goalTextChars} value={typeof cfg.goal_text === "string" ? cfg.goal_text : ""}
          placeholder={t("goalPlaceholder")} onChange={(e) => onUpdateConfig({ goal_text: e.target.value || undefined })} className="bg-muted" />
      </div>
      <div className="space-y-2">
        <p className="text-xs font-medium text-foreground">{t("tasks")}</p>
        <ol className="space-y-2">
          {tasks.map((task, i) => (
            <li key={i} className="space-y-2 rounded-md border border-border bg-muted/30 p-2">
              <div className="flex items-start gap-1">
                <span className="pt-2 text-xs text-muted-foreground">{i + 1}.</span>
                <Input aria-label={`${t("tasks")} ${i + 1}`} value={task.text} maxLength={AI_GOAL_LIMITS.taskChars}
                  onChange={(e) => saveTasks(tasks.map((x, j) => (j === i ? { ...x, text: e.target.value } : x)))} className="bg-muted" />
                <Button type="button" variant="ghost" size="icon-sm" aria-label={t("tasks")} onClick={() => saveTasks(tasks.filter((_, j) => j !== i))}
                  className="text-red-400 hover:bg-red-500/10 hover:text-red-300">
                  <Trash2 className="size-3.5" />
                </Button>
              </div>
              <div>
                <label htmlFor={id(`task-${i}-save`)} className={label}>{t("saveReply")}</label>
                <Select value={task.save_to ? `${task.save_to.target}:${task.save_to.key}` : NO_SAVE} onValueChange={(v) => {
                  const save_to: FlowSaveTo | undefined = !v || v === NO_SAVE ? undefined
                    : { target: v.startsWith("custom_field:") ? "custom_field" : "contact_field", key: v.slice(v.indexOf(":") + 1) };
                  saveTasks(tasks.map((x, j) => (j === i ? { text: x.text, ...(save_to ? { save_to } : {}) } : x)));
                }}>
                  <SelectTrigger id={id(`task-${i}-save`)} className="bg-muted"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value={NO_SAVE}>{ts("none")}</SelectItem>
                    {AI_LEAD_FIELDS.map((f) => <SelectItem key={f} value={`contact_field:${f}`}>{f}</SelectItem>)}
                    {customFields.map((f) => <SelectItem key={f.id} value={`custom_field:${f.id}`}>{f.field_name}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
            </li>
          ))}
        </ol>
        <Button type="button" variant="outline" size="sm" disabled={tasks.length >= AI_GOAL_LIMITS.tasks}
          onClick={() => saveTasks([...tasks, { text: "" }])}>
          <Plus className="size-3.5" />{t("addTask")}
        </Button>
      </div>
      <div>
        <label htmlFor={id("context")} className={label}>{t("context")}</label>
        <Textarea id={id("context")} rows={3} maxLength={AI_GOAL_LIMITS.contextChars} value={typeof cfg.context === "string" ? cfg.context : ""}
          onChange={(e) => onUpdateConfig({ context: e.target.value || undefined })} className="bg-muted" />
      </div>

      {/* Goals, worked through in order. */}
      <div className="space-y-2">
        <p className="text-xs font-medium text-foreground">{t("title")}</p>
        <ol className="space-y-2">
          {goals.map((goal, i) => (
            <li key={goal.type} className="space-y-2 rounded-md border border-border bg-muted/30 p-2.5">
              <div className="flex items-center gap-1">
                <span className="flex-1 text-xs font-medium">{i + 1}. {t(`types.${goal.type}`)}</span>
                <Button type="button" variant="ghost" size="icon-sm" aria-label={`${t(`types.${goal.type}`)} ↑`} disabled={i === 0} onClick={() => saveGoals(moveItem(goals, i, -1))}>
                  <ArrowUp className="size-3.5" />
                </Button>
                <Button type="button" variant="ghost" size="icon-sm" aria-label={`${t(`types.${goal.type}`)} ↓`} disabled={i === goals.length - 1} onClick={() => saveGoals(moveItem(goals, i, 1))}>
                  <ArrowDown className="size-3.5" />
                </Button>
                <Button type="button" variant="ghost" size="icon-sm" aria-label={`${t(`types.${goal.type}`)} ×`} onClick={() => saveGoals(goals.filter((_, j) => j !== i))}
                  className="text-red-400 hover:bg-red-500/10 hover:text-red-300">
                  <Trash2 className="size-3.5" />
                </Button>
              </div>
              {goal.type === "share_link" && (
                <div>
                  <label htmlFor={id(`goal-${i}-url`)} className={label}>{t("url")}</label>
                  <Input id={id(`goal-${i}-url`)} type="url" inputMode="url" value={goal.url} placeholder="https://"
                    aria-invalid={(goal.url !== "" && !validHttpsUrl(goal.url)) || undefined}
                    onChange={(e) => setGoal(i, { ...goal, url: e.target.value.trim() })} className="bg-muted" />
                </div>
              )}
              {goal.type === "capture_lead" && (
                <>
                  <fieldset>
                    <legend className={label}>{t("fields")}</legend>
                    <div className="flex flex-wrap gap-1.5">
                      {leadOptions.map((o) => {
                        const on = goal.fields.includes(o.id);
                        return (
                          <button key={o.id} type="button" aria-pressed={on} onClick={() => setGoal(i, { ...goal, fields: toggleLeadField(goal.fields, o.id) })}
                            className={`rounded-md border px-2 py-1 text-[11px] focus-visible:outline-2 focus-visible:outline-primary ${on ? "border-primary bg-primary-soft text-primary" : "border-border text-muted-foreground"}`}>
                            {o.name}
                          </button>
                        );
                      })}
                    </div>
                  </fieldset>
                  <div>
                    <label htmlFor={id(`goal-${i}-refusal`)} className={label}>{t("onRefusal")}</label>
                    <Select value={goal.on_refusal} onValueChange={(v) => setGoal(i, { ...goal, on_refusal: v === "handoff" ? "handoff" : "continue" })}>
                      <SelectTrigger id={id(`goal-${i}-refusal`)} className="bg-muted"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="continue">{t("refusalContinue")}</SelectItem>
                        <SelectItem value="handoff">{t("refusalHandoff")}</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </>
              )}
            </li>
          ))}
        </ol>
        {free.length > 0 && goals.length < AI_GOAL_LIMITS.goals && (
          <div className="flex flex-wrap gap-1.5">
            {free.map((type) => (
              <Button key={type} type="button" variant="outline" size="sm" onClick={() => saveGoals([...goals, defaultGoal(type)])}>
                <Plus className="size-3.5" />{t(`types.${type}`)}
              </Button>
            ))}
          </div>
        )}
        <p className={help}>{t("limit")}</p>
      </div>
      {goals.length > 0 && (
        <NextNodeRow label={t("finish")} value={typeof cfg.finish_next === "string" ? cfg.finish_next : ""} allNodes={allNodes}
          currentKey={node.node_key} onChange={(v) => onUpdateConfig({ finish_next: v })} />
      )}
    </div>
  );
}
