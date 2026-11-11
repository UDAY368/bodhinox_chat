"use client";

/**
 * The Actions step (Stage 5): an ordered list of up to 10 actions that run
 * one after another and send nothing, then the next step. The "+ Action"
 * picker groups them as Contact data, Automation, Inbox and Ads. The same
 * list editor serves an Ask Question's "actions on a valid answer".
 *
 * The engine (5B) runs each action once per run, step and position, keeps
 * secret workspace fields out of reach and refuses a flow that starts or
 * stops itself; the form says so up front.
 */

import { useState } from "react";
import { ArrowDown, ArrowUp, Plus, Trash2 } from "lucide-react";
import { useTranslations } from "next-intl";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  FLOW_ACTION_GROUPS,
  FLOW_ACTION_TYPES,
  FLOW_STEP_LIMITS,
  PAUSE_MINUTES_CHOICES,
  type FlowAction,
  type FlowActionGroup,
  type FlowActionType,
} from "@/lib/flows/types";
import { useFlowEditor } from "../flow-editor-state";
import type { BuilderNode } from "../shared";
import { NextNodeRow, TextRow } from "./fields";
import { useConversionEventTypes, useCustomFields, useFlowList, useSequences, useUserTags } from "./use-pickers";
import { useWorkspaceFields } from "./variable-picker";

type Patch = (patch: Record<string, unknown>) => void;
const label = "mb-1 block text-xs text-muted-foreground";
const help = "mt-1 text-[10px] text-muted-foreground";
const ACTION_GROUP_ORDER: FlowActionGroup[] = ["contact", "automation", "inbox", "ads"];
const INSTAGRAM_ONLY_ACTIONS = new Set<FlowActionType>(["set_channel_consent", "subscribe_sequence", "unsubscribe_sequence"]);

/** A new action of `type` with its fields unset (the validator asks for the missing ones). */
export function defaultAction(type: FlowActionType): FlowAction {
  switch (type) {
    case "add_tag":
    case "remove_tag":
      return { type, tag_id: "" };
    case "set_field":
      return { type, target: "contact_field", key: "", value: "" };
    case "set_workspace_field":
      return { type, key: "", mode: "set", value: "" };
    case "set_channel_consent":
      return { type, channel: "instagram", state: "opted_out" };
    case "subscribe_sequence":
    case "unsubscribe_sequence":
      return { type, sequence_id: "" };
    case "start_flow":
    case "stop_flow":
      return { type, flow_id: "" };
    case "pause_automations":
      return { type, minutes: 60 };
    case "resume_automations":
      return { type };
    case "log_conversion":
      return { type, event_type_id: "" };
    case "set_conversation_status":
      return { type, status: "closed" };
    case "notify_team":
      return { type, target: "assignee" };
  }
}

/** Moves item `i` one place up (-1) or down (+1); out of range leaves the list as it is. */
export function moveItem<T>(list: readonly T[], i: number, dir: -1 | 1): T[] {
  const j = i + dir;
  if (i < 0 || i >= list.length || j < 0 || j >= list.length) return [...list];
  const next = [...list];
  [next[i], next[j]] = [next[j], next[i]];
  return next;
}

/** The actions an author may add on this channel, grouped for the picker. */
export function actionPickerGroups(instagram: boolean): Array<{ group: FlowActionGroup; types: FlowActionType[] }> {
  return ACTION_GROUP_ORDER.map((group) => ({
    group,
    types: FLOW_ACTION_TYPES.filter((type) => FLOW_ACTION_GROUPS[type] === group && (instagram || !INSTAGRAM_ONLY_ACTIONS.has(type))),
  })).filter((g) => g.types.length > 0);
}

export function readActions(value: unknown): FlowAction[] {
  return (Array.isArray(value) ? value : []).filter((a): a is FlowAction =>
    !!a && typeof a === "object" && (FLOW_ACTION_TYPES as readonly string[]).includes((a as { type?: string }).type ?? ""));
}

