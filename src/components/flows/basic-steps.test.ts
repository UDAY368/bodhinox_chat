import { describe, expect, it } from 'vitest';
import { groupSteps } from './basic-steps';
import type { BuilderNode } from './shared';

const msg = (key: string, next?: string): BuilderNode =>
  ({ node_key: key, node_type: 'send_message', config: next ? { text: key, next_node_key: next } : { text: key } });
const buttons = (key: string, targets: string[]): BuilderNode =>
  ({ node_key: key, node_type: 'send_buttons', config: { text: key, buttons: targets.map((t, i) => ({ id: `b${i}`, title: t, next_node_key: t })) } });
const keys = (nodes: BuilderNode[]) => nodes.map((n) => n.node_key);

describe('groupSteps', () => {
  it('lists the steps reached from the first step in the order they are reached, then the rest in flow order', () => {
    const nodes = [msg('orphan'), msg('second', 'third'), buttons('first', ['second', 'side']), msg('side'), msg('third')];
    const { connected, unconnected } = groupSteps(nodes, 'first');
    expect(keys(connected)).toEqual(['first', 'second', 'side', 'third']);
    expect(keys(unconnected)).toEqual(['orphan']);
  });

  it('visits a loop once', () => {
    const { connected, unconnected } = groupSteps([msg('a', 'b'), msg('b', 'a')], 'a');
    expect(keys(connected)).toEqual(['a', 'b']);
    expect(unconnected).toEqual([]);
  });

  it('treats every step as unconnected without a first step, or when it no longer exists', () => {
    const nodes = [msg('a', 'b'), msg('b')];
    expect(keys(groupSteps(nodes, null).unconnected)).toEqual(['a', 'b']);
    expect(keys(groupSteps(nodes, 'gone').unconnected)).toEqual(['a', 'b']);
    expect(groupSteps(nodes, 'gone').connected).toEqual([]);
  });

  it('skips a link to a step that was deleted', () => {
    const { connected } = groupSteps([msg('a', 'deleted')], 'a');
    expect(keys(connected)).toEqual(['a']);
  });
});
