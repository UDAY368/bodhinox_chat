// Stage 5 (5B) publish rules: the combinable trigger set, the reply delay and
// intent match, the new steps (actions, randomizer, smart delay, Google
// Sheets), the new condition subjects, "save answer to", AI goals, buy
// buttons, and the mixed comment-and-message flow shape.
import { describe, expect, it } from 'vitest';
import { findCrossFlowLoop, validateFlowForActivation } from './validate';
import { previewAcceptsText, startPreview, choose } from './preview';
import type { BuilderNode } from '@/components/flows/shared';

const FLOW_ID = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const UUID = '33333333-3333-4333-8333-333333333333';

const ig = { id: FLOW_ID, name: 'Shop', trigger_type: 'keyword' as const, trigger_config: { keywords: ['price'] }, entry_node_id: 'start',
  channel_scope: 'instagram' as const };
const wa = { ...ig, channel_scope: 'whatsapp' as const };
const n = (node_key: string, node_type: string, config: Record<string, unknown>) => ({ node_key, node_type, config });
const end = n('end', 'end', {});
const via = (step: ReturnType<typeof n>) => [n('start', 'start', { next_node_key: step.node_key }), step, end];
const errors = (issues: ReturnType<typeof validateFlowForActivation>) => issues.filter((i) => i.severity === 'error');
const fields = (issues: ReturnType<typeof validateFlowForActivation>) => errors(issues).map((i) => i.field);

describe('multiple triggers', () => {
  const nodes = via(n('msg', 'send_message', { text: 'Hi', next_node_key: 'end' }));

  it('lets an Instagram flow add up to four combinable triggers', () => {
    const extra = [
      { trigger_type: 'ig_story_reply', config: {} },
      { trigger_type: 'ig_ref', config: { refs: ['spring'] } },
      { trigger_type: 'ad_click', config: {} },
      { trigger_type: 'keyword', config: { keywords: ['cost'] } },
    ];
    expect(errors(validateFlowForActivation({ ...ig, extra_triggers: extra }, nodes))).toEqual([]);
    expect(fields(validateFlowForActivation({ ...ig, extra_triggers: [...extra, extra[0]] }, nodes))).toContain('extra_triggers');
  });

  it('keeps WhatsApp flows, and default reply or manual primaries, to one trigger', () => {
    const extra = [{ trigger_type: 'keyword', config: { keywords: ['cost'] } }];
    expect(fields(validateFlowForActivation({ ...wa, extra_triggers: extra }, nodes))).toContain('extra_triggers');
    for (const trigger_type of ['default_reply', 'manual'] as const) {
      expect(fields(validateFlowForActivation({ ...ig, trigger_type, trigger_config: {}, extra_triggers: extra }, nodes))).toContain('trigger_type');
    }
    expect(fields(validateFlowForActivation({ ...ig, extra_triggers: [{ trigger_type: 'default_reply', config: {} }] }, nodes)))
      .toContain('extra_triggers.0.trigger_type');
  });

  it('checks each extra trigger like a primary one, at its own path', () => {
    const issues = validateFlowForActivation({ ...ig, extra_triggers: [{ trigger_type: 'keyword', config: { keywords: [] } },
      { trigger_type: 'ig_ref', config: { refs: [] } }] }, nodes);
    expect(fields(issues)).toEqual(expect.arrayContaining(['extra_triggers.0.config.keywords', 'extra_triggers.1.config.refs']));
  });

  it('a keyword flow with a comment trigger is a comment flow: the private reply comes first', () => {
    const extra = [{ trigger_type: 'ig_comment', config: { post_scope: 'any' } }];
    expect(errors(validateFlowForActivation({ ...ig, extra_triggers: extra }, nodes)).length).toBeGreaterThan(0);
    const pr = [n('start', 'start', { next_node_key: 'reply' }), n('reply', 'ig_comment_reply', { replies: ['Sent!'], next_node_key: 'pr' }),
      n('pr', 'ig_private_reply', { text: 'Here you go', next_node_key: '' }), end];
    expect(errors(validateFlowForActivation({ ...ig, extra_triggers: extra }, pr))).toEqual([]);
  });
});

