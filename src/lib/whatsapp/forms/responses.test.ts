import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TenantTransaction } from '@/lib/db/tenant';
import type { DataClient } from '@/lib/data/types';

const writes = vi.hoisted(() => ({ calls: [] as Array<[string, string]>, result: true }));
vi.mock('@/lib/contacts/field-write', () => ({
  writeContactField: async (_db: unknown, _a: string, _c: string, field: string, value: string) => {
    writes.calls.push([field, value]);
    return writes.result;
  },
}));

import { applyFormSaveTo, formSummaryText, parseFormReply, recordFormResponse } from './responses';
import { newFlowToken } from './sessions';
import type { FormDefinition } from './types';

const ACCOUNT = '11111111-1111-4111-8111-111111111111';
const FORM = '22222222-2222-4222-8222-222222222222';
const CUSTOM = '33333333-3333-4333-8333-333333333333';

const definition: FormDefinition = {
  version: 1,
  screens: [{
    id: 'MAIN', title: 'Details', button_label: 'Send',
    fields: [
      { id: 'intro', type: 'heading', label: 'Hello' },
      { id: 'full_name', type: 'short_text', label: 'Name', save_to: { kind: 'contact_field', field: 'name' } },
      { id: 'plan', type: 'radio', label: 'Plan', options: [{ id: 'pro', title: 'Pro plan' }, { id: 'free', title: 'Free' }], save_to: { kind: 'custom_field', field_id: CUSTOM } },
      { id: 'topics', type: 'checkboxes', label: 'Topics', options: [{ id: 't1', title: 'Billing' }, { id: 't2', title: 'Support' }] },
      { id: 'agree', type: 'opt_in', label: 'I agree' },
    ],
  }],
};

describe('parseFormReply', () => {
  it('reads answers and the token, keeping the token out of the answers', () => {
    const token = newFlowToken();
    const parsed = parseFormReply({ name: 'flow', response_json: JSON.stringify({ flow_token: token, full_name: 'Ana', topics: ['t1'], agree: true, n: 4 }) });
    expect(parsed).toEqual({ flowToken: token, answers: { full_name: 'Ana', topics: ['t1'], agree: true, n: 4 } });
  });

  it('leaves address forms and malformed replies alone', () => {
    expect(parseFormReply({ name: 'address_message', response_json: '{"values":{}}' })).toBeNull();
    expect(parseFormReply({ name: 'flow', response_json: 'not json' })).toBeNull();
    expect(parseFormReply({ name: 'flow', response_json: '[1,2]' })).toBeNull();
    expect(parseFormReply({ name: 'something_else', response_json: '{}' })).toBeNull();
    expect(parseFormReply({ name: 'flow', response_json: 'x'.repeat(70_000) })).toBeNull();
    expect(parseFormReply(undefined)).toBeNull();
  });

  it('drops odd keys and values, and an unusable token', () => {
    const parsed = parseFormReply({ name: 'flow', response_json: JSON.stringify({ flow_token: 'unused', 'Bad Key': 'x', obj: { a: 1 }, ok: 'y'.repeat(5000) }) });
    expect(parsed?.flowToken).toBeNull();
    expect(Object.keys(parsed!.answers)).toEqual(['ok']);
    expect((parsed!.answers.ok as string).length).toBe(4096);
  });
});

describe('formSummaryText', () => {
  it('lists answers in form order with labels and option titles', () => {
    const text = formSummaryText('Lead form', definition, { topics: ['t1', 't2'], full_name: 'Ana', plan: 'pro', extra: 'kept' });
    const lines = text.split('\n');
    expect(lines).toHaveLength(5);
    expect(lines.slice(1)).toEqual(['Name: Ana', 'Plan: Pro plan', 'Topics: Billing, Support', 'extra: kept']);
  });

  it('still summarises a submission whose form is unknown', () => {
    expect(formSummaryText(null, null, { a: '1' }).split('\n').slice(1)).toEqual(['a: 1']);
  });
});

