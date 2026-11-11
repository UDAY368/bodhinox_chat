// Stage 5 (5A) foundation: the new steps and settings are registered but not
// run yet, so the publish validator refuses them (code stage5Pending) and the
// automation validator refuses the new trigger and step types; the canvas
// knows their ports; the contract modules are safe no-ops. Flows that use none
// of them (every flow before Stage 5) validate exactly as before.
import { describe, expect, it } from 'vitest';
import { stage5PendingIssues, validateFlowForActivation } from './validate';
import { applyEdgeConnection, deriveCanvasEdges, outgoingSlots, unlinkNodeReferences } from './edges';
import { STAGE5_NODE_TYPES, FLOW_ACTION_TYPES, FLOW_ACTION_GROUPS, CONDITION_SUBJECTS, IG_TEST_USERNAME } from './types';
import { validateStepsForActivation, validateTriggerForActivation } from '@/lib/automations/validate';
import { channelConsent } from '@/lib/contacts/channel-consent';
import { linkClicked, trackedUrl } from './link-tracking';
import { buyButtonUrl } from './buy-button';
import { runGoalTurn } from '@/lib/ai/goals';
import { intentMatches } from '@/lib/ai/intent-match';
import { executeSheetsNode } from '@/lib/integrations/google-sheets/node';
import type { BuilderNode } from '@/components/flows/shared';
import { STEP_GROUP, NODE_META, summarizeNode, STAGE5_ADD_NODE_TYPES, ADD_NODE_TYPES } from '@/components/flows/shared';
import type { FlowNodeRow, FlowRunRow } from './types';

const flow = { name: 'Welcome', trigger_type: 'keyword' as const, trigger_config: { keywords: ['hi'] }, entry_node_id: 'start' };
const nodes = [
  { node_key: 'start', node_type: 'start', config: { next_node_key: 'msg' } },
  { node_key: 'msg', node_type: 'send_message', config: { text: 'Hello', next_node_key: 'end' } },
  { node_key: 'end', node_type: 'end', config: {} },
];
const pending = (issues: ReturnType<typeof validateFlowForActivation>) => issues.filter((i) => i.code === 'stage5Pending');

describe('Stage 5 publish stub (5A; 5B replaces it)', () => {
  it('leaves a flow without Stage 5 features exactly as before', () => {
    expect(validateFlowForActivation(flow, nodes)).toEqual([]);
    expect(validateFlowForActivation({ ...flow, extra_triggers: [] }, nodes)).toEqual([]);
  });

  it.each(STAGE5_NODE_TYPES)('refuses to publish a %s step', (type) => {
    const withStep = [
      { node_key: 'start', node_type: 'start', config: { next_node_key: 'x' } },
      { node_key: 'x', node_type: type, config: { next_node_key: 'end', failure_next: 'end', paths: [], actions: [] } },
      { node_key: 'end', node_type: 'end', config: {} },
    ];
    const issues = pending(validateFlowForActivation(flow, withStep));
    expect(issues).toEqual([expect.objectContaining({ severity: 'error', scope: 'node', node_key: 'x', field: 'node_type' })]);
  });

  it('refuses extra triggers, intent matching, a reply delay, AI goals, save-to, success actions and buy buttons', () => {
    expect(stage5PendingIssues({ trigger_config: {}, extra_triggers: [{ trigger_type: 'keyword', config: {} }] }, []))
      .toEqual([expect.objectContaining({ scope: 'flow', field: 'extra_triggers' })]);
    expect(stage5PendingIssues({ trigger_config: { match_type: 'intent', intent: 'price' } }, []))
      .toEqual([expect.objectContaining({ field: 'trigger_config.match_type' })]);
    expect(stage5PendingIssues({ trigger_config: { post_scope: 'any', reply_delay_seconds: 30 } }, []))
      .toEqual([expect.objectContaining({ field: 'trigger_config.reply_delay_seconds' })]);
    // A zero delay is the same as none.
    expect(stage5PendingIssues({ trigger_config: { reply_delay_seconds: 0 } }, [])).toEqual([]);
    const fields = (config: Record<string, unknown>, node_type = 'ai_reply') =>
      stage5PendingIssues({ trigger_config: {} }, [{ node_key: 'n', node_type, config }]).map((i) => i.field);
    expect(fields({ goals: [{ type: 'grow_followers' }] })).toEqual(['goals']);
    expect(fields({ goals: [] })).toEqual([]);
    expect(fields({ save_to: { target: 'contact_field', key: 'email' } }, 'collect_input')).toEqual(['save_to']);
    expect(fields({ on_success_actions: [{ type: 'add_tag', tag_id: 't' }] }, 'collect_input')).toEqual(['on_success_actions']);
    expect(fields({ card: { title: 'x', buttons: [{ type: 'buy', title: 'Buy', amount_minor: 100, currency: 'INR' }] } }, 'send_card'))
      .toEqual(['card.buttons']);
    expect(fields({ cards: [{ title: 'x', buttons: [{ type: 'web_url', title: 'Go', url: 'https://x.test' }] }] }, 'send_gallery')).toEqual([]);
    expect(fields({ cards: [{ title: 'x', buttons: [{ type: 'buy', title: 'Buy', amount_minor: 1, currency: 'INR' }] }] }, 'send_gallery'))
      .toEqual(['card.buttons']);
  });
});

