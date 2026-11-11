"use client";

/**
 * The Google Sheets step (Stage 5; runs in 5G behind GOOGLE_SHEETS_ENABLED
 * and the `sheets` capability): add a row, find a row by a column's value
 * (mapping its columns to flow variables) or update that row. When Google
 * does not confirm a change the step takes its failure path and is never
 * retried. The add-step menus hide the step unless the workspace has the
 * capability; a step that is already placed stays editable.
 */

import { Plus, Trash2 } from "lucide-react";
import { useTranslations } from "next-intl";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { FLOW_STEP_LIMITS, type SheetColumnValue } from "@/lib/flows/types";
import { useWorkspaceCapabilities } from "../palette";
import type { BuilderNode } from "../shared";
import { NextNodeRow } from "./fields";
import { VariablePicker, insertAtCursor } from "./variable-picker";

type Patch = (patch: Record<string, unknown>) => void;
type Op = "insert_row" | "get_row" | "update_row";
const label = "mb-1 block text-xs text-muted-foreground";
const help = "mt-1 text-[10px] text-muted-foreground";

const readColumns = (value: unknown): SheetColumnValue[] =>
  (Array.isArray(value) ? value : []).filter((c): c is SheetColumnValue => !!c && typeof c === "object" && typeof (c as SheetColumnValue).column === "string")
    .map((c) => ({ column: c.column, value: typeof c.value === "string" ? c.value : "" }));
const readVarMap = (value: unknown): Array<{ column: string; var_key: string }> =>
  (Array.isArray(value) ? value : []).filter((m): m is { column: string; var_key: string } => !!m && typeof m === "object" && typeof (m as { column?: unknown }).column === "string")
    .map((m) => ({ column: m.column, var_key: typeof m.var_key === "string" ? m.var_key : "" }));

