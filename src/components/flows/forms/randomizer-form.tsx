"use client";

/**
 * The Randomizer step (Stage 5): 2 to 6 paths (A, B, …), each a share of
 * contacts and its own next step; the shares must total 100. "Same path for
 * the same contact" keeps a contact on one path (the engine hashes contact
 * and step); off, each run picks at random and the pick is stored in the run.
 */

import { Plus, Trash2 } from "lucide-react";
import { useTranslations } from "next-intl";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { FLOW_STEP_LIMITS, type RandomizerPath } from "@/lib/flows/types";
import type { BuilderNode } from "../shared";
import { NodeKeySelect } from "./fields";

type Patch = (patch: Record<string, unknown>) => void;
const PATH_IDS = ["A", "B", "C", "D", "E", "F"] as const;

export function readPaths(value: unknown): RandomizerPath[] {
  return (Array.isArray(value) ? value : []).filter((p): p is RandomizerPath =>
    !!p && typeof p === "object" && typeof (p as RandomizerPath).id === "string").map((p) => ({
    id: p.id,
    weight: typeof p.weight === "number" && Number.isFinite(p.weight) ? p.weight : 0,
    next_node_key: typeof p.next_node_key === "string" ? p.next_node_key : "",
  }));
}

/** Sum of the shares, and whether it is exactly 100 with every share a whole 0–100. */
export function randomizerTotal(paths: readonly RandomizerPath[]): { total: number; valid: boolean } {
  const total = paths.reduce((sum, p) => sum + p.weight, 0);
  const valid = paths.length >= FLOW_STEP_LIMITS.randomizerPathsMin && paths.length <= FLOW_STEP_LIMITS.randomizerPathsMax &&
    paths.every((p) => Number.isInteger(p.weight) && p.weight >= 0 && p.weight <= 100) && total === 100;
  return { total, valid };
}

/** Adds the next free letter, taking its share from the largest path so the total stays 100 when it was. */
export function addPath(paths: readonly RandomizerPath[]): RandomizerPath[] {
  if (paths.length >= FLOW_STEP_LIMITS.randomizerPathsMax) return [...paths];
  const id = PATH_IDS.find((letter) => !paths.some((p) => p.id === letter));
  if (!id) return [...paths];
  const even = Math.floor(100 / (paths.length + 1));
  let largest = 0;
  paths.forEach((p, i) => { if (p.weight > paths[largest].weight) largest = i; });
  const take = paths.length ? Math.min(even, paths[largest].weight) : 100;
  const next = paths.map((p, i) => (i === largest ? { ...p, weight: p.weight - take } : p));
  return [...next, { id, weight: take, next_node_key: "" }];
}

/** Removes path `i` (never below the minimum), giving its share to the first remaining path. */
export function removePath(paths: readonly RandomizerPath[], i: number): RandomizerPath[] {
  if (paths.length <= FLOW_STEP_LIMITS.randomizerPathsMin || i < 0 || i >= paths.length) return [...paths];
  const removed = paths[i];
  const rest = paths.filter((_, j) => j !== i);
  return rest.map((p, j) => (j === 0 ? { ...p, weight: p.weight + removed.weight } : p));
}

export function RandomizerForm({ node, allNodes, onUpdateConfig }: { node: BuilderNode; allNodes: BuilderNode[]; onUpdateConfig: Patch }) {
  const t = useTranslations("Flows.nodes.randomizer");
  const tf = useTranslations("Flows.builder.form");
  const paths = readPaths(node.config.paths);
  const { total, valid } = randomizerTotal(paths);
  const sticky = node.config.sticky === true;
  const save = (next: RandomizerPath[]) => onUpdateConfig({ paths: next });
  const id = (s: string) => `randomizer-${node.node_key}-${s}`;
  return (
    <>
      <p className="text-xs font-medium text-foreground">{t("title")}</p>
      <div className="flex items-start justify-between gap-3">
        <div>
          <label htmlFor={id("sticky")} className="text-xs text-foreground">{t("sticky")}</label>
          <p className="text-[10px] text-muted-foreground">{t("stickyHelp")}</p>
        </div>
        <Switch id={id("sticky")} checked={sticky} onCheckedChange={(checked) => onUpdateConfig({ sticky: checked })} />
      </div>
      <div className="space-y-2">
        {paths.map((path, i) => (
          <div key={path.id} className="grid grid-cols-[2rem_1fr_5rem_auto] items-center gap-2 rounded-md border border-border p-2">
            <span className="flex size-7 items-center justify-center rounded-md bg-muted text-xs font-semibold">{path.id}</span>
            <input type="range" min={0} max={100} step={1} value={path.weight} aria-label={t("weight")}
              onChange={(e) => save(paths.map((p, j) => (j === i ? { ...p, weight: Number(e.target.value) } : p)))}
              className="accent-[var(--primary)]" />
            <div className="flex items-center gap-1">
              <Input id={id(`weight-${path.id}`)} type="number" inputMode="numeric" min={0} max={100} value={String(path.weight)}
                aria-label={`${t("path", { id: path.id })} · ${t("weight")}`} className="h-8 bg-muted px-1.5 text-xs"
                onChange={(e) => save(paths.map((p, j) => (j === i ? { ...p, weight: e.target.value === "" ? 0 : Math.trunc(Number(e.target.value)) } : p)))} />
              <span className="text-xs text-muted-foreground">%</span>
            </div>
            <Button type="button" variant="ghost" size="icon-sm" aria-label={tf("removeButton")} disabled={paths.length <= FLOW_STEP_LIMITS.randomizerPathsMin}
              onClick={() => save(removePath(paths, i))} className="text-red-400 hover:bg-red-500/10 hover:text-red-300">
              <Trash2 className="size-3.5" />
            </Button>
            <div className="col-span-4">
              <NodeKeySelect value={path.next_node_key || null} nodes={allNodes} excludeKey={node.node_key}
                onChange={(v) => save(paths.map((p, j) => (j === i ? { ...p, next_node_key: v ?? "" } : p)))} placeholder={tf("nextNodePlaceholder")} />
            </div>
          </div>
        ))}
      </div>
      <p className={valid ? "text-xs text-muted-foreground" : "text-xs text-amber-500"} aria-live="polite">
        {t("total", { total })}{valid ? "" : ` · ${paths.length < FLOW_STEP_LIMITS.randomizerPathsMin || paths.length > FLOW_STEP_LIMITS.randomizerPathsMax ? t("limit") : t("totalInvalid")}`}
      </p>
      <Button type="button" variant="outline" size="sm" className="self-start" disabled={paths.length >= FLOW_STEP_LIMITS.randomizerPathsMax}
        onClick={() => save(addPath(paths))}>
        <Plus className="size-3.5" />{t("addPath")}
      </Button>
    </>
  );
}