describe('Stage 5 automation contact events and start_flow (5D)', () => {
  const TAG = '11111111-1111-4111-8111-111111111111';
  const FLOW = '22222222-2222-4222-8222-222222222222';
  it('accepts the new trigger types and the start_flow step on both channels when configured', () => {
    for (const channel of ['whatsapp', 'instagram'] as const) {
      expect(validateTriggerForActivation('tag_removed', { tag_id: TAG }, [], channel)).toEqual([]);
      expect(validateTriggerForActivation('field_changed', { field: 'email' }, [], channel)).toEqual([]);
      expect(validateTriggerForActivation('field_changed', { field: `custom:${TAG}` }, [], channel)).toEqual([]);
      expect(validateStepsForActivation([{ step_type: 'start_flow', step_config: { flow_id: FLOW } }], channel)).toEqual([]);
    }
  });

  it('refuses them unconfigured', () => {
    expect(validateTriggerForActivation('tag_removed', {}, [], 'whatsapp'))
      .toEqual(expect.arrayContaining([expect.objectContaining({ path: 'trigger.tag_id' })]));
    for (const field of [undefined, 'phone', 'custom:', 'custom:not-a-uuid'])
      expect(validateTriggerForActivation('field_changed', { field }, [], 'instagram'), String(field))
        .toEqual(expect.arrayContaining([expect.objectContaining({ path: 'trigger.field' })]));
    expect(validateStepsForActivation([{ step_type: 'start_flow', step_config: { flow_id: 'f' } }], 'whatsapp'))
      .toEqual(expect.arrayContaining([expect.objectContaining({ path: 'steps[0].flow_id' })]));
  });

  it('leaves the existing triggers alone', () => {
    expect(validateTriggerForActivation('tag_added', { tag_id: TAG }, [], 'whatsapp')).toEqual([]);
  });
});

describe('Stage 5 canvas ports', () => {
  const node = (node_key: string, node_type: BuilderNode['node_type'], config: Record<string, unknown>): BuilderNode => ({ node_key, node_type, config });
  const end = node('end', 'end', {});
  const other = node('other', 'end', {});

  it('gives a randomizer one port per path and wires, derives and unlinks them', () => {
    const r = node('split', 'randomizer', { sticky: false, paths: [{ id: 'A', weight: 60, next_node_key: 'end' }, { id: 'B', weight: 40, next_node_key: '' }] });
    expect(outgoingSlots(r)).toEqual([{ id: 'path:A', label: 'A · 60%' }, { id: 'path:B', label: 'B · 40%' }]);
    expect(deriveCanvasEdges([r, end])).toEqual([expect.objectContaining({ source: 'split', target: 'end', sourceHandle: 'path:A' })]);
    expect(applyEdgeConnection(r, 'path:B', 'other')).toEqual({ paths: [{ id: 'A', weight: 60, next_node_key: 'end' }, { id: 'B', weight: 40, next_node_key: 'other' }] });
    expect(applyEdgeConnection(r, 'path:C', 'other')).toBeNull();
    const [unlinked] = unlinkNodeReferences([r, end, other], 'end');
    expect((unlinked.config.paths as Array<{ next_node_key: string }>)[0].next_node_key).toBe('');
  });

  it('gives actions and smart delay one next port, Google Sheets a failure port and AI goals a finish port', () => {
    for (const type of ['actions', 'smart_delay'] as const) {
      const n = node('n', type, { next_node_key: 'end' });
      expect(outgoingSlots(n)).toEqual([{ id: 'next', label: 'Next' }]);
      expect(applyEdgeConnection(n, 'next', 'other')).toEqual({ next_node_key: 'other' });
    }
    const sheets = node('s', 'google_sheets', { next_node_key: 'end', failure_next: 'other' });
    expect(outgoingSlots(sheets).map((s) => s.id)).toEqual(['next', 'failed']);
    expect(deriveCanvasEdges([sheets, end, other]).map((e) => e.sourceHandle).sort()).toEqual(['failed', 'next']);
    expect(unlinkNodeReferences([sheets, end, other], 'other')[0].config.failure_next).toBe('');
    const ai = node('ai', 'ai_reply', { next_node_key: 'end', handoff_next: 'end', goals: [{ type: 'grow_followers' }], finish_next: 'other' });
    expect(outgoingSlots(ai).map((s) => s.id)).toEqual(['answered', 'handoff', 'finish']);
    expect(outgoingSlots(node('ai', 'ai_reply', { next_node_key: 'end', handoff_next: 'end' })).map((s) => s.id)).toEqual(['answered', 'handoff']);
  });
});

