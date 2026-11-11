"use client";

/**
 * Stage 5 trigger stack: a flow starts on its primary trigger or any of its
 * `extra_triggers`. Only Instagram flows may add triggers, only of the
 * combinable types (COMBINABLE_TRIGGERS), and at most
 * FLOW_TRIGGER_LIMITS.extraTriggers beside the primary one. The pure rules
 * below are what the "When…" card, the list view and the picker share; the
 * publish validator (5B) checks the same rules on the server.
 */

import { useMemo, useState } from "react";
import { Plus, Search, Trash2, Zap } from "lucide-react";
import { useTranslations } from "next-intl";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import {
  FLOW_TRIGGER_LIMITS,
  isCombinableTrigger,
  startsFromComment,
  type FlowChannelScope,
  type FlowTriggerType,
} from "@/lib/flows/types";
import type { BuilderState } from "../flow-editor-state";
import { defaultTriggerConfig, placePrivateReply, readStrings } from "./ig-trigger-config";
import { TRIGGER_TITLE_KEYS } from "./trigger-form";

type Config = Record<string, unknown>;

/** One trigger as the stack shows it; index 0 is the primary trigger. */
export interface StackTrigger {
  trigger_type: FlowTriggerType;
  config: Config;
}

/** Why "New trigger" is unavailable, or null when a trigger can be added. */
export type AddTriggerBlock = "onlyInstagram" | "notCombinable" | "limitReached";

export const MAX_TRIGGERS = 1 + FLOW_TRIGGER_LIMITS.extraTriggers;

/** The well-formed extra triggers stored on the state. */
export function readExtraTriggers(value: unknown): StackTrigger[] {
  return (Array.isArray(value) ? value : []).filter((entry): entry is StackTrigger => {
    const e = entry as Record<string, unknown> | null;
    return !!e && typeof e === "object" && typeof e.trigger_type === "string" && !!e.config && typeof e.config === "object" && !Array.isArray(e.config);
  });
}

/** The primary trigger first, then the extras. */
export function stackTriggers(state: Pick<BuilderState, "trigger_type" | "trigger_config" | "extra_triggers">): StackTrigger[] {
  return [{ trigger_type: state.trigger_type, config: state.trigger_config }, ...readExtraTriggers(state.extra_triggers)];
}

export function addTriggerBlock(scope: FlowChannelScope | null | undefined, primary: FlowTriggerType, extraCount: number): AddTriggerBlock | null {
  if (scope !== "instagram") return "onlyInstagram";
  if (!isCombinableTrigger(primary)) return "notCombinable";
  if (extraCount >= FLOW_TRIGGER_LIMITS.extraTriggers) return "limitReached";
  return null;
}

/** The picker's entries: every offered trigger, the combinable ones selectable. */
export function triggerPickerOptions(offered: readonly FlowTriggerType[]): Array<{ type: FlowTriggerType; combinable: boolean }> {
  return offered.map((type) => ({ type, combinable: isCombinableTrigger(type) }));
}

/** Adds a combinable trigger with its starting settings; a comment trigger also makes a private reply the first step. */
export function addExtraTrigger(state: BuilderState, type: FlowTriggerType): BuilderState {
  if (!isCombinableTrigger(type)) return state;
  const extras = readExtraTriggers(state.extra_triggers);
  if (extras.length >= FLOW_TRIGGER_LIMITS.extraTriggers) return state;
  const next: BuilderState = { ...state, extra_triggers: [...extras, { trigger_type: type, config: defaultTriggerConfig(type) }] };
  return startsFromComment(type) ? placePrivateReply(next) : next;
}

/**
 * Removes trigger `index` (0 = primary). Removing the primary promotes the
 * first extra; the only trigger cannot be removed.
 */
export function removeTrigger(state: BuilderState, index: number): BuilderState {
  const extras = readExtraTriggers(state.extra_triggers);
  if (index === 0) {
    if (!extras.length) return state;
    const [first, ...rest] = extras;
    return { ...state, trigger_type: first.trigger_type, trigger_config: first.config, extra_triggers: rest };
  }
  if (index - 1 >= extras.length) return state;
  return { ...state, extra_triggers: extras.filter((_, i) => i !== index - 1) };
}

/** Replaces the settings of trigger `index`. */
export function setTriggerConfig(state: BuilderState, index: number, config: Config): BuilderState {
  if (index === 0) return { ...state, trigger_config: config };
  const extras = readExtraTriggers(state.extra_triggers);
  if (index - 1 >= extras.length) return state;
  return { ...state, extra_triggers: extras.map((e, i) => (i === index - 1 ? { ...e, config } : e)) };
}

/** A short line under a trigger's title: its keywords, intent, refs or chosen ads. */
export function triggerDetail(trigger: StackTrigger): string | null {
  const c = trigger.config;
  const list = (values: string[]) => (values.length ? values.slice(0, 4).join(", ") + (values.length > 4 ? ` +${values.length - 4}` : "") : null);
  switch (trigger.trigger_type) {
    case "keyword":
      if (c.match_type === "intent") return typeof c.intent === "string" && c.intent ? `“${c.intent.slice(0, 60)}”` : null;
      if (c.match_type === "regex") return typeof c.pattern === "string" && c.pattern ? `/${c.pattern}/` : null;
      return list(readStrings(c.keywords));
    case "ig_comment":
      return list(readStrings(c.include_keywords));
    case "ig_story_reply":
    case "ig_live_comment":
      return list(readStrings(c.keywords));
    case "ig_ref":
      return list(readStrings(c.refs));
    case "ad_click":
      return list(readStrings(c.ad_ids));
    default:
      return null;
  }
}

