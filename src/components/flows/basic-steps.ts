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
