// Randomizer step (Stage 5): splits contacts over 2 to 6 weighted paths.
//
// `sticky` keeps a contact on one path: the pick is a hash of the contact id
// and the node key, so it is the same in every run and on every server. A
// non-sticky pick is random, and the engine writes it to the run (RUN_VAR)
// before advancing, so a retried or resumed step follows the path it already
// took instead of drawing again. Pure and client-safe (no I/O, no Node APIs),
// so the publish validator can use the same path parsing.
import { FLOW_STEP_LIMITS, type RandomizerNodeConfig, type RandomizerPath } from "../types";

/** A path id: A to Z style labels or short slugs (stored in run vars and edge handles). */
export const RANDOMIZER_PATH_ID = /^[A-Za-z0-9_-]{1,20}$/;

/** The usable paths of a step: well-formed ids, whole weights from 0 to 100, unique ids. */
export function randomizerPaths(config: Partial<RandomizerNodeConfig> | Record<string, unknown>): RandomizerPath[] {
  const raw = Array.isArray((config as { paths?: unknown }).paths) ? (config as { paths: unknown[] }).paths : [];
  const seen = new Set<string>();
  const out: RandomizerPath[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const p = item as Record<string, unknown>;
    if (typeof p.id !== "string" || !RANDOMIZER_PATH_ID.test(p.id) || seen.has(p.id)) continue;
    if (typeof p.weight !== "number" || !Number.isInteger(p.weight) || p.weight < 0 || p.weight > 100) continue;
    seen.add(p.id);
    out.push({ id: p.id, weight: p.weight, next_node_key: typeof p.next_node_key === "string" ? p.next_node_key : "" });
  }
  return out;
}

/** Whether the paths are a valid split: 2 to 6 of them, weights totalling exactly 100. */
export function validSplit(paths: readonly RandomizerPath[]): boolean {
  return paths.length >= FLOW_STEP_LIMITS.randomizerPathsMin && paths.length <= FLOW_STEP_LIMITS.randomizerPathsMax
    && paths.reduce((sum, p) => sum + p.weight, 0) === 100;
}

/** The path whose cumulative weight band holds `bucket` (0 ≤ bucket < 100). */
export function pathForBucket(paths: readonly RandomizerPath[], bucket: number): RandomizerPath | null {
  let upper = 0;
  for (const path of paths) {
    upper += path.weight;
    if (path.weight > 0 && bucket < upper) return path;
  }
  // Weights that do not reach 100 (never published that way): the last path with weight.
  return [...paths].reverse().find((p) => p.weight > 0) ?? null;
}

/**
 * 0–99 from a hash of the contact and the step, the same on every run and
 * server (32-bit FNV-1a over the UTF-16 code units; not a security hash, only
 * an even, stable split).
 */
export function stickyBucket(contactId: string, nodeKey: string): number {
  const input = `${contactId.toLowerCase()}\u0000${nodeKey}`;
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash % 100;
}

/** 0–99 from a random number in [0, 1). */
export function randomBucket(random: number): number {
  return Math.min(99, Math.max(0, Math.floor(random * 100)));
}

/**
 * The run variable a non-sticky pick is stored under (the path id). It is kept
 * for the whole run: a retry, a replay or a later visit of the step in the
 * same run follows the same path.
 */
export function pickVar(nodeKey: string): string {
  return `_rnd:${nodeKey}`;
}

/** The pick stored in this run, or null. */
export function storedPick(vars: Readonly<Record<string, unknown>>, nodeKey: string): string | null {
  const raw = vars[pickVar(nodeKey)];
  return typeof raw === "string" && RANDOMIZER_PATH_ID.test(raw) ? raw : null;
}

export interface RandomizerChoice {
  path: RandomizerPath;
  /** True when the pick must be written to the run before advancing. */
  store: boolean;
}

/**
 * The path a run takes. Sticky: by hash. Otherwise the pick already stored in
 * the run (a replay), else a fresh random one to be stored.
 */
export function chooseRandomizerPath(args: {
  config: Partial<RandomizerNodeConfig> | Record<string, unknown>;
  nodeKey: string;
  contactId: string | null;
  vars: Readonly<Record<string, unknown>>;
  random?: () => number;
}): RandomizerChoice | null {
  const paths = randomizerPaths(args.config);
  if (!paths.length) return null;
  if ((args.config as { sticky?: unknown }).sticky === true && args.contactId) {
    const path = pathForBucket(paths, stickyBucket(args.contactId, args.nodeKey));
    return path ? { path, store: false } : null;
  }
  const stored = storedPick(args.vars, args.nodeKey);
  const replay = stored ? paths.find((p) => p.id === stored) : undefined;
  if (replay) return { path: replay, store: false };
  const path = pathForBucket(paths, randomBucket((args.random ?? Math.random)()));
  return path ? { path, store: true } : null;
}
