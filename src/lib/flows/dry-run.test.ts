import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/workspace/attributes', () => ({
  fillWorkspace: (text: string, values: Record<string, string>) =>
    text.replace(/\{\{\s*workspace\.([a-z][a-z0-9_]*)\s*\}\}/g, (_: string, key: string) => (Object.hasOwn(values, key) ? values[key] : '')),
}));

import type { BuilderNode } from '@/components/flows/shared';
import { ALL_CAPABILITIES } from './node-registry';
import {
  apiHost, dryRunCondition, dryRunInterpolate, parseDryRunRequest, simulateDryRun, wouldNotes,
  type DryRunContact, type DryRunGraph, type DryRunWorkspace,
} from './dry-run';

const n = (node_key: string, node_type: string, config: Record<string, unknown>): BuilderNode =>
  ({ node_key, node_type, config } as BuilderNode);
const workspace: DryRunWorkspace = { values: { shop: 'Acme' }, secretKeys: new Set(['api_token']) };
const UUID = '11111111-1111-4111-8111-111111111111';

function contact(over: Partial<DryRunContact> = {}): DryRunContact {
  return { id: UUID, name: 'Asha', phone: '+91******3210', email: null, company: 'Clinic', masked: true,
    tagIds: new Set(['tag-vip']), fields: new Map([['field-city', 'Pune']]), ...over };
}

function graph(nodes: BuilderNode[], entry = 'start'): DryRunGraph {
  return {
    flow: { id: UUID, name: 'Dry', trigger_type: 'keyword', trigger_config: { keywords: ['hi'] }, entry_node_id: entry,
      fallback_policy: {}, channel_scope: 'whatsapp' },
    nodes,
    version: null,
  };
}

describe('parseDryRunRequest', () => {
  it('accepts the documented body and defaults to the draft', () => {
    expect(parseDryRunRequest({})).toEqual({ source: 'draft', contactId: undefined, inputs: [], apiPorts: {} });
    expect(parseDryRunRequest({ source: UUID, contact_id: UUID, inputs: [{ option_id: 'yes' }, { option_id: 'text', text: 'hi' }],
      api_ports: { call_crm: 'route:0', other: 'fallback' } })).toEqual({
      source: { versionId: UUID }, contactId: UUID, inputs: [{ option_id: 'yes' }, { option_id: 'text', text: 'hi' }],
      apiPorts: { call_crm: 'route:0', other: 'fallback' },
    });
    expect(parseDryRunRequest({ source: 'published' })?.source).toBe('published');
  });

  it('refuses malformed or oversized input', () => {
    for (const body of [
      null, [], { source: 'v1' }, { contact_id: 'nope' }, { inputs: 'x' }, { inputs: [{}] },
      { inputs: Array.from({ length: 51 }, () => ({ option_id: 'a' })) },
      { inputs: [{ text: 'x'.repeat(1001) }] }, { inputs: [{ option_id: 'a b' }] },
      { api_ports: { 'bad key': 'fallback' } }, { api_ports: { k: 'route:x' } }, { api_ports: [] },
    ]) expect(parseDryRunRequest(body)).toBeNull();
  });
});

describe('dryRunInterpolate', () => {
  it('fills workspace values, shows secrets as [secret], and never expands placeholders inside answers', () => {
    expect(dryRunInterpolate('{{workspace.shop}} {{workspace.api_token}} {{workspace.missing}}!', {}, workspace)).toBe('Acme [secret] !');
    expect(dryRunInterpolate('Hi {{vars.name}}', { name: '{{workspace.shop}}' }, workspace)).toBe('Hi {{workspace.shop}}');
    expect(dryRunInterpolate('Hi {{vars.name}}{{vars.none}}', { name: 'Asha' }, workspace)).toBe('Hi Asha');
  });
});

describe('dryRunCondition', () => {
  const cond = (rules: unknown[], match?: string) => n('c', 'condition', { rules, match, true_next: 'yes', false_next: 'no' });
  it('evaluates vars without a contact, and contact data with one', () => {
    expect(dryRunCondition(cond([{ subject: 'var', subject_key: 'city', operator: 'equals', value: 'Pune' }]), { city: 'Pune' }, null)).toBe(true);
    expect(dryRunCondition(cond([{ subject: 'tag', subject_key: 'tag-vip', operator: 'present' }]), {}, null)).toBeUndefined();
    expect(dryRunCondition(cond([{ subject: 'tag', subject_key: 'tag-vip', operator: 'present' }]), {}, contact())).toBe(true);
    expect(dryRunCondition(cond([{ subject: 'custom_field', subject_key: 'field-city', operator: 'equals', value: 'Delhi' }]), {}, contact())).toBe(false);
    expect(dryRunCondition(cond([{ subject: 'contact_field', subject_key: 'company', operator: 'contains', value: 'lin' }]), {}, contact())).toBe(true);
  });

  it('never evaluates a masked number (it would let a masked member probe it)', () => {
    const rule = { subject: 'contact_field', subject_key: 'phone', operator: 'contains', value: '98' };
    expect(dryRunCondition(cond([rule]), {}, contact())).toBeUndefined();
    expect(dryRunCondition(cond([rule]), {}, contact({ masked: false, phone: '+919876543210' }))).toBe(true);
  });

  it('stops early like the engine for match any / all', () => {
    const vip = { subject: 'tag', subject_key: 'tag-vip', operator: 'present' };
    const unknown = { subject: 'contact_field', subject_key: 'phone', operator: 'present' };
    expect(dryRunCondition(cond([vip, unknown], 'any'), {}, contact())).toBe(true);
    expect(dryRunCondition(cond([vip, unknown], 'all'), {}, contact())).toBeUndefined();
  });
});