describe('trigger settings', () => {
  const nodes = [n('start', 'start', { next_node_key: 'pr' }), n('pr', 'ig_private_reply', { text: 'Hi' }), end];
  const comment = { ...ig, trigger_type: 'ig_comment' as const };

  it('accepts a reply delay of 0 to 600 whole seconds on comment triggers', () => {
    for (const ok of [0, 30, 600]) {
      expect(fields(validateFlowForActivation({ ...comment, trigger_config: { post_scope: 'any', reply_delay_seconds: ok } }, nodes))).toEqual([]);
    }
    for (const bad of [601, -1, 2.5, '30']) {
      expect(fields(validateFlowForActivation({ ...comment, trigger_config: { post_scope: 'any', reply_delay_seconds: bad } }, nodes)))
        .toContain('trigger_config.reply_delay_seconds');
    }
  });

  it('needs an intent sentence of at most 300 characters, and warns without AI', () => {
    const msg = via(n('msg', 'send_message', { text: 'Hi', next_node_key: 'end' }));
    const intent = (text: unknown, aiConfigured?: boolean) => validateFlowForActivation({ ...ig, trigger_config: { keywords: [], match_type: 'intent', intent: text } }, msg, { aiConfigured });
    expect(intent('asks about the price')).toEqual([]);
    expect(fields(intent(''))).toEqual(['trigger_config.intent']);
    expect(fields(intent('x'.repeat(301)))).toEqual(['trigger_config.intent']);
    expect(intent('asks about the price', false)).toEqual([expect.objectContaining({ severity: 'warning', field: 'trigger_config.match_type' })]);
  });
});

describe('new steps', () => {
  it('Actions: 1 to 10 well-formed actions, never starting or stopping this flow', () => {
    const step = (actions: unknown, next = 'end') => validateFlowForActivation(ig, via(n('act', 'actions', { actions, next_node_key: next })));
    expect(errors(step([{ type: 'add_tag', tag_id: UUID }, { type: 'set_workspace_field', key: 'orders', mode: 'increment', value: '1' },
      { type: 'pause_automations', minutes: null }, { type: 'start_flow', flow_id: OTHER }, { type: 'notify_team', target: 'admins', note: 'Lead!' },
      { type: 'set_field', target: 'contact_field', key: 'phone', value: '{{vars.phone}}' }]))).toEqual([]);
    // The last step may be an Actions step.
    expect(errors(validateFlowForActivation(ig, [n('start', 'start', { next_node_key: 'act' }), n('act', 'actions', { actions: [{ type: 'resume_automations' }] })]))).toEqual([]);
    expect(fields(step([]))).toEqual(['actions']);
    expect(fields(step(Array.from({ length: 11 }, () => ({ type: 'resume_automations' }))))).toEqual(['actions']);
    expect(fields(step([{ type: 'start_flow', flow_id: FLOW_ID }, { type: 'stop_flow', flow_id: FLOW_ID }]))).toEqual(['actions.0', 'actions.1']);
    expect(fields(step([{ type: 'set_workspace_field', key: 'orders', mode: 'increment', value: '{{vars.n}}' },
      { type: 'pause_automations', minutes: 45 }, { type: 'set_field', target: 'contact_field', key: 'opted_out_at', value: 'x' }, { type: 'drop_table' }])))
      .toEqual(['actions.0', 'actions.1', 'actions.2', 'actions.3']);
  });

  it('Randomizer: 2 to 6 paths whose shares total 100, each with a next step', () => {
    const split = (paths: unknown) => validateFlowForActivation(ig, [...via(n('r', 'randomizer', { sticky: false, paths })), n('b', 'end', {})]);
    expect(errors(split([{ id: 'A', weight: 50, next_node_key: 'end' }, { id: 'B', weight: 50, next_node_key: 'b' }]))).toEqual([]);
    expect(fields(split([{ id: 'A', weight: 60, next_node_key: 'end' }, { id: 'B', weight: 30, next_node_key: 'b' }]))).toEqual(['paths']);
    expect(fields(split([{ id: 'A', weight: 100, next_node_key: 'end' }]))).toEqual(['paths']);
    expect(fields(split([{ id: 'A', weight: 50, next_node_key: 'end' }, { id: 'B', weight: 50, next_node_key: '' }]))).toEqual(['paths.1.next_node_key']);
  });

  it('Smart delay: a valid wait and next step; on Instagram a long wait is a warning, not a block', () => {
    const delay = (config: Record<string, unknown>, flow: typeof ig | typeof wa = ig) => validateFlowForActivation(flow, via(n('d', 'smart_delay', { next_node_key: 'end', ...config })));
    expect(delay({ mode: 'duration', amount: 2, unit: 'hours' })).toEqual([]);
    const long = delay({ mode: 'duration', amount: 2, unit: 'days' });
    expect(errors(long)).toEqual([]);
    expect(long).toEqual([expect.objectContaining({ severity: 'warning', node_key: 'd' })]);
    expect(delay({ mode: 'duration', amount: 2, unit: 'days' }, wa)).toEqual([]);
    expect(fields(delay({ mode: 'duration', amount: 400, unit: 'days' }, wa))).toEqual(['amount']);
    expect(fields(delay({ mode: 'until_date', date: 'soon' }, wa))).toEqual(['date']);
    expect(fields(delay({ mode: 'duration', amount: 1, unit: 'hours', send_window: { from: '25:00', to: '10:00', weekdays: [] } }, wa))).toEqual(['send_window']);
    expect(fields(delay({ mode: 'duration', amount: 1, unit: 'hours', timezone: 'Mars/Base' }, wa))).toEqual(['timezone']);
    expect(fields(validateFlowForActivation(wa, via(n('d', 'smart_delay', { mode: 'duration', amount: 1, unit: 'hours' }))))).toEqual(['next_node_key']);
  });

  it('Google Sheets: an operation, a sheet, columns and a next step', () => {
    const sheets = (config: Record<string, unknown>) => validateFlowForActivation(ig, via(n('g', 'google_sheets', { next_node_key: 'end', failure_next: 'end', ...config })));
    expect(errors(sheets({ op: 'insert_row', spreadsheet_id: 'abc_123', sheet: 'Leads', columns: [{ column: 'Email', value: '{{contact.email}}' }] }))).toEqual([]);
    expect(errors(sheets({ op: 'get_row', spreadsheet_id: 'abc', sheet: 'Leads', columns: [], match: { column: 'Email', value: 'x' },
      var_map: [{ column: 'Plan', var_key: 'plan' }] }))).toEqual([]);
    expect(fields(sheets({ op: 'update_row', spreadsheet_id: 'a/b', sheet: '', columns: [] }))).toEqual(['spreadsheet_id', 'sheet', 'columns', 'match']);
  });

  it('every Stage 5 logic step counts toward the automatic-loop check', () => {
    const loop = [n('start', 'start', { next_node_key: 'a' }), n('a', 'actions', { actions: [{ type: 'resume_automations' }], next_node_key: 'd' }),
      n('d', 'smart_delay', { mode: 'duration', amount: 1, unit: 'minutes', next_node_key: 'a' })];
    expect(errors(validateFlowForActivation(wa, loop)).some((i) => i.node_key === 'a' || i.node_key === 'd')).toBe(true);
  });

  it('a start_flow ring through other live flows is a cross-flow loop', () => {
    const me = { id: FLOW_ID, name: 'Me', entry_node_id: 'start', nodes: [n('start', 'start', { next_node_key: 'a' }),
      n('a', 'actions', { actions: [{ type: 'start_flow', flow_id: OTHER }] })] };
    const other = { id: OTHER, name: 'Other', entry_node_id: 'start', nodes: [n('start', 'start', { next_node_key: 'a' }),
      n('a', 'actions', { actions: [{ type: 'start_flow', flow_id: FLOW_ID }] })] };
    expect(findCrossFlowLoop(me, [other])).toEqual(['Me', 'Other', 'Me']);
  });
});

