"use client";

/**
 * Stage 5 variable picker: an insert button beside every text field that
 * supports placeholders. It lists contact fields, custom fields, non-secret
 * workspace fields and the variables set by the flow's other steps, takes an
 * optional fallback ("If empty, use"), and inserts the placeholder at the
 * cursor. The engine (5B) expands `{{contact.x}}`, `{{custom.<id>}}`,
 * `{{workspace.key}}` and `{{vars.x}}`, with `|fallback` when the value is
 * missing; captured answers never expand placeholders.
 */

import { useEffect, useMemo, useState } from "react";
import { Braces, Search } from "lucide-react";
import { useTranslations } from "next-intl";

import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { authFetch } from "@/lib/auth/client";
import type { BuilderNode } from "../shared";
import { useCustomFields } from "./use-pickers";

export type VariableSource = "contact" | "custom" | "workspace" | "vars";

export interface VariableOption {
  source: VariableSource;
  /** What goes after the source in the placeholder (a field name, custom field id or key). */
  key: string;
  label: string;
}

/** Contact fields every flow may read (5B placeholders). */
export const CONTACT_PLACEHOLDER_FIELDS = ["name", "email", "phone", "company", "username"] as const;

/** Fallback text cannot close the placeholder or start another. */
export function cleanFallback(fallback: string): string {
  return fallback.replace(/[{}|]/g, "").trim().slice(0, 100);
}

/** Sources whose placeholder takes a `|fallback` (the engine fills workspace values without one). */
export const FALLBACK_SOURCES: ReadonlySet<VariableSource> = new Set(["contact", "custom", "vars"]);

/**
 * `{{source.key}}`, or `{{source.key|fallback}}` with a fallback. Workspace
 * fields never take one: `{{workspace.key|x}}` is not a placeholder the
 * engine fills, so it would reach the customer as typed.
 */
export function placeholderToken(source: VariableSource, key: string, fallback = ""): string {
  const clean = FALLBACK_SOURCES.has(source) ? cleanFallback(fallback) : "";
  return `{{${source}.${key}${clean ? `|${clean}` : ""}}}`;
}

/**
 * Inserts `token` in place of the selection [start, end) of `value`;
 * returns the new value and where the cursor goes (after the token). A
 * missing selection appends.
 */
export function insertAtCursor(value: string, start: number | null | undefined, end: number | null | undefined, token: string): { value: string; caret: number } {
  const from = typeof start === "number" && start >= 0 && start <= value.length ? start : value.length;
  const to = typeof end === "number" && end >= from && end <= value.length ? end : from;
  return { value: value.slice(0, from) + token + value.slice(to), caret: from + token.length };
}

/** Variables the flow's steps set (answers, set-value steps, API mappings, sheet rows), except `excludeKey`'s. */
export function flowVariables(nodes: readonly BuilderNode[], excludeKey?: string): string[] {
  const keys = new Set<string>();
  const add = (v: unknown) => {
    if (typeof v === "string" && /^[a-zA-Z0-9_]+$/.test(v)) keys.add(v);
  };
  for (const node of nodes) {
    if (node.node_key === excludeKey) continue;
    const cfg = node.config;
    add(cfg.var_key);
    if (node.node_type === "set_attribute" && (cfg.target ?? "var") === "var") add(cfg.key);
    for (const list of [cfg.mappings, cfg.var_map]) {
      if (Array.isArray(list)) for (const m of list) add((m as Record<string, unknown> | null)?.var_key);
    }
  }
  return [...keys].sort();
}

interface WorkspaceAttribute { key: string; is_secret?: boolean }

let attributesPending: Promise<WorkspaceAttribute[]> | null = null;
/** Non-secret workspace fields (GET /api/workspace-attributes never returns secret values; their keys are left out too). */
function loadWorkspaceFields(): Promise<WorkspaceAttribute[]> {
  attributesPending ??= authFetch("/api/workspace-attributes", { cache: "no-store" })
    .then(async (res) => (res.ok ? (((await res.json()) as { attributes?: WorkspaceAttribute[] }).attributes ?? []) : []))
    .then((list) => list.filter((a) => a && typeof a.key === "string" && !a.is_secret))
    .catch(() => {
      attributesPending = null;
      return [];
    });
  return attributesPending;
}