describe('apiHost', () => {
  it('returns the host only, never path, query or credentials, and nothing for a dynamic host', () => {
    expect(apiHost('https://user:pw@api.example.com/v1/x?token={{workspace.api_token}}')).toBe('api.example.com');
    expect(apiHost('https://{{workspace.host}}/x')).toBe('');
    expect(apiHost('not a url')).toBe('');
  });
});

describe('simulateDryRun', () => {
  const nodes = [
    n('start', 'start', { next_node_key: 'hello' }),
    n('hello', 'send_message', { text: 'Welcome to {{workspace.shop}} ({{workspace.api_token}})', next_node_key: 'ask' }),
    n('ask', 'collect_input', { prompt_text: 'Your name?', var_key: 'name', validation: 'any', next_node_key: 'tag' }),
    n('tag', 'set_tag', { mode: 'add', tag_id: 'tag-vip', next_node_key: 'api' }),
    n('api', 'api_request', { method: 'POST', url: 'https://crm.example.com/leads?key={{workspace.api_token}}',
      routes: [{ status: '200', next_node_key: 'pay' }], fallback_next: 'bye' }),
    n('pay', 'payment_link', { amount: '499', currency: 'INR', message: 'Pay {{vars.name}}', paid_next: 'bye' }),
    n('bye', 'handoff', {}),
  ];

  it('fills text, follows the picked API port, and lists every would-side-effect without secrets', () => {
    const result = simulateDryRun(graph(nodes), { inputs: [{ option_id: 'text', text: 'Asha' }], apiPorts: { api: 'route:0' } },
      { workspace, contact: null, caps: ALL_CAPABILITIES });
    expect(result.trace.filter((m) => m.from === 'bot').map((m) => m.text)).toEqual([
      'Welcome to Acme ([secret])', 'Your name?', 'Pay Asha\nhttps://rzp.io/…',
    ]);
    expect(result.applied).toBe(1);
    expect(result.rejected_input).toBeNull();
    expect(result.waiting).toMatchObject({ kind: 'branch', node_key: 'pay' });
    expect(result.notes.map((x) => x.code)).toEqual([
      'would_send_message', 'would_send_message', 'would_tag', 'would_call_api', 'would_create_payment_link',
    ]);
    expect(result.notes.find((x) => x.code === 'would_call_api')?.params).toEqual({ method: 'POST', host: 'crm.example.com' });
    expect(result.notes.find((x) => x.code === 'would_create_payment_link')?.params).toEqual({ amount: '499', currency: 'INR' });
    expect(JSON.stringify(result)).not.toContain('api_token}}');
  });

  it('continues step by step and stops at an input that does not fit', () => {
    const result = simulateDryRun(graph(nodes), { inputs: [{ option_id: 'text', text: 'Asha' }, { option_id: 'route:0' }, { option_id: 'nope' }], apiPorts: {} },
      { workspace, contact: null, caps: ALL_CAPABILITIES });
    expect(result.applied).toBe(2);
    expect(result.rejected_input).toBe(2);
    const done = simulateDryRun(graph(nodes), { inputs: [{ option_id: 'text', text: 'Asha' }, { option_id: 'fallback' }], apiPorts: {} },
      { workspace, contact: null, caps: ALL_CAPABILITIES });
    expect(done.ended).toBe(true);
    expect(done.notes.at(-1)).toMatchObject({ code: 'would_handoff', node_key: 'bye' });
  });

  it('reports the capability block publishing would refuse', () => {
    const result = simulateDryRun(graph(nodes), { inputs: [], apiPorts: {} },
      { workspace, contact: null, caps: { ...ALL_CAPABILITIES, payments: false } });
    expect(result.issues).toContainEqual(expect.objectContaining({ code: 'capabilityUnavailable', node_key: 'pay', capability: 'payments' }));
  });

  it('returns only the masked number of the sample contact', () => {
    const result = simulateDryRun(graph(nodes), { inputs: [], apiPorts: {} }, { workspace, contact: contact(), caps: ALL_CAPABILITIES });
    expect(result.contact).toEqual({ id: UUID, name: 'Asha', phone: '+91******3210' });
  });
});

describe('wouldNotes', () => {
  it('maps templates, bookings, conversions and connect_flow', () => {
    const nodes = [
      n('t', 'send_template', { template_name: 'welcome' }),
      n('b', 'book_appointment', {}),
      n('c', 'conversion_event', { event_name: 'Purchase' }),
      n('f', 'connect_flow', { flow_id: UUID }),
    ];
    const notes = wouldNotes([
      { id: 0, from: 'bot', nodeKey: 't', template: 'welcome' },
      { id: 1, from: 'system', nodeKey: 'b', note: 'book_appointment' },
      { id: 2, from: 'system', nodeKey: 'c', note: 'conversion_event' },
      { id: 3, from: 'system', nodeKey: 'f', note: 'connect_flow' },
      { id: 4, from: 'customer', text: 'hi' },
    ], nodes);
    expect(notes.map((x) => [x.code, x.params])).toEqual([
      ['would_send_template', { template: 'welcome' }],
      ['would_book', {}],
      ['would_send_conversion', { event: 'Purchase' }],
      ['would_connect_flow', { flow_id: UUID }],
    ]);
  });
});