describe('conditions, save to, goals and buy buttons', () => {
  const cond = (rule: Record<string, unknown>) => validateFlowForActivation(ig, [n('start', 'start', { next_node_key: 'c' }),
    n('c', 'condition', { match: 'all', rules: [rule], true_next: 'end', false_next: 'end' }), end]);

  it('checks each Stage 5 subject key and allows only yes/no operators on yes/no subjects', () => {
    expect(errors(cond({ subject: 'system', subject_key: 'subscribed', operator: 'equals', value: 'true' }))).toEqual([]);
    expect(errors(cond({ subject: 'segment', subject_key: UUID, operator: 'equals', value: 'true' }))).toEqual([]);
    expect(errors(cond({ subject: 'link_click', subject_key: 'c', operator: 'not_equals', value: 'true' }))).toEqual([]);
    expect(errors(cond({ subject: 'workspace_field', subject_key: 'promo_code', operator: 'present' }))).toEqual([]);
    expect(fields(cond({ subject: 'system', subject_key: 'password_hash', operator: 'present' }))).toEqual(['rules.0.subject_key']);
    expect(fields(cond({ subject: 'segment', subject_key: 'x', operator: 'equals', value: 'true' }))).toEqual(['rules.0.subject_key']);
    expect(fields(cond({ subject: 'link_click', subject_key: 'elsewhere', operator: 'equals', value: 'true' }))).toEqual(['rules.0.subject_key']);
    expect(fields(cond({ subject: 'segment', subject_key: UUID, operator: 'gt', value: '1' }))).toEqual(['rules.0.operator']);
  });

  it('checks where an answer is saved, and the actions on a valid answer', () => {
    const ask = (config: Record<string, unknown>) => validateFlowForActivation(ig, via(n('q', 'collect_input', {
      prompt_text: 'Email?', var_key: 'email', validation: 'email', next_node_key: 'end', ...config })));
    expect(errors(ask({ save_to: { target: 'contact_field', key: 'email' }, on_success_actions: [{ type: 'add_tag', tag_id: UUID }] }))).toEqual([]);
    expect(errors(ask({ save_to: { target: 'custom_field', key: UUID } }))).toEqual([]);
    expect(fields(ask({ save_to: { target: 'contact_field', key: 'blocked_at' } }))).toEqual(['save_to']);
    expect(fields(ask({ on_success_actions: [{ type: 'start_flow', flow_id: FLOW_ID }] }))).toEqual(['on_success_actions.0']);
  });

  it('AI goals: up to three valid goals and a finish step', () => {
    const ai = (config: Record<string, unknown>) => fields(validateFlowForActivation(ig, [n('start', 'start', { next_node_key: 'ai' }),
      n('ai', 'ai_reply', { next_node_key: 'end', handoff_next: 'end', ...config }), end]));
    expect(ai({ goals: [{ type: 'share_link', url: 'https://shop.example/x' }, { type: 'capture_lead', fields: ['email', `custom:${UUID}`], on_refusal: 'continue' }],
      finish_next: 'end' })).not.toEqual(expect.arrayContaining(['goals', 'finish_next']));
    expect(ai({ goals: [{ type: 'grow_followers' }] })).toContain('finish_next');
    expect(ai({ goals: Array.from({ length: 4 }, () => ({ type: 'grow_followers' })), finish_next: 'end' })).toContain('goals');
    expect(ai({ goals: [{ type: 'capture_lead', fields: ['password'], on_refusal: 'maybe' }], finish_next: 'end' }))
      .toEqual(expect.arrayContaining(['goals.0.fields', 'goals.0.on_refusal']));
  });

  it('a buy button needs a valid amount and currency, and payments on publish', () => {
    const card = (button: Record<string, unknown>, payments?: boolean) => validateFlowForActivation(ig,
      via(n('card', 'send_card', { card: { title: 'Mug', buttons: [{ title: 'Buy', ...button }] }, next_node_key: 'end' })),
      payments === undefined ? {} : { caps: { payments } });
    expect(errors(card({ type: 'buy', amount_minor: 49900, currency: 'INR' }))).toEqual([]);
    expect(errors(card({ type: 'buy', amount_minor: 49900, currency: 'INR' }, true))).toEqual([]);
    expect(fields(card({ type: 'buy', amount_minor: 49900, currency: 'INR' }, false))).toEqual(['card.buttons']);
    expect(fields(card({ type: 'buy', amount_minor: 0, currency: 'inr' }))).toEqual(['card.buttons.0']);
  });
});

