import { describe, expect, it } from 'vitest';
import {
  canonicalDefinition, definitionHash, effectiveFlow, hasUnpublishedChanges, migratableAt, versionNodeMap,
  type DefinitionInput, type FlowVersionRow,
} from './versions';
import { autoConnectTargets, findCrossFlowLoop, validateFlowForActivation, type CrossFlowSnapshot } from './validate';
import { ALL_CAPABILITIES } from './node-registry';
import type { FlowRow } from './types';

const base: DefinitionInput = {
  trigger_type: 'keyword',
  trigger_config: { keywords: ['hi'], match_type: 'contains' },
  entry_node_id: 'start',
  fallback_policy: { on_timeout_hours: 24, on_exhaust: 'handoff' },
  channel_scope: 'whatsapp',
  nodes: [
    { node_key: 'start', node_type: 'start', config: { next_node_key: 'ask' } },
    { node_key: 'ask', node_type: 'collect_input', config: { prompt_text: 'Name?', var_key: 'name', next_node_key: 'done' } },
    { node_key: 'done', node_type: 'end', config: {} },
  ],
};

describe('definition hash', () => {
  it('ignores canvas positions, node order and object key order', () => {
    const moved = {
      ...base,
      trigger_config: { match_type: 'contains', keywords: ['hi'] },
      nodes: [...base.nodes].reverse().map((n, i) => ({ ...n, position_x: i * 100, position_y: 7 })),
    };
    expect(definitionHash(moved)).toBe(definitionHash(base));
    expect(canonicalDefinition(moved)).toBe(canonicalDefinition(base));
  });

  it('changes with the trigger, the entry, the fallback policy, the scope and any node config', () => {
    const variants: DefinitionInput[] = [
      { ...base, trigger_config: { keywords: ['hello'], match_type: 'contains' } },
      { ...base, trigger_type: 'first_inbound_message' },
      { ...base, entry_node_id: 'ask' },
      { ...base, fallback_policy: { on_timeout_hours: 48, on_exhaust: 'handoff' } },
      { ...base, channel_scope: 'any' },
      { ...base, nodes: base.nodes.map((n) => (n.node_key === 'ask' ? { ...n, config: { ...(n.config as object), prompt_text: 'Email?' } } : n)) },
    ];
    for (const v of variants) expect(definitionHash(v)).not.toBe(definitionHash(base));
    expect(hasUnpublishedChanges(base, base)).toBe(false);
    expect(hasUnpublishedChanges(base, null)).toBe(true);
  });

  it('treats a missing channel scope as WhatsApp, as flows before Phase 11 are', () => {
    expect(definitionHash({ ...base, channel_scope: undefined })).toBe(definitionHash(base));
  });
});

function version(over: Partial<FlowVersionRow> = {}): FlowVersionRow {
  return {
    id: 'v1', account_id: 'a', flow_id: 'f', version: 1, trigger_type: 'keyword', trigger_config: { keywords: ['v'] },
    entry_node_id: 'start', fallback_policy: { on_timeout_hours: 2 }, channel_scope: 'any', published_by: null,
    published_at: '2026-11-01T00:00:00.000Z', nodes: base.nodes.map((n) => ({ ...n, config: n.config as Record<string, unknown> })), ...over,
  };
}

describe('version overlay', () => {
  it('takes trigger, entry, fallback and scope from the version, and status and routing from the live flow', () => {
    const flow = { id: 'f', account_id: 'a', status: 'paused', trigger_type: 'manual', trigger_config: {}, entry_node_id: 'other',
      fallback_policy: {}, channel_scope: 'whatsapp', whatsapp_config_id: 'num-1', test_numbers: [] } as unknown as FlowRow;
    const overlaid = effectiveFlow(flow, version());
    expect(overlaid).toMatchObject({ status: 'paused', whatsapp_config_id: 'num-1', trigger_type: 'keyword', entry_node_id: 'start',
      channel_scope: 'any', fallback_policy: { on_timeout_hours: 2 }, version_id: 'v1', version: 1 });
  });

  it('keys the snapshot nodes like flow_nodes rows, first occurrence wins', () => {
    const map = versionNodeMap(version({ nodes: [...version().nodes, { node_key: 'start', node_type: 'end', config: {} }] }));
    expect([...map.keys()]).toEqual(['start', 'ask', 'done']);
    expect(map.get('start')).toMatchObject({ flow_id: 'f', node_type: 'start', config: { next_node_key: 'ask' } });
  });
});