export function GoogleSheetsForm({ node, allNodes, onUpdateConfig }: { node: BuilderNode; allNodes: BuilderNode[]; onUpdateConfig: Patch }) {
  const t = useTranslations("Flows.nodes.googleSheets");
  const tf = useTranslations("Flows.builder.form");
  const caps = useWorkspaceCapabilities();
  const cfg = node.config;
  const op: Op = cfg.op === "get_row" || cfg.op === "update_row" ? cfg.op : "insert_row";
  const columns = readColumns(cfg.columns);
  const varMap = readVarMap(cfg.var_map);
  const match = cfg.match && typeof cfg.match === "object" ? (cfg.match as SheetColumnValue) : { column: "", value: "" };
  const id = (s: string) => `sheets-${node.node_key}-${s}`;
  const text = (field: "spreadsheet_id" | "sheet") => (typeof cfg[field] === "string" ? (cfg[field] as string) : "");
  return (
    <>
      {caps && !caps.sheets && <p className="text-xs text-amber-500">{t("notConnected")}</p>}
      <div>
        <label htmlFor={id("op")} className={label}>{t("title")}</label>
        <Select value={op} onValueChange={(next) => onUpdateConfig(next === "insert_row" ? { op: next, match: undefined, var_map: undefined } : { op: next })}>
          <SelectTrigger id={id("op")} className="bg-muted"><SelectValue /></SelectTrigger>
          <SelectContent>
            {(["insert_row", "get_row", "update_row"] as const).map((o) => <SelectItem key={o} value={o}>{t(`op_${o}`)}</SelectItem>)}
          </SelectContent>
        </Select>
      </div>
      <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
        <div>
          <label htmlFor={id("spreadsheet")} className={label}>{t("spreadsheet")}</label>
          <Input id={id("spreadsheet")} value={text("spreadsheet_id")} onChange={(e) => onUpdateConfig({ spreadsheet_id: e.target.value.trim() })} className="bg-muted font-mono text-xs" />
        </div>
        <div>
          <label htmlFor={id("sheet")} className={label}>{t("sheet")}</label>
          <Input id={id("sheet")} value={text("sheet")} onChange={(e) => onUpdateConfig({ sheet: e.target.value })} className="bg-muted" />
        </div>
      </div>
      {op !== "insert_row" && (
        <div className="grid grid-cols-2 gap-2">
          <div>
            <label htmlFor={id("match-column")} className={label}>{t("matchColumn")}</label>
            <Input id={id("match-column")} value={match.column} onChange={(e) => onUpdateConfig({ match: { ...match, column: e.target.value } })} className="bg-muted" />
          </div>
          <div>
            <label htmlFor={id("match-value")} className={label}>{t("matchValue")}</label>
            <Input id={id("match-value")} value={match.value} onChange={(e) => onUpdateConfig({ match: { ...match, value: e.target.value } })} className="bg-muted" />
          </div>
        </div>
      )}
      {op !== "get_row" && (
        <fieldset className="space-y-2">
          <legend className={label}>{t("columns")}</legend>
          {columns.map((c, i) => (
            <div key={i} className="grid grid-cols-[1fr_1.4fr_auto_auto] items-center gap-1.5">
              <Input aria-label={`${t("columns")} ${i + 1}`} value={c.column} placeholder="A" className="bg-muted"
                onChange={(e) => onUpdateConfig({ columns: columns.map((x, j) => (j === i ? { ...x, column: e.target.value } : x)) })} />
              <Input id={id(`value-${i}`)} aria-label={`${tf("valueLabel")} ${i + 1}`} value={c.value} className="bg-muted"
                onChange={(e) => onUpdateConfig({ columns: columns.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)) })} />
              <VariablePicker id={id(`value-${i}-vars`)} nodes={allNodes} currentKey={node.node_key} onInsert={(token) => {
                const el = document.getElementById(id(`value-${i}`)) as HTMLInputElement | null;
                const next = insertAtCursor(c.value, el?.selectionStart, el?.selectionEnd, token).value;
                onUpdateConfig({ columns: columns.map((x, j) => (j === i ? { ...x, value: next } : x)) });
              }} />
              <Button type="button" variant="ghost" size="icon-sm" aria-label={tf("removeButton")}
                onClick={() => onUpdateConfig({ columns: columns.filter((_, j) => j !== i) })} className="text-red-400 hover:bg-red-500/10 hover:text-red-300">
                <Trash2 className="size-3.5" />
              </Button>
            </div>
          ))}
          <Button type="button" variant="outline" size="sm" disabled={columns.length >= FLOW_STEP_LIMITS.sheetColumns}
            onClick={() => onUpdateConfig({ columns: [...columns, { column: "", value: "" }] })}>
            <Plus className="size-3.5" />{t("addColumn")}
          </Button>
        </fieldset>
      )}
      {op === "get_row" && (
        <fieldset className="space-y-2">
          <legend className={label}>{t("varMap")}</legend>
          {varMap.map((m, i) => (
            <div key={i} className="grid grid-cols-[1fr_1fr_auto] items-center gap-1.5">
              <Input aria-label={`${t("columns")} ${i + 1}`} value={m.column} placeholder="A" className="bg-muted"
                onChange={(e) => onUpdateConfig({ var_map: varMap.map((x, j) => (j === i ? { ...x, column: e.target.value } : x)) })} />
              <Input aria-label={`${tf("varName")} ${i + 1}`} value={m.var_key} placeholder={tf("varKeyPlaceholder")} className="bg-muted font-mono text-xs"
                onChange={(e) => onUpdateConfig({ var_map: varMap.map((x, j) => (j === i ? { ...x, var_key: e.target.value.replace(/[^a-zA-Z0-9_]/g, "") } : x)) })} />
              <Button type="button" variant="ghost" size="icon-sm" aria-label={tf("removeButton")}
                onClick={() => onUpdateConfig({ var_map: varMap.filter((_, j) => j !== i) })} className="text-red-400 hover:bg-red-500/10 hover:text-red-300">
                <Trash2 className="size-3.5" />
              </Button>
            </div>
          ))}
          <Button type="button" variant="outline" size="sm" disabled={varMap.length >= FLOW_STEP_LIMITS.sheetColumns}
            onClick={() => onUpdateConfig({ var_map: [...varMap, { column: "", var_key: "" }] })}>
            <Plus className="size-3.5" />{t("addColumn")}
          </Button>
        </fieldset>
      )}
      <NextNodeRow value={typeof cfg.next_node_key === "string" ? cfg.next_node_key : ""} allNodes={allNodes} currentKey={node.node_key}
        onChange={(v) => onUpdateConfig({ next_node_key: v })} label={tf("thenAdvanceTo")} />
      <NextNodeRow value={typeof cfg.failure_next === "string" ? cfg.failure_next : ""} allNodes={allNodes} currentKey={node.node_key}
        onChange={(v) => onUpdateConfig({ failure_next: v })} label={t("failure")} />
      <p className={help}>{t("outcomeNote")}</p>
    </>
  );
}