function fakeTx(script: { session?: Record<string, unknown> | null; inserted?: boolean; earlier?: boolean }) {
  const sql: string[] = [];
  const tx = {
    $queryRaw: vi.fn((strings: TemplateStringsArray) => {
      const text = strings.join('?');
      sql.push(text);
      if (text.includes('FROM whatsapp_form_sessions')) return Promise.resolve(script.session ? [script.session] : []);
      if (text.includes('FROM whatsapp_forms')) return Promise.resolve([{ name: 'Lead form', definition }]);
      if (text.includes('FROM whatsapp_form_responses')) return Promise.resolve(script.earlier ? [{ id: 'resp-0' }] : []);
      if (text.includes('INSERT INTO whatsapp_form_responses')) return Promise.resolve(script.inserted === false ? [] : [{ id: 'resp-1' }]);
      return Promise.resolve([]);
    }),
    $executeRaw: vi.fn(() => {
      sql.push('complete');
      return Promise.resolve(1);
    }),
  };
  return { tx: tx as unknown as TenantTransaction, sql };
}

const session = (patch: Record<string, unknown> = {}) => ({
  id: 'sess-1', form_id: FORM, contact_id: 'contact-1', conversation_id: 'conv-1', flow_run_id: 'run-1', node_key: 'ask',
  expires_at: new Date(Date.now() + 60_000), completed_at: null, ...patch,
});
const input = { accountId: ACCOUNT, contactId: 'contact-1', conversationId: 'conv-1', messageId: 'wamid.1', flowToken: newFlowToken(), answers: { full_name: 'Ana' } };

describe('recordFormResponse', () => {
  it('trusts the first submission on a live session for the same contact', async () => {
    const { tx, sql } = fakeTx({ session: session() });
    const result = await recordFormResponse(tx, input);
    expect(result).toMatchObject({ inserted: true, formId: FORM, formName: 'Lead form', trusted: true, flowRunId: 'run-1', nodeKey: 'ask' });
    expect(sql.find((s) => s.includes('FROM whatsapp_form_sessions'))).toContain('FOR UPDATE');
    expect(sql).toContain('complete');
  });

  it('still trusts a session the forms endpoint already completed', async () => {
    const { tx } = fakeTx({ session: session({ completed_at: new Date() }) });
    expect(await recordFormResponse(tx, input)).toMatchObject({ trusted: true, flowRunId: 'run-1' });
  });

  it.each([
    ['an expired session', { session: session({ expires_at: new Date(Date.now() - 1000) }) }],
    ['another contact', { session: session({ contact_id: 'someone-else' }) }],
    ['a second submission on the session', { session: session(), earlier: true }],
    ['a redelivered message', { session: session(), inserted: false }],
  ])('stores but does not trust %s', async (_name, script) => {
    const { tx } = fakeTx(script);
    const result = await recordFormResponse(tx, input);
    expect(result).toMatchObject({ formId: FORM, trusted: false, flowRunId: null, nodeKey: null });
  });

  it('stores an unknown token without a form, and never looks a missing token up', async () => {
    const unknown = fakeTx({ session: null });
    expect(await recordFormResponse(unknown.tx, input)).toMatchObject({ inserted: true, formId: null, formName: null, trusted: false });
    const none = fakeTx({ session: session() });
    await recordFormResponse(none.tx, { ...input, flowToken: null });
    expect(none.sql.some((s) => s.includes('FROM whatsapp_form_sessions'))).toBe(false);
    expect(none.sql.some((s) => s.includes('INSERT INTO whatsapp_form_responses'))).toBe(true);
  });
});

describe('applyFormSaveTo', () => {
  beforeEach(() => {
    writes.calls = [];
    writes.result = true;
  });

  it('writes mapped answers through the contact field writer, choices as titles', async () => {
    const n = await applyFormSaveTo({} as DataClient, ACCOUNT, 'contact-1', definition, { full_name: '  Ana  ', plan: 'pro', topics: ['t1'] });
    expect(writes.calls).toEqual([['name', 'Ana'], [`custom:${CUSTOM}`, 'Pro plan']]);
    expect(n).toBe(2);
  });

  it('skips unanswered fields and counts only accepted writes', async () => {
    writes.result = false;
    expect(await applyFormSaveTo({} as DataClient, ACCOUNT, 'contact-1', definition, { plan: 'free' })).toBe(0);
    expect(writes.calls).toEqual([[`custom:${CUSTOM}`, 'Free']]);
  });
});