describe('migratableAt', () => {
  it('allows a run waiting at a question that the new version still has with the same type', () => {
    const v2 = version({ id: 'v2', nodes: [...version().nodes.filter((n) => n.node_key !== 'done'), { node_key: 'done', node_type: 'handoff', config: {} }] });
    expect(migratableAt('ask', version(), v2)).toBe(true);
  });

  it('refuses a step the new version dropped or changed type, a step that does not wait, and no step', () => {
    const dropped = version({ id: 'v2', nodes: version().nodes.filter((n) => n.node_key !== 'ask') });
    const retyped = version({ id: 'v2', nodes: version().nodes.map((n) => (n.node_key === 'ask' ? { ...n, node_type: 'ask_media' } : n)) });
    expect(migratableAt('ask', version(), dropped)).toBe(false);
    expect(migratableAt('ask', version(), retyped)).toBe(false);
    expect(migratableAt('start', version(), version({ id: 'v2' }))).toBe(false);
    expect(migratableAt(null, version(), version({ id: 'v2' }))).toBe(false);
  });

  it('moves a button, list or form wait only when it accepts the same replies', () => {
    const at = (node_type: string, config: Record<string, unknown>, id = 'v1') =>
      version({ id, nodes: [{ node_key: 'menu', node_type, config }] });
    const buttons = (...ids: string[]) => ({ body_text: 'Pick', buttons: ids.map((reply_id) => ({ reply_id, title: reply_id, next_node_key: 'x' })) });
    expect(migratableAt('menu', at('send_buttons', buttons('a', 'b')), at('send_buttons', { ...buttons('b', 'a'), body_text: 'New' }, 'v2'))).toBe(true);
    expect(migratableAt('menu', at('send_buttons', buttons('a', 'b')), at('send_buttons', buttons('x', 'y'), 'v2'))).toBe(false);
    const list = (...ids: string[]) => ({ sections: [{ title: 'S', rows: ids.map((reply_id) => ({ reply_id, title: reply_id, next_node_key: 'x' })) }] });
    expect(migratableAt('menu', at('send_list', list('r1', 'r2')), at('send_list', list('r1', 'r2'), 'v2'))).toBe(true);
    expect(migratableAt('menu', at('send_list', list('r1', 'r2')), at('send_list', list('r1'), 'v2'))).toBe(false);
    expect(migratableAt('menu', at('send_form', { form_id: 'f1' }), at('send_form', { form_id: 'f1' }, 'v2'))).toBe(true);
    expect(migratableAt('menu', at('send_form', { form_id: 'f1' }), at('send_form', { form_id: 'f2' }, 'v2'))).toBe(false);
  });

  it('never moves a booking in progress', () => {
    const booking = version({ nodes: [{ node_key: 'book', node_type: 'book_appointment', config: {} }] });
    expect(migratableAt('book', booking, { ...booking, id: 'v2' })).toBe(false);
  });
});

const connect = (key: string, flowId: string) => ({ node_key: key, node_type: 'connect_flow', config: { flow_id: flowId } });
const snapshot = (id: string, nodes: CrossFlowSnapshot['nodes'], entry = 'start'): CrossFlowSnapshot => ({ id, name: `Flow ${id}`, entry_node_id: entry, nodes });