// ------------------------------------------------------------ UI

/** Rows of the stack with a "New trigger" button (or the reason it is unavailable). */
export function TriggerStackRows({ triggers, selected, scope, onSelect, onRemove, onAdd, compact = false }: {
  triggers: StackTrigger[];
  selected?: number | null;
  scope: FlowChannelScope;
  onSelect: (index: number) => void;
  onRemove?: (index: number) => void;
  onAdd: () => void;
  compact?: boolean;
}) {
  const t = useTranslations("Flows.builder");
  const tm = useTranslations("Flows.multiTrigger");
  const block = addTriggerBlock(scope, triggers[0].trigger_type, triggers.length - 1);
  return (
    <div className="flex flex-col gap-1.5">
      {triggers.map((trigger, i) => {
        const detail = triggerDetail(trigger);
        return (
          <div key={i} className={cn("group flex items-center gap-2 rounded-lg border border-border bg-background px-2.5 py-2",
            selected === i && "border-primary ring-1 ring-primary/40")}>
            <button type="button" onClick={() => onSelect(i)} className="nodrag flex min-w-0 flex-1 items-center gap-2 text-left focus-visible:outline-2 focus-visible:outline-primary">
              <span className="flex size-6 shrink-0 items-center justify-center rounded-md bg-primary-soft text-primary"><Zap className="size-3.5" /></span>
              <span className="min-w-0">
                <span className="block truncate text-xs font-medium text-foreground">{t(TRIGGER_TITLE_KEYS[trigger.trigger_type])}</span>
                {detail && !compact && <span className="block truncate text-[10.5px] text-muted-foreground">{detail}</span>}
              </span>
            </button>
            {onRemove && triggers.length > 1 && (
              <button type="button" aria-label={tm("removeTrigger")} title={tm("removeTrigger")} onClick={() => onRemove(i)}
                className="nodrag rounded p-1 text-muted-foreground hover:bg-red-500/10 hover:text-red-400 focus-visible:outline-2 focus-visible:outline-primary">
                <Trash2 className="size-3.5" />
              </button>
            )}
          </div>
        );
      })}
      {block !== "onlyInstagram" && (
        <div>
          <button type="button" onClick={onAdd} disabled={block !== null}
            title={block ? tm(block === "limitReached" ? "limitReached" : "notCombinable", { max: MAX_TRIGGERS }) : undefined}
            className="nodrag inline-flex w-full items-center justify-center gap-1.5 rounded-lg border border-dashed border-border px-2.5 py-1.5 text-xs font-medium text-primary transition-colors hover:bg-primary-soft focus-visible:outline-2 focus-visible:outline-primary disabled:cursor-not-allowed disabled:text-muted-foreground disabled:hover:bg-transparent">
            <Plus className="size-3.5" />{tm("addTrigger")}
          </button>
          {block && <p className="mt-1 text-[10px] text-muted-foreground">{tm(block === "limitReached" ? "limitReached" : "notCombinable", { max: MAX_TRIGGERS })}</p>}
        </div>
      )}
    </div>
  );
}

/** "Start this automation when…": search, combinable triggers selectable, the rest shown with the reason. */
export function TriggerPickerDialog({ open, onOpenChange, offered, onPick }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  offered: readonly FlowTriggerType[];
  onPick: (type: FlowTriggerType) => void;
}) {
  const t = useTranslations("Flows.builder");
  const tm = useTranslations("Flows.multiTrigger");
  const [query, setQuery] = useState("");
  const options = useMemo(() => {
    const q = query.trim().toLocaleLowerCase();
    return triggerPickerOptions(offered).filter((o) => !q || t(TRIGGER_TITLE_KEYS[o.type]).toLocaleLowerCase().includes(q));
  }, [offered, query, t]);
  return (
    <Dialog open={open} onOpenChange={(next) => { onOpenChange(next); if (!next) setQuery(""); }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{tm("pickerTitle")}</DialogTitle>
          <DialogDescription>{tm("notCombinable")}</DialogDescription>
        </DialogHeader>
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-2.5 size-3.5 text-muted-foreground" />
          <Input autoFocus aria-label={tm("search")} placeholder={tm("search")} value={query} onChange={(e) => setQuery(e.target.value)} className="h-9 pl-8 text-xs" />
        </div>
        <div className="flex max-h-80 flex-col gap-1 overflow-y-auto">
          {options.map(({ type, combinable }) => (
            <Button key={type} type="button" variant="ghost" disabled={!combinable} title={combinable ? undefined : tm("notCombinable")}
              className="h-auto justify-start gap-2 py-2 text-left" onClick={() => { onPick(type); onOpenChange(false); setQuery(""); }}>
              <Zap className="size-3.5 text-primary" />
              <span className="flex flex-col">
                <span className="text-sm">{t(TRIGGER_TITLE_KEYS[type])}</span>
                {!combinable && <span className="text-[10.5px] font-normal text-muted-foreground">{tm("notCombinable")}</span>}
              </span>
            </Button>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}