/** The ordered action list with its picker. `idBase` keeps field ids unique per step. */
export function ActionsEditor({ idBase, actions, onChange, allNodes, currentKey, allowEmpty = false }: {
  idBase: string;
  actions: FlowAction[];
  onChange: (actions: FlowAction[]) => void;
  allNodes: BuilderNode[];
  currentKey: string;
  /** An optional list (an Ask Question's actions on a valid answer): no "add at least one" warning. */
  allowEmpty?: boolean;
}) {
  const t = useTranslations("Flows.nodes.actions");
  const { channelScope } = useFlowEditor();
  const [picking, setPicking] = useState(false);
  const full = actions.length >= FLOW_STEP_LIMITS.actionsMax;
  const set = (i: number, next: FlowAction) => onChange(actions.map((a, j) => (j === i ? next : a)));
  return (
    <div className="space-y-2">
      <ol className="space-y-2">
        {actions.map((action, i) => (
          <li key={i} className="rounded-md border border-border bg-muted/30 p-2.5">
            <div className="mb-2 flex items-center gap-1">
              <span className="flex-1 text-xs font-medium text-foreground">{i + 1}. {t(`types.${action.type}`)}</span>
              <Button type="button" variant="ghost" size="icon-sm" aria-label={t("moveUp")} disabled={i === 0} onClick={() => onChange(moveItem(actions, i, -1))}>
                <ArrowUp className="size-3.5" />
              </Button>
              <Button type="button" variant="ghost" size="icon-sm" aria-label={t("moveDown")} disabled={i === actions.length - 1} onClick={() => onChange(moveItem(actions, i, 1))}>
                <ArrowDown className="size-3.5" />
              </Button>
              <Button type="button" variant="ghost" size="icon-sm" aria-label={t("remove")} onClick={() => onChange(actions.filter((_, j) => j !== i))}
                className="text-red-400 hover:bg-red-500/10 hover:text-red-300">
                <Trash2 className="size-3.5" />
              </Button>
            </div>
            <ActionFields id={`${idBase}-${i}`} action={action} onChange={(next) => set(i, next)} allNodes={allNodes} currentKey={currentKey} />
          </li>
        ))}
      </ol>
      {actions.length === 0 && !allowEmpty && <p className="text-xs text-amber-500">{t("empty")}</p>}
      <Button type="button" variant="outline" size="sm" disabled={full} onClick={() => setPicking(true)}>
        <Plus className="size-3.5" />{t("add")}
      </Button>
      {full && <p className={help}>{t("limit", { max: FLOW_STEP_LIMITS.actionsMax })}</p>}
      <Dialog open={picking} onOpenChange={setPicking}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader><DialogTitle>{t("pickerTitle")}</DialogTitle></DialogHeader>
          <div className="flex max-h-[60vh] flex-col gap-3 overflow-y-auto">
            {actionPickerGroups(channelScope === "instagram").map(({ group, types }) => (
              <section key={group}>
                <h3 className="mb-1 px-1 text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">{t(`groups.${group}`)}</h3>
                <div className="grid grid-cols-1 gap-1 sm:grid-cols-2">
                  {types.map((type) => (
                    <Button key={type} type="button" variant="ghost" className="h-auto justify-start py-2 text-left text-xs"
                      onClick={() => { onChange([...actions, defaultAction(type)]); setPicking(false); }}>
                      {t(`types.${type}`)}
                    </Button>
                  ))}
                </div>
              </section>
            ))}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function ActionFields({ id, action, onChange, allNodes, currentKey }: {
  id: string;
  action: FlowAction;
  onChange: (action: FlowAction) => void;
  allNodes: BuilderNode[];
  currentKey: string;
}) {
  const t = useTranslations("Flows.nodes.actions");
  const tf = useTranslations("Flows.builder.form");
  const tPause = useTranslations("Inbox.pause");
  const tags = useUserTags();
  const fields = useCustomFields();
  const flows = useFlowList();
  const sequences = useSequences();
  const eventTypes = useConversionEventTypes();
  const workspaceFields = useWorkspaceFields();
  const { flow } = useFlowEditor();
  const picker = (value: string, options: Array<{ id: string; name: string }>, onPick: (v: string) => void, placeholder: string) => (
    <Select value={value} onValueChange={(v) => onPick(v ?? "")}>
      <SelectTrigger id={`${id}-pick`} aria-label={placeholder} className="bg-muted"><SelectValue placeholder={placeholder}>{(v: string) => (v ? options.find((o) => o.id === v)?.name ?? v : placeholder)}</SelectValue></SelectTrigger>
      <SelectContent>
        {options.map((o) => <SelectItem key={o.id} value={o.id}>{o.name}</SelectItem>)}
        {value && !options.some((o) => o.id === value) && <SelectItem value={value}>{value}</SelectItem>}
      </SelectContent>
    </Select>
  );
  switch (action.type) {
    case "add_tag":
    case "remove_tag":
      return picker(action.tag_id, tags.map((g) => ({ id: g.id, name: g.name })), (tag_id) => onChange({ ...action, tag_id }), tf("pickTag"));
    case "set_field":
      return (
        <div className="space-y-2">
          <div className="grid grid-cols-2 gap-2">
            <Select value={action.target} onValueChange={(target) => onChange({ ...action, target: target as "contact_field" | "custom_field", key: "" })}>
              <SelectTrigger aria-label={tf("setTarget")} className="bg-muted"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="contact_field">{tf("targetContactField")}</SelectItem>
                <SelectItem value="custom_field">{tf("targetCustomField")}</SelectItem>
              </SelectContent>
            </Select>
            {picker(action.key, action.target === "contact_field"
              ? ["name", "email", "phone", "company"].map((f) => ({ id: f, name: f }))
              : fields.map((f) => ({ id: f.id, name: f.field_name })), (key) => onChange({ ...action, key }),
            action.target === "contact_field" ? tf("pickField") : tf("pickCustomField"))}
          </div>
          <TextRow id={`${id}-value`} label={tf("attributeValue")} value={action.value} onChange={(value) => onChange({ ...action, value })}
            variables={{ nodes: allNodes, currentKey }} />
        </div>
      );
    case "set_workspace_field":
      return (
        <div className="space-y-2">
          <div className="grid grid-cols-2 gap-2">
            {picker(action.key, workspaceFields.map((a) => ({ id: a.key, name: a.key })), (key) => onChange({ ...action, key }), tf("pickField"))}
            <Select value={action.mode} onValueChange={(mode) => onChange({ ...action, mode: mode as "set" | "increment" })}>
              <SelectTrigger aria-label={tf("actionLabel")} className="bg-muted"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="set">{t("set")}</SelectItem>
                <SelectItem value="increment">{t("increment")}</SelectItem>
              </SelectContent>
            </Select>
          </div>
          {action.mode === "increment" ? (
            <div>
              <label htmlFor={`${id}-amount`} className={label}>{tf("valueLabel")}</label>
              <Input id={`${id}-amount`} type="number" inputMode="decimal" value={action.value} onChange={(e) => onChange({ ...action, value: e.target.value })} className="bg-muted" />
            </div>
          ) : (
            <TextRow id={`${id}-value`} label={tf("valueLabel")} value={action.value} onChange={(value) => onChange({ ...action, value })}
              variables={{ nodes: allNodes, currentKey }} />
          )}
        </div>
      );
    case "set_channel_consent":
      return (
        <Select value={action.state} onValueChange={(state) => onChange({ ...action, state: state as "opted_in" | "opted_out" })}>
          <SelectTrigger aria-label={t("types.set_channel_consent")} className="bg-muted"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="opted_in">{t("optIn")}</SelectItem>
            <SelectItem value="opted_out">{t("optOut")}</SelectItem>
          </SelectContent>
        </Select>
      );
    case "subscribe_sequence":
    case "unsubscribe_sequence":
      return picker(action.sequence_id, sequences, (sequence_id) => onChange({ ...action, sequence_id }), t(`types.${action.type}`));
    case "start_flow":
    case "stop_flow":
      return (
        <div>
          {picker(action.flow_id, flows.filter((f) => f.id !== flow.id).map((f) => ({ id: f.id, name: f.name })),
            (flow_id) => onChange({ ...action, flow_id }), t(`types.${action.type}`))}
          {action.flow_id === flow.id ? <p className="mt-1 text-[10px] text-amber-500">{t("selfFlow")}</p> : <p className={help}>{t("selfFlow")}</p>}
        </div>
      );
    case "pause_automations":
      return (
        <Select value={action.minutes === null ? "forever" : String(action.minutes)}
          onValueChange={(v) => onChange({ ...action, minutes: v === "forever" ? null : Number(v) })}>
          <SelectTrigger aria-label={tPause("pause")} className="bg-muted"><SelectValue /></SelectTrigger>
          <SelectContent>
            {PAUSE_MINUTES_CHOICES.map((m) => (
              <SelectItem key={m ?? "forever"} value={m === null ? "forever" : String(m)}>{tPause(`choices.${m ?? "forever"}`)}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      );
    case "resume_automations":
      return null;
    case "log_conversion":
      return picker(action.event_type_id, eventTypes, (event_type_id) => onChange({ ...action, event_type_id }), t("types.log_conversion"));
    case "set_conversation_status":
      return (
        <Select value={action.status} onValueChange={(status) => onChange({ ...action, status: status as "open" | "closed" })}>
          <SelectTrigger aria-label={t("types.set_conversation_status")} className="bg-muted"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="open">{t("opened")}</SelectItem>
            <SelectItem value="closed">{t("closed")}</SelectItem>
          </SelectContent>
        </Select>
      );
    case "notify_team":
      return (
        <div className="space-y-2">
          <Select value={action.target} onValueChange={(target) => onChange({ ...action, target: target as "assignee" | "admins" })}>
            <SelectTrigger aria-label={t("types.notify_team")} className="bg-muted"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="assignee">{t("assignee")}</SelectItem>
              <SelectItem value="admins">{t("admins")}</SelectItem>
            </SelectContent>
          </Select>
          <div>
            <label htmlFor={`${id}-note`} className={label}>{t("note")}</label>
            <Input id={`${id}-note`} value={action.note ?? ""} maxLength={FLOW_STEP_LIMITS.notifyNoteChars}
              onChange={(e) => onChange({ ...action, note: e.target.value || undefined })} className="bg-muted" />
          </div>
        </div>
      );
  }
}

export function ActionsForm({ node, allNodes, onUpdateConfig }: { node: BuilderNode; allNodes: BuilderNode[]; onUpdateConfig: Patch }) {
  const t = useTranslations("Flows.nodes.actions");
  const tf = useTranslations("Flows.builder.form");
  const actions = readActions(node.config.actions);
  return (
    <>
      <p className="text-xs font-medium text-foreground">{t("title")}</p>
      <ActionsEditor idBase={`actions-${node.node_key}`} actions={actions} onChange={(next) => onUpdateConfig({ actions: next })}
        allNodes={allNodes} currentKey={node.node_key} />
      <NextNodeRow value={typeof node.config.next_node_key === "string" ? node.config.next_node_key : ""} allNodes={allNodes}
        currentKey={node.node_key} onChange={(v) => onUpdateConfig({ next_node_key: v })} label={tf("thenAdvanceTo")} />
    </>
  );
}