describe('Stage 5 builder metadata', () => {
  it('registers every new step with an icon, a group and a summary, but keeps it out of the menus until its form lands', () => {
    for (const type of STAGE5_ADD_NODE_TYPES) {
      expect(NODE_META[type].category).toBe('logic');
      expect(STEP_GROUP[type]).toBe('logic');
      expect(ADD_NODE_TYPES).not.toContain(type);
    }
    expect(STEP_GROUP.ai_reply).toBe('ai');
    expect(STEP_GROUP.send_card).toBe('content');
    expect(STEP_GROUP.start).toBe('start');
    expect(summarizeNode({ node_key: 'a', node_type: 'actions', config: { actions: [{}, {}] } })).toBe('2 actions');
    expect(summarizeNode({ node_key: 'a', node_type: 'actions', config: {} })).toBe('No actions yet');
    expect(summarizeNode({ node_key: 'r', node_type: 'randomizer', config: { sticky: true, paths: [{ weight: 50 }, { weight: 50 }] } }))
      .toBe('50% / 50% · same path per contact');
    expect(summarizeNode({ node_key: 'd', node_type: 'smart_delay', config: { mode: 'duration', amount: 2, unit: 'hours' } })).toBe('Wait 2 hours');
    expect(summarizeNode({ node_key: 'd', node_type: 'smart_delay', config: { mode: 'until_date', date: '2026-12-01T09:30:00Z' } })).toBe('Until 2026-12-01 09:30');
    expect(summarizeNode({ node_key: 'g', node_type: 'google_sheets', config: { op: 'get_row', sheet: 'Leads' } })).toBe('get row · Leads');
  });

  it('groups every action for the picker and lists every condition subject once', () => {
    expect(Object.keys(FLOW_ACTION_GROUPS).sort()).toEqual([...FLOW_ACTION_TYPES].sort());
    expect(new Set(CONDITION_SUBJECTS).size).toBe(CONDITION_SUBJECTS.length);
    expect(CONDITION_SUBJECTS).toEqual(expect.arrayContaining(['system', 'segment', 'link_click', 'workspace_field', 'sequence', 'ig_profile']));
  });

  it('accepts only stored-form Instagram test usernames', () => {
    for (const ok of ['shop.owner', 'a_b_1', 'x']) expect(IG_TEST_USERNAME.test(ok), ok).toBe(true);
    for (const bad of ['@shop', 'Shop', 'a b', '', 'x'.repeat(31), 'a,b']) expect(IG_TEST_USERNAME.test(bad), bad).toBe(false);
  });
});

describe('Stage 5 contract modules are safe no-ops until their batch lands', () => {
  const run = { id: 'r', account_id: 'a', flow_id: 'f', contact_id: 'c', conversation_id: 'v' } as FlowRunRow;
  const node = { node_key: 'n', node_type: 'google_sheets', config: {} } as unknown as FlowNodeRow;

  it('keeps behaviour as before Stage 5', async () => {
    expect(await trackedUrl(run, 'n', 'button:0', 'https://example.test/x')).toBe('https://example.test/x');
    expect(await linkClicked('a', 'r', 'n')).toBe(false);
    expect(await buyButtonUrl(run, 'n', 'card:0:button:0', { type: 'buy', title: 'Buy', amount_minor: 100, currency: 'INR' })).toBeNull();
    expect(await runGoalTurn(run, node, null)).toEqual({ outcome: 'unavailable' });
    expect(await intentMatches('a', 'm', 'how much?', [{ flowId: 'f', intent: 'price' }])).toBeNull();
    expect(await executeSheetsNode(run, node)).toEqual({ port: 'failure', vars: {}, reason: 'not_enabled' });
  });

  it('reads Instagram consent from the stored timestamps', () => {
    expect(channelConsent(null, 'instagram')).toBeNull();
    expect(channelConsent({}, 'instagram')).toBeNull();
    expect(channelConsent({ instagram_opted_in_at: '2026-11-01' }, 'instagram')).toBe('opted_in');
    expect(channelConsent({ instagram_opted_out_at: '2026-11-02', instagram_opted_in_at: '2026-11-01' }, 'instagram')).toBe('opted_out');
    // The contact-wide WhatsApp STOP is not the Instagram state.
    expect(channelConsent({ opted_out_at: '2026-11-02' }, 'instagram')).toBeNull();
  });
});