describe('preview of the new steps', () => {
  const nodes: BuilderNode[] = [
    { node_key: 'start', node_type: 'start', config: { next_node_key: 'act' } },
    { node_key: 'act', node_type: 'actions', config: { actions: [{ type: 'resume_automations' }], next_node_key: 'wait' } },
    { node_key: 'wait', node_type: 'smart_delay', config: { mode: 'duration', amount: 1, unit: 'hours', next_node_key: 'split' } },
    { node_key: 'split', node_type: 'randomizer', config: { paths: [{ id: 'A', weight: 50, next_node_key: 'sheet' }, { id: 'B', weight: 50, next_node_key: 'b' }] } },
    { node_key: 'sheet', node_type: 'google_sheets', config: { next_node_key: 'b', failure_next: 'end' } },
    { node_key: 'b', node_type: 'send_message', config: { text: 'Hi', next_node_key: 'end' } },
    { node_key: 'end', node_type: 'end', config: {} },
  ];

  it('walks actions and a smart delay, lets the author pick a randomizer path and a Sheets outcome', () => {
    let state = startPreview(nodes, 'start');
    expect(state.messages.map((m) => m.note)).toEqual(['actions', 'smart_delay', 'randomizer']);
    expect(state.waiting?.options.map((o) => o.id)).toEqual(['path:A', 'path:B']);
    state = choose(state, 'path:A');
    expect(state.waiting?.options.map((o) => o.id)).toEqual(['next', 'failed']);
    state = choose(state, 'next');
    expect(state.messages.filter((m) => m.from === 'bot').map((m) => m.text)).toEqual(['Hi']);
    expect(state.ended).toBe(true);
    expect(previewAcceptsText(nodes[0], 'x')).toBe(false);
  });
});
