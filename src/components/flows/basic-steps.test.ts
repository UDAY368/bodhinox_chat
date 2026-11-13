import { describe, expect, it } from 'vitest';
import { duplicateStep, groupSteps, moveStepDown, moveStepUp, stepMoves } from './basic-steps';
import type { BuilderNode } from './shared';

const msg = (key: string, next?: string): BuilderNode =>
  ({ node_key: key, node_type: 'send_message', config: next ? { text: key, next_node_key: next } : { text: key } });
const buttons = (key: string, targets: string[]): BuilderNode =>
  ({ node_key: key, node_type: 'send_buttons', config: { text: key, buttons: targets.map((t, i) => ({ id: `b${i}`, reply_id: `b${i}`, title: t, next_node_key: t })) } });
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

const next = (state: { nodes: BuilderNode[] }, key: string) =>
  (state.nodes.find((n) => n.node_key === key)?.config as { next_node_key?: string }).next_node_key ?? '';
const order = (state: { nodes: BuilderNode[]; entry_node_id: string | null }) =>
  keys(groupSteps(state.nodes, state.entry_node_id).connected);

describe('moveStepUp / moveStepDown', () => {
  const line = { nodes: [msg('a', 'b'), msg('b', 'c'), msg('c')], entry_node_id: 'a' };

  it('swaps a step with the one before it in a straight line, rewiring the links around them', () => {
    const up = moveStepUp(line, 'c')!;
    expect(order(up)).toEqual(['a', 'c', 'b']);
    expect([next(up, 'a'), next(up, 'c'), next(up, 'b')]).toEqual(['c', 'b', '']);
  });

  it('moves the first step down and the second up by changing the flow’s first step', () => {
    const down = moveStepDown(line, 'a')!;
    expect(down.entry_node_id).toBe('b');
    expect(order(down)).toEqual(['b', 'a', 'c']);
    expect(order(moveStepUp(line, 'b')!)).toEqual(['b', 'a', 'c']);
  });

  it('does not move past the ends of the line', () => {
    expect(moveStepUp(line, 'a')).toBeNull();
    expect(moveStepDown(line, 'c')).toBeNull();
    expect(stepMoves(line, 'b')).toEqual({ up: true, down: true });
  });

  it('repoints a button that led to the parent at the moved step', () => {
    const state = { nodes: [buttons('menu', ['x']), msg('x', 'y'), msg('y')], entry_node_id: 'menu' };
    const up = moveStepUp(state, 'y')!;
    const menu = up.nodes.find((n) => n.node_key === 'menu')!.config as { buttons: { next_node_key: string }[] };
    expect(menu.buttons[0].next_node_key).toBe('y');
    expect(order(up)).toEqual(['menu', 'y', 'x']);
  });

  it('refuses a move that would change a branch: a step with buttons, or one several steps lead to', () => {
    const state = { nodes: [msg('a', 'menu'), buttons('menu', ['x']), msg('x')], entry_node_id: 'a' };
    expect(moveStepUp(state, 'menu')).toBeNull();
    expect(moveStepUp(state, 'x')).toBeNull();
    const shared = { nodes: [buttons('m', ['a', 'b']), msg('a', 'b'), msg('b')], entry_node_id: 'm' };
    expect(moveStepUp(shared, 'b')).toBeNull();
  });

  it('never moves the start step or a private reply', () => {
    const start: BuilderNode = { node_key: 's', node_type: 'start', config: { next_node_key: 'a' } };
    const state = { nodes: [start, msg('a', 'b'), msg('b')], entry_node_id: 's' };
    expect(moveStepUp(state, 'a')).toBeNull();
    expect(order(moveStepUp(state, 'b')!)).toEqual(['s', 'b', 'a']);
  });
});

describe('duplicateStep', () => {
  it('copies a straight-line step into its line, right after it', () => {
    const state = { nodes: [msg('a', 'b'), msg('b')], entry_node_id: 'a' };
    const copy = duplicateStep(state, 'a', 'a_2')!;
    expect(keys(copy.nodes)).toEqual(['a', 'a_2', 'b']);
    expect(order(copy)).toEqual(['a', 'a_2', 'b']);
    expect(copy.nodes[1].config).toEqual({ text: 'a', next_node_key: 'b' });
    // A deep copy: editing the copy leaves the original alone.
    expect(copy.nodes[1].config).not.toBe(copy.nodes[0].config);
  });

  it('copies a branching step with the same links, with nothing leading to it yet', () => {
    const state = { nodes: [buttons('m', ['x']), msg('x')], entry_node_id: 'm' };
    const copy = duplicateStep(state, 'm', 'm_2')!;
    expect(groupSteps(copy.nodes, copy.entry_node_id).unconnected.map((n) => n.node_key)).toEqual(['m_2']);
    expect((copy.nodes[1].config as { buttons: { next_node_key: string }[] }).buttons[0].next_node_key).toBe('x');
  });

  it('refuses the start step, a private reply and a key in use', () => {
    const state = { nodes: [{ node_key: 's', node_type: 'start', config: {} } as BuilderNode, msg('a')], entry_node_id: 's' };
    expect(duplicateStep(state, 's', 's_2')).toBeNull();
    expect(duplicateStep(state, 'a', 's')).toBeNull();
  });
});
