import { applyEdgeConnection, deriveCanvasEdges, outgoingSlots } from '@/lib/flows/edges';
import { reachableFromEntry } from '@/lib/flows/validate';
import type { BuilderNode } from './shared';

/**
 * The Simple builder's step list: the steps a customer can reach from the
 * first step, in the order they are reached, then every step nothing leads
 * to (they never run until something connects to them).
 */
export function groupSteps(nodes: BuilderNode[], entry: string | null): { connected: BuilderNode[]; unconnected: BuilderNode[] } {
  const byKey = new Map(nodes.map((n) => [n.node_key, n]));
  const reached = entry && byKey.has(entry) ? reachableFromEntry(entry, nodes) : new Set<string>();
  const connected = [...reached].flatMap((key) => byKey.get(key) ?? []);
  return { connected, unconnected: nodes.filter((n) => !reached.has(n.node_key)) };
}

/** Steps that keep their place: the flow's start step, and a comment flow's private reply (always first). */
const FIXED = new Set<string>(['start', 'ig_private_reply']);

/** A step with exactly one way on, its "Next" link (no buttons, branches or timeout ports). */
function isLinear(node: BuilderNode): boolean {
  const slots = outgoingSlots(node);
  return slots.length === 1 && slots[0].id === 'next';
}

const nextOf = (node: BuilderNode): string => {
  const next = (node.config as { next_node_key?: unknown }).next_node_key;
  return typeof next === 'string' ? next : '';
};

const withConfig = (node: BuilderNode, patch: Record<string, unknown> | null): BuilderNode =>
  (patch ? { ...node, config: { ...node.config, ...patch } } : node);

export interface StepsState { nodes: BuilderNode[]; entry_node_id: string | null }

/**
 * The step that `key` would swap places with when moved up: its only parent,
 * when the two sit in a straight line (the parent's one link is "Next" to this
 * step, nothing else leads here, and this step has one "Next" link of its
 * own). Null when the move would change what a branch, button or timeout
 * leads to: those are rewired by their own links instead.
 */
function swapParent(state: StepsState, key: string): BuilderNode | null {
  const byKey = new Map(state.nodes.map((n) => [n.node_key, n]));
  const node = byKey.get(key);
  if (!node || FIXED.has(node.node_type) || !isLinear(node)) return null;
  const incoming = deriveCanvasEdges(state.nodes).filter((e) => e.target === key);
  if (incoming.length !== 1 || incoming[0].sourceHandle !== 'next') return null;
  const parent = byKey.get(incoming[0].source);
  if (!parent || parent.node_key === key || FIXED.has(parent.node_type) || !isLinear(parent)) return null;
  // A two-step loop (this step leads back to its parent) has no up or down.
  if (nextOf(node) === parent.node_key) return null;
  return parent;
}

/** Moves `key` one place earlier in its straight line; null when it cannot move up. */
export function moveStepUp(state: StepsState, key: string): StepsState | null {
  const parent = swapParent(state, key);
  if (!parent) return null;
  const node = state.nodes.find((n) => n.node_key === key)!;
  const after = nextOf(node);
  // Whatever led to the parent now leads to this step (several links of one step patch in turn).
  const intoParent = deriveCanvasEdges(state.nodes).filter((e) => e.target === parent.node_key);
  const nodes = state.nodes.map((n) => {
    if (n.node_key === key) return withConfig(n, { next_node_key: parent.node_key });
    if (n.node_key === parent.node_key) return withConfig(n, { next_node_key: after });
    return intoParent.filter((e) => e.source === n.node_key)
      .reduce((acc, e) => withConfig(acc, applyEdgeConnection(acc, e.sourceHandle, key)), n);
  });
  return { nodes, entry_node_id: state.entry_node_id === parent.node_key ? key : state.entry_node_id };
}

/** Moves `key` one place later in its straight line; null when it cannot move down. */
export function moveStepDown(state: StepsState, key: string): StepsState | null {
  const node = state.nodes.find((n) => n.node_key === key);
  const next = node ? nextOf(node) : '';
  return next ? moveStepUp(state, next) : null;
}

/** Whether Move up / Move down apply to `key` (the buttons are disabled otherwise). */
export function stepMoves(state: StepsState, key: string): { up: boolean; down: boolean } {
  return { up: moveStepUp(state, key) !== null, down: moveStepDown(state, key) !== null };
}

/**
 * A copy of `key` under `copyKey`, placed right after it. A straight-line step
 * is copied into its line (the step leads to the copy, the copy to what came
 * next); any other step's copy keeps the same links and nothing leads to it
 * yet (it lists under the steps nothing leads to). Null for the start step and
 * a private reply, which a flow has only one of.
 */
export function duplicateStep(state: StepsState, key: string, copyKey: string): StepsState | null {
  const index = state.nodes.findIndex((n) => n.node_key === key);
  const node = state.nodes[index];
  if (!node || FIXED.has(node.node_type) || state.nodes.some((n) => n.node_key === copyKey)) return null;
  const copy: BuilderNode = {
    ...node,
    node_key: copyKey,
    config: structuredClone(node.config),
    ...(typeof node.position_x === 'number' ? { position_x: node.position_x + 40 } : {}),
    ...(typeof node.position_y === 'number' ? { position_y: node.position_y + 40 } : {}),
  };
  const inLine = isLinear(node);
  const nodes = [...state.nodes];
  if (inLine) nodes[index] = withConfig(node, { next_node_key: copyKey });
  nodes.splice(index + 1, 0, copy);
  return { nodes, entry_node_id: state.entry_node_id };
}