describe('autoConnectTargets', () => {
  it('follows automatic steps to Connect Flow, and stops at a step that waits for the customer', () => {
    const nodes = [
      { node_key: 'start', node_type: 'start', config: { next_node_key: 'cond' } },
      { node_key: 'cond', node_type: 'condition', config: { true_next: 'to_b', false_next: 'menu' } },
      connect('to_b', 'B'),
      { node_key: 'menu', node_type: 'send_buttons', config: { text: 'x', buttons: [{ reply_id: 'c', title: 'C', next_node_key: 'to_c' }] } },
      connect('to_c', 'C'),
    ];
    expect(autoConnectTargets(nodes, 'start')).toEqual(['B']);
    expect(autoConnectTargets(nodes, null)).toEqual([]);
  });

  it('counts a waiting step that times out as automatic through its timeout port', () => {
    const nodes = [
      { node_key: 'start', node_type: 'start', config: { next_node_key: 'ask' } },
      { node_key: 'ask', node_type: 'collect_input', config: { prompt_text: 'x', var_key: 'v', next_node_key: 'end', timeout_minutes: 5, after_timeout: 'to_b' } },
      connect('to_b', 'B'),
      { node_key: 'end', node_type: 'end', config: {} },
    ];
    expect(autoConnectTargets(nodes, 'start')).toEqual(['B']);
  });
});

describe('cross-flow loop', () => {
  const via = (target: string) => [{ node_key: 'start', node_type: 'start', config: { next_node_key: 'go' } }, connect('go', target)];

  it('finds A > B > C > A and names the flows', () => {
    const chain = findCrossFlowLoop(snapshot('A', via('B')), [snapshot('B', via('C')), snapshot('C', via('A'))]);
    expect(chain).toEqual(['Flow A', 'Flow B', 'Flow C', 'Flow A']);
  });

  it('ignores chains broken by customer input, flows that are not live, and a flow restarting itself', () => {
    const waiting = [
      { node_key: 'start', node_type: 'send_buttons', config: { text: 'x', buttons: [{ reply_id: 'a', title: 'A', next_node_key: 'go' }] } },
      connect('go', 'A'),
    ];
    expect(findCrossFlowLoop(snapshot('A', via('B')), [snapshot('B', waiting)])).toBeNull();
    expect(findCrossFlowLoop(snapshot('A', via('B')), [])).toBeNull();
    expect(findCrossFlowLoop(snapshot('A', via('A')), [])).toBeNull();
  });

  it('blocks publishing through validateFlowForActivation only when the server passes the other flows', () => {
    const flow = { id: 'A', name: 'Flow A', trigger_type: 'manual' as const, trigger_config: {}, entry_node_id: 'start' };
    const target = '22222222-2222-4222-8222-222222222222';
    const nodes = via(target);
    const others = [snapshot(target, via('A'))];
    expect(validateFlowForActivation(flow, nodes).some((i) => i.code === 'crossFlowLoop')).toBe(false);
    const issues = validateFlowForActivation(flow, nodes, { otherFlows: others });
    expect(issues).toContainEqual(expect.objectContaining({ severity: 'error', scope: 'flow', code: 'crossFlowLoop' }));
  });
});

describe('capability block', () => {
  const flow = { id: 'A', name: 'Pay', trigger_type: 'manual' as const, trigger_config: {}, entry_node_id: 'start' };
  const nodes = [
    { node_key: 'start', node_type: 'start', config: { next_node_key: 'pay' } },
    { node_key: 'pay', node_type: 'payment_link', config: { amount: '100', currency: 'INR', description: 'x', message: 'Pay {{payment_link}}', paid_next: 'done', expired_next: 'done', failed_next: 'done' } },
    { node_key: 'done', node_type: 'end', config: {} },
  ];

  it('makes a provider-gated step unpublishable until the workspace has the provider', () => {
    const blocked = validateFlowForActivation(flow, nodes, { caps: { ...ALL_CAPABILITIES, payments: false } });
    expect(blocked).toContainEqual(expect.objectContaining({ severity: 'error', node_key: 'pay', code: 'capabilityUnavailable', capability: 'payments' }));
    const allowed = validateFlowForActivation(flow, nodes, { caps: ALL_CAPABILITIES });
    expect(allowed.some((i) => i.code === 'capabilityUnavailable')).toBe(false);
  });

  it('leaves the builder (no caps given) unchanged', () => {
    expect(validateFlowForActivation(flow, nodes).some((i) => i.code === 'capabilityUnavailable')).toBe(false);
  });
});
