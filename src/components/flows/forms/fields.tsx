"use client";

/**
 * Reusable field components shared across every per-node form.
 *
 * `NodeKeySelect` — picks a node from the flow's node list, rendered
 * with the source node's icon so the dropdown reads as
 * "destination = ◇ menu" rather than an opaque slug.
 *
 * `NextNodeRow` — wraps NodeKeySelect with a label; the most common
 * per-node form row ("after this node, advance to…").
 *
 * `TextRow` — wraps Input or Textarea behind a label. A multi-line row is
 * the message composer: a rounded box with a dark toolbar (emoji, variables
 * and a character count) docked on its lower edge.
 *
 * Lives in src/components/flows/forms/ so both the list view's
 * collapsed-card editor and the canvas view's side-panel editor
 * (introduced in this PR) mount the exact same form components.
 */

import { useId, useRef } from "react";
import { Smile } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { useTranslations } from "next-intl";
import { NODE_META, type BuilderNode } from "../shared";
import { routableTargets } from "../nodes/ig-node-config";
import { insertAtCursor, VariablePicker } from "./variable-picker";

export function TextRow({
  label,
  value,
  onChange,
  rows = 1,
  variables,
  id: idProp,
  maxLength,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  rows?: number;
  /** Stage 5: the field takes placeholders; the variable picker lists these steps' variables. */
  variables?: { nodes: readonly BuilderNode[]; currentKey?: string };
  id?: string;
  /** The channel's limit for this text: the composer counts down to it (it does not cut the text). */
  maxLength?: number;
}) {
  const tc = useTranslations("Flows.builder.composer");
  const autoId = useId();
  const id = idProp ?? `text-${autoId}`;
  const ref = useRef<HTMLInputElement & HTMLTextAreaElement>(null);
  // Inserts at the cursor (the field keeps its selection while the picker is open).
  const insert = (token: string) => {
    const el = ref.current;
    const next = insertAtCursor(value, el?.selectionStart, el?.selectionEnd, token);
    onChange(next.value);
    requestAnimationFrame(() => {
      if (!ref.current) return;
      ref.current.focus();
      ref.current.setSelectionRange(next.caret, next.caret);
    });
  };
  if (rows > 1) {
    const left = maxLength === undefined ? null : maxLength - value.length;
    return (
      <div>
        <label htmlFor={id} className="mb-1 block text-xs text-muted-foreground">{label}</label>
        <div className="group relative rounded-[15px] bg-muted transition-shadow focus-within:ring-2 focus-within:ring-primary/40" data-composer="">
          <Textarea
            id={id}
            ref={ref}
            value={value}
            onChange={(e) => onChange(e.target.value)}
            rows={rows}
            className="min-h-[5.5rem] resize-none border-0 bg-transparent px-3.5 pb-9 pt-3 text-sm shadow-none focus-visible:ring-0"
          />
          {/* Dims while the box is idle; never hidden, so a popover keeps its anchor. */}
          <div className="absolute bottom-1.5 right-1.5 flex h-7 items-center divide-x divide-white/15 overflow-hidden rounded-md bg-[#292929] text-white opacity-70 shadow-sm transition-opacity group-focus-within:opacity-100 group-hover:opacity-100" data-testid="composer-toolbar">
            <EmojiPicker label={tc("emoji")} onInsert={insert} />
            {variables && (
              <VariablePicker id={`${id}-vars`} nodes={variables.nodes} currentKey={variables.currentKey} onInsert={insert}
                triggerClassName="inline-flex h-7 items-center px-2 text-white/90 transition-colors hover:bg-white/10 focus-visible:outline-2 focus-visible:outline-primary" />
            )}
            <span className={cn("px-2 text-xs tabular-nums", left !== null && left < 0 && "text-red-300")}
              aria-label={left === null ? tc("characters", { count: value.length }) : tc("charactersLeft", { count: left })}
              title={left === null ? tc("characters", { count: value.length }) : tc("charactersLeft", { count: left })}>
              {left ?? value.length}
            </span>
          </div>
        </div>
      </div>
    );
  }
  return (
    <div>
      <div className="mb-1 flex items-center justify-between gap-2">
        <label htmlFor={id} className="block text-xs text-muted-foreground">{label}</label>
        {variables && <VariablePicker id={`${id}-vars`} nodes={variables.nodes} currentKey={variables.currentKey} onInsert={insert} />}
      </div>
      <Input
        id={id}
        ref={ref}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="bg-muted"
      />
    </div>
  );
}