export function useWorkspaceFields(): WorkspaceAttribute[] {
  const [items, setItems] = useState<WorkspaceAttribute[]>([]);
  useEffect(() => {
    let cancelled = false;
    void loadWorkspaceFields().then((list) => { if (!cancelled) setItems(list); });
    return () => { cancelled = true; };
  }, []);
  return items;
}

/** The picker's groups in display order, filtered by `query`. */
export function variableGroups(options: VariableOption[], query: string): Array<{ source: VariableSource; items: VariableOption[] }> {
  const q = query.trim().toLocaleLowerCase();
  const order: VariableSource[] = ["contact", "custom", "workspace", "vars"];
  return order
    .map((source) => ({ source, items: options.filter((o) => o.source === source && (!q || `${o.label} ${o.key}`.toLocaleLowerCase().includes(q))) }))
    .filter((g) => g.items.length > 0);
}

const GROUP_LABEL: Record<VariableSource, string> = {
  contact: "contactFields",
  custom: "customFields",
  workspace: "workspaceFields",
  vars: "flowVariables",
};

/**
 * The insert button and its list. `nodes` are the flow's steps (for their
 * variables), `currentKey` the step being edited.
 */
export function VariablePicker({ onInsert, nodes, currentKey, id }: {
  onInsert: (token: string) => void;
  nodes: readonly BuilderNode[];
  currentKey?: string;
  id?: string;
}) {
  const t = useTranslations("Flows.variables");
  const customFields = useCustomFields();
  const workspaceFields = useWorkspaceFields();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [fallback, setFallback] = useState("");
  const options = useMemo<VariableOption[]>(() => [
    ...CONTACT_PLACEHOLDER_FIELDS.map((key) => ({ source: "contact" as const, key, label: key })),
    ...customFields.map((f) => ({ source: "custom" as const, key: f.id, label: f.field_name })),
    ...workspaceFields.map((a) => ({ source: "workspace" as const, key: a.key, label: a.key })),
    ...flowVariables(nodes, currentKey).map((key) => ({ source: "vars" as const, key, label: key })),
  ], [customFields, workspaceFields, nodes, currentKey]);
  const groups = variableGroups(options, query);
  const pick = (o: VariableOption) => {
    onInsert(placeholderToken(o.source, o.key, fallback));
    setOpen(false);
    setQuery("");
    setFallback("");
  };
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        id={id}
        aria-label={t("insert")}
        title={t("insert")}
        // Keep the text field's selection: the click must not move focus first.
        onMouseDown={(e) => e.preventDefault()}
        className="inline-flex h-6 items-center gap-1 rounded-md border border-border bg-card px-1.5 text-[11px] font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-primary"
      >
        <Braces className="size-3" />
      </PopoverTrigger>
      <PopoverContent align="end" className="w-72">
        <div className="relative">
          <Search className="pointer-events-none absolute left-2 top-2.5 size-3.5 text-muted-foreground" />
          <Input autoFocus aria-label={t("search")} placeholder={t("search")} value={query} onChange={(e) => setQuery(e.target.value)} className="h-8 pl-7 text-xs" />
        </div>
        <div className="max-h-56 overflow-y-auto">
          {groups.length === 0 && <p className="px-1 py-3 text-center text-xs text-muted-foreground">{t("empty")}</p>}
          {groups.map((g) => (
            <div key={g.source} className="mb-1.5">
              <p className="px-1 py-1 text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">{t(GROUP_LABEL[g.source])}</p>
              {g.items.map((o) => (
                <button key={`${o.source}:${o.key}`} type="button" onClick={() => pick(o)}
                  className="flex w-full items-center justify-between gap-2 rounded-md px-2 py-1 text-left text-xs hover:bg-primary-soft focus-visible:outline-2 focus-visible:outline-primary">
                  <span className="truncate">{o.label}</span>
                  <code className="truncate text-[10px] text-muted-foreground">{placeholderToken(o.source, o.source === "custom" ? "…" : o.key)}</code>
                </button>
              ))}
            </div>
          ))}
        </div>
        <div>
          <label htmlFor={`${id ?? "variable"}-fallback`} className="mb-1 block text-[11px] text-muted-foreground">{t("fallback")}</label>
          <Input id={`${id ?? "variable"}-fallback`} value={fallback} maxLength={100} onChange={(e) => setFallback(e.target.value)} className="h-8 text-xs" />
          <p className="mt-1 text-[10px] text-muted-foreground">{t("fallbackHelp")}</p>
        </div>
      </PopoverContent>
    </Popover>
  );
}