/** Common emoji, in the order people reach for them in business chats. */
export const COMPOSER_EMOJI = [
  "👋", "😊", "😀", "😍", "🤩", "🥳", "🙏", "👍", "👏", "🙌", "💪", "🔥",
  "✨", "🎉", "🎁", "❤️", "💙", "✅", "❌", "⭐", "📅", "⏰", "📍", "📞",
  "💬", "📩", "🛒", "🛍️", "💰", "💳", "🚚", "👉",
] as const;

/** The composer's emoji button: a small grid inserted at the cursor. */
function EmojiPicker({ label, onInsert }: { label: string; onInsert: (emoji: string) => void }) {
  return (
    <Popover>
      <PopoverTrigger
        aria-label={label}
        title={label}
        // Keep the text field's selection so the emoji lands at the cursor.
        onMouseDown={(e) => e.preventDefault()}
        className="inline-flex h-7 items-center px-2 text-white/90 transition-colors hover:bg-white/10 focus-visible:outline-2 focus-visible:outline-primary"
      >
        <Smile className="size-4" />
      </PopoverTrigger>
      <PopoverContent align="end" className="w-64 p-2">
        <div className="grid grid-cols-8 gap-0.5" role="group" aria-label={label}>
          {COMPOSER_EMOJI.map((emoji) => (
            <button key={emoji} type="button" onClick={() => onInsert(emoji)} aria-label={emoji}
              className="flex h-7 w-7 items-center justify-center rounded text-lg transition-colors hover:bg-muted">
              {emoji}
            </button>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}

export function NextNodeRow({
  value,
  allNodes,
  currentKey,
  onChange,
  label,
}: {
  value: string;
  allNodes: BuilderNode[];
  currentKey: string;
  onChange: (v: string) => void;
  label: string;
}) {
  return (
    <div>
      <label className="mb-1 block text-xs text-muted-foreground">{label}</label>
      <NodeKeySelect
        value={value || null}
        nodes={allNodes}
        excludeKey={currentKey}
        onChange={(v) => onChange(v ?? "")}
        placeholder={useTranslations("Flows.builder.form")("pickNextNode")}
      />
    </div>
  );
}

export function NodeKeySelect({
  value,
  nodes,
  excludeKey,
  onChange,
  placeholder,
  className,
  entry = false,
}: {
  value: string | null;
  nodes: BuilderNode[];
  excludeKey?: string;
  onChange: (v: string | null) => void;
  placeholder?: string;
  className?: string;
  /** Picks the flow's first step rather than a step to route to (any step may be first). */
  entry?: boolean;
}) {
  const t = useTranslations("Flows.builder.form");
  // A "next step" leads into a private reply only from a step allowed before it (routableTargets).
  const options = (entry ? nodes : routableTargets(nodes, value, excludeKey)).filter((n) => n.node_key !== excludeKey);
  return (
    <Select
      value={value ?? "__none__"}
      onValueChange={(v) => onChange(v === "__none__" ? null : v)}
    >
      <SelectTrigger className={cn("bg-muted", className)}>
        <SelectValue placeholder={placeholder ?? "—"} />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="__none__">{t("none")}</SelectItem>
        {options.map((n) => {
          const Icon = NODE_META[n.node_type].icon;
          return (
            <SelectItem key={n.node_key} value={n.node_key}>
              <span className="inline-flex items-center gap-1.5">
                <Icon
                  className={cn("h-3 w-3", NODE_META[n.node_type].color)}
                />
                {n.node_key}
              </span>
            </SelectItem>
          );
        })}
      </SelectContent>
    </Select>
  );
}
