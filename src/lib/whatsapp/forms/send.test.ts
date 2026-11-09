import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  steps: [] as string[],
  sql: [] as Array<{ sql: string; values: unknown[] }>,
  contexts: [] as Array<Record<string, unknown>>,
  rows: {} as Record<string, unknown[]>,
  sendFlow: vi.fn<(args: Record<string, unknown>) => Promise<{ whatsapp_message_id: string }>>(async () => ({ whatsapp_message_id: 'wamid.form' })),
  paused: false,
}));

vi.mock('@/lib/db/prisma', () => ({ getPrisma: () => 'app', getWorkerPrisma: () => 'worker' }));
vi.mock('@/lib/db/tenant', () => ({
  withTenant: async (context: Record<string, unknown>, operation: (tx: unknown) => Promise<unknown>, prisma: string) => {
    h.contexts.push({ ...context, prisma });
    const run = (strings: TemplateStringsArray, ...values: unknown[]) => {
      const sql = strings.join('?');
      h.sql.push({ sql, values });
      const key = Object.keys(h.rows).find((k) => sql.includes(k));
      return Promise.resolve(key ? h.rows[key] : []);
    };
    // getNumberConfig reads the workspace's numbers through the Prisma delegate.
    const numbers = () => (h.rows['FROM whatsapp_config'] ?? []) as Array<Record<string, unknown>>;
    const ordered = () => numbers().slice().sort((a, b) => Number(!!b.is_default) - Number(!!a.is_default));
    const whatsapp_config = {
      findFirst: async ({ where }: { where: { id?: string } }) => numbers().find((n) => !where.id || n.id === where.id) ?? null,
      findMany: async ({ take }: { take?: number }) => ordered().slice(0, take ?? undefined),
    };
    return operation({ whatsapp_config, $queryRaw: run, $executeRaw: async (s: TemplateStringsArray, ...v: unknown[]) => { await run(s, ...v); return 1; } });
  },
}));
vi.mock('@/lib/jobs/dispatch', () => ({
  dispatchOnce: async (_account: string, key: string, send: () => Promise<unknown>) => {
    h.steps.push(`intent:${key}`);
    return send();
  },
}));
vi.mock('@/lib/whatsapp/bot-pause', () => ({
  assertBotRepliesEnabled: async () => {
    if (h.paused) throw new Error('paused');
  },
}));
vi.mock('@/lib/whatsapp/encryption', () => ({ decrypt: (v: string) => `plain:${v}` }));
vi.mock('@/lib/whatsapp/meta-api', () => ({
  FLOW_CTA_MAX_LENGTH: 30,
  sendFlowMessage: (args: Record<string, unknown>) => {
    h.steps.push('meta');
    return h.sendFlow(args);
  },
}));

import { formMessageRefusal, formMessageText, formNodeSessionTtlHours, formSendRefusal, sendForm, templateFlowTokens, FormSendError } from './send';

const ACCOUNT = '11111111-1111-4111-8111-111111111111';
const FORM = '22222222-2222-4222-8222-222222222222';
const CONV = '33333333-3333-4333-8333-333333333333';
const definition = { version: 1, screens: [{ id: 'START', title: 'T', button_label: 'Go', fields: [{ id: 'q', type: 'short_text', label: 'Q' }] }] };
const now = Date.parse('2026-11-02T12:00:00Z');
const recent = new Date(now - 60 * 60 * 1000);

const published = { status: 'published', meta_flow_id: '1234567890' };
const contact = { phone: '+15551234567', wa_user_id: null, blocked_at: null };

describe('formSendRefusal', () => {
  it('allows a published form to a reachable contact inside the window', () => {
    expect(formSendRefusal({ form: published, contact, lastCustomerMessageAt: recent }, now)).toBeNull();
  });

  it.each([
    ['form_not_found', { form: null, contact, lastCustomerMessageAt: recent }],
    ['form_not_published', { form: { status: 'draft', meta_flow_id: '1' }, contact, lastCustomerMessageAt: recent }],
    ['form_not_published', { form: { status: 'published', meta_flow_id: null }, contact, lastCustomerMessageAt: recent }],
    ['conversation_not_found', { form: published, contact: null, lastCustomerMessageAt: recent }],
    ['contact_blocked', { form: published, contact: { ...contact, blocked_at: new Date() }, lastCustomerMessageAt: recent }],
    ['no_address', { form: published, contact: { phone: null, wa_user_id: null, blocked_at: null }, lastCustomerMessageAt: recent }],
    ['window_closed', { form: published, contact, lastCustomerMessageAt: new Date(now - 25 * 60 * 60 * 1000) }],
    ['window_closed', { form: published, contact, lastCustomerMessageAt: null }],
  ] as const)('refuses with %s', (code, state) => {
    expect(formSendRefusal(state, now)).toBe(code);
  });
});

describe('form message content', () => {
  it('checks the button, body, header and footer limits', () => {
    expect(formMessageRefusal({ cta: 'Open', body: 'Hi' })).toBeNull();
    expect(formMessageRefusal({ cta: '', body: 'Hi' })).toBe('invalid_message');
    expect(formMessageRefusal({ cta: 'x'.repeat(31), body: 'Hi' })).toBe('invalid_message');
    expect(formMessageRefusal({ cta: 'Open', body: ' ' })).toBe('invalid_message');
    expect(formMessageRefusal({ cta: 'Open', body: 'x'.repeat(1025) })).toBe('invalid_message');
    expect(formMessageRefusal({ cta: 'Open', body: 'Hi', footer: 'x'.repeat(61) })).toBe('invalid_message');
  });

  it('shows the text and the button label in the inbox', () => {
    expect(formMessageText({ cta: 'Open', body: 'Body', header: 'Head' })).toBe('Head\nBody\n[Open]');
  });
});

describe('sendForm', () => {
  beforeEach(() => {
    h.steps = [];
    h.sql = [];
    h.contexts = [];
    h.paused = false;
    h.sendFlow.mockClear();
    h.rows = {
      'FROM whatsapp_forms': [{ name: 'Lead', status: 'published', meta_flow_id: '1234567890', definition }],
      'FROM conversations c JOIN contacts': [{ contact_id: 'ct-1', last_customer_message_at: new Date(Date.now() - 60_000), ...contact }],
      'FROM whatsapp_config': [{ phone_number_id: 'pn-1', access_token: 'enc' }],
      'INSERT INTO whatsapp_form_sessions': [{ id: 'sess-1' }],
      'INSERT INTO messages': [{ id: 'msg-1' }],
    };
  });

  const args = { accountId: ACCOUNT, userId: '44444444-4444-4444-8444-444444444444', role: 'agent' as const, sender: 'agent' as const,
    conversationId: CONV, formId: FORM, cta: ' Open ', body: 'Please fill in', intentKey: 'form:inbox:x' };

  it('opens the screen id WhatsApp knows when the stored id has digits (SCREEN_1 -> SCREEN_ONE)', async () => {
    h.rows['FROM whatsapp_forms'] = [{ name: 'Lead', status: 'published', meta_flow_id: '1234567890',
      definition: { ...definition, screens: [{ ...definition.screens[0], id: 'SCREEN_1' }] } }];
    await sendForm(args);
    expect(h.sendFlow.mock.calls[0][0]).toMatchObject({ screen: 'SCREEN_ONE' });
  });

  it('retries once naming the flow when Meta refuses the flow id, and never for other errors', async () => {
    const refusal = Object.assign(new Error('(#131009) Parameter value is not valid'), { code: 131009, details: 'Parameter "flow_id" is invalid.' });
    h.sendFlow.mockRejectedValueOnce(refusal);
    await sendForm(args);
    expect(h.sendFlow.mock.calls.map((c) => c[0].flowName)).toEqual([undefined, 'Lead']);
    h.sendFlow.mockClear();
    h.sendFlow.mockRejectedValueOnce(Object.assign(new Error('(#131009) Parameter value is not valid'), { code: 131009, details: 'Parameter "to" is invalid.' }));
    await expect(sendForm({ ...args, intentKey: 'form:inbox:y' })).rejects.toThrow('131009');
    expect(h.sendFlow).toHaveBeenCalledTimes(1);
  });

  it('creates the session inside the intent, sends, then records the message idempotently', async () => {
    const result = await sendForm(args);
    expect(result).toEqual({ whatsappMessageId: 'wamid.form', messageId: 'msg-1' });
    expect(h.steps).toEqual(['intent:form:inbox:x', 'meta']);
    const sessionInsert = h.sql.findIndex((q) => q.sql.includes('INSERT INTO whatsapp_form_sessions'));
    const messageInsert = h.sql.findIndex((q) => q.sql.includes('INSERT INTO messages'));
    expect(sessionInsert).toBeGreaterThan(-1);
    expect(messageInsert).toBeGreaterThan(sessionInsert);
    expect(h.sql[messageInsert].sql).toContain('ON CONFLICT(conversation_id,message_id) DO NOTHING');
    const sent = h.sendFlow.mock.calls[0][0];
    const token = h.sql[sessionInsert].values[1];
    expect(sent).toMatchObject({ flowId: '1234567890', flowToken: token, screen: 'START', cta: 'Open', accessToken: 'plain:enc', to: '15551234567' });
    // The agent's own membership role and the app connection, never the worker's.
    expect(h.contexts.every((c) => c.role === 'agent' && c.prisma === 'app' && c.accountId === ACCOUNT)).toBe(true);
  });

  it('refuses an unpublished form before any intent, session or send', async () => {
    h.rows['FROM whatsapp_forms'] = [{ name: 'Lead', status: 'draft', meta_flow_id: null, definition }];
    await expect(sendForm(args)).rejects.toMatchObject({ code: 'form_not_published', status: 409 });
    expect(h.steps).toEqual([]);
    expect(h.sql.some((q) => q.sql.includes('whatsapp_form_sessions'))).toBe(false);
  });

  it('refuses outside the 24-hour window and for a blocked contact', async () => {
    h.rows['FROM conversations c JOIN contacts'] = [{ contact_id: 'ct-1', last_customer_message_at: new Date(Date.now() - 2 * 86_400_000), ...contact }];
    await expect(sendForm(args)).rejects.toBeInstanceOf(FormSendError);
    h.rows['FROM conversations c JOIN contacts'] = [{ contact_id: 'ct-1', last_customer_message_at: new Date(), ...contact, blocked_at: new Date() }];
    await expect(sendForm(args)).rejects.toMatchObject({ code: 'contact_blocked' });
    expect(h.sendFlow).not.toHaveBeenCalled();
  });

  it('refuses a conversation whose number is in another WABA than the form, before any intent or send (R3)', async () => {
    h.rows['FROM whatsapp_forms'] = [{ name: 'Lead', status: 'published', meta_flow_id: '1234567890', definition, uses_endpoint: false, waba_id: 'waba-1' }];
    h.rows['FROM whatsapp_config'] = [{ phone_number_id: 'pn-2', access_token: 'enc', waba_id: 'waba-2' }];
    await expect(sendForm(args)).rejects.toMatchObject({ code: 'form_wrong_number', status: 409 });
    expect(h.steps).toEqual([]);
    expect(h.sql.some((q) => q.sql.includes('whatsapp_form_sessions'))).toBe(false);
    // Same WABA, another number: sent from the conversation's number.
    h.rows['FROM whatsapp_config'] = [{ phone_number_id: 'pn-2', access_token: 'enc', waba_id: 'waba-1' }];
    await sendForm(args);
    expect(h.sendFlow.mock.calls[0][0]).toMatchObject({ phoneNumberId: 'pn-2', flowId: '1234567890' });
  });

  it('refuses an endpoint form when the conversation number has no forms key (R3)', async () => {
    h.rows['FROM whatsapp_forms'] = [{ name: 'Lead', status: 'published', meta_flow_id: '1234567890', definition, uses_endpoint: true, waba_id: 'waba-1' }];
    h.rows['FROM whatsapp_config'] = [{ phone_number_id: 'pn-2', access_token: 'enc', waba_id: 'waba-1',
      forms_private_key_enc: null, forms_key_uploaded_at: null }];
    await expect(sendForm(args)).rejects.toMatchObject({ code: 'form_key_missing', status: 409 });
    expect(h.steps).toEqual([]);
    h.rows['FROM whatsapp_config'] = [{ phone_number_id: 'pn-2', access_token: 'enc', waba_id: 'waba-1',
      forms_private_key_enc: 'enc-key', forms_key_uploaded_at: new Date() }];
    await expect(sendForm(args)).resolves.toMatchObject({ whatsappMessageId: 'wamid.form' });
  });

  it('refuses bad message text without touching the database', async () => {
    await expect(sendForm({ ...args, cta: '' })).rejects.toMatchObject({ code: 'invalid_message' });
    expect(h.sql).toHaveLength(0);
  });

  const sessionExpiryHours = () => {
    const insert = h.sql.find((q) => q.sql.includes('INSERT INTO whatsapp_form_sessions'))!;
    return ((insert.values[7] as Date).getTime() - Date.now()) / 3_600_000;
  };

  it('keeps an inbox form session for the default 72 hours without reading any flow', async () => {
    await sendForm(args);
    expect(Math.round(sessionExpiryHours())).toBe(72);
    expect(h.sql.some((q) => q.sql.includes('FROM flow_runs'))).toBe(false);
  });

  it('keeps a send_form node session alive for the whole 7-day wait (R4)', async () => {
    h.rows['FROM flow_runs'] = [{ config: { timeout_minutes: 10_080, after_timeout: 'n2' }, fallback_policy: { on_timeout_hours: 168 } }];
    await sendForm({ ...args, sender: 'bot', role: 'owner', flowRunId: '55555555-5555-4555-8555-555555555555', nodeKey: 'form1' });
    const lookup = h.sql.find((q) => q.sql.includes('FROM flow_runs'))!;
    expect(lookup.values).toEqual(expect.arrayContaining(['form1', ACCOUNT, '55555555-5555-4555-8555-555555555555']));
    // A submission on day 4 (96h) still finds a live session, so it is trusted and resumes the run.
    expect(sessionExpiryHours()).toBeGreaterThan(168);
    expect(sessionExpiryHours()).toBeLessThanOrEqual(170);
  });

  it('runs flow sends on the worker connection and stops when an agent paused the bot', async () => {
    h.paused = true;
    await expect(sendForm({ ...args, sender: 'bot', role: 'owner' })).rejects.toThrow('paused');
    expect(h.sendFlow).not.toHaveBeenCalled();
    expect(h.contexts.every((c) => c.prisma === 'worker')).toBe(true);
  });
});

describe('templateFlowTokens', () => {
  beforeEach(() => {
    h.sql = [];
    h.rows = { 'FROM whatsapp_forms': [{ id: FORM }], 'INSERT INTO whatsapp_form_sessions': [{ id: 'sess-1' }] };
  });

  it('creates one session per FLOW button, keyed by button index', async () => {
    const tokens = await templateFlowTokens({ accountId: ACCOUNT, contactId: 'ct', conversationId: CONV,
      buttons: [{ type: 'QUICK_REPLY' }, { type: 'FLOW', flow_id: '987' }] });
    expect(Object.keys(tokens ?? {})).toEqual(['1']);
    expect(h.sql.filter((q) => q.sql.includes('INSERT INTO whatsapp_form_sessions'))).toHaveLength(1);
  });

  it('does nothing for a template without FLOW buttons', async () => {
    expect(await templateFlowTokens({ accountId: ACCOUNT, contactId: null, conversationId: null, buttons: [{ type: 'URL' }] })).toBeUndefined();
    expect(h.sql).toHaveLength(0);
  });

  it('gives no token when no form of this account has the flow id', async () => {
    h.rows = {};
    expect(await templateFlowTokens({ accountId: ACCOUNT, contactId: null, conversationId: null, buttons: [{ type: 'FLOW', flow_id: '1' }] })).toBeUndefined();
  });
});

describe('formNodeSessionTtlHours', () => {
  it('covers the node timeout and the run timeout, never less than 72h nor more than 30 days', () => {
    expect(formNodeSessionTtlHours({}, null)).toBe(72);
    expect(formNodeSessionTtlHours({ timeout_minutes: 10_080 }, { on_timeout_hours: 24 })).toBe(169);
    expect(formNodeSessionTtlHours({}, { on_timeout_hours: 240 })).toBe(241);
    expect(formNodeSessionTtlHours({ timeout_minutes: 30 }, { on_timeout_hours: 2000 })).toBe(720);
    // An out-of-range timeout is ignored like the engine ignores it.
    expect(formNodeSessionTtlHours({ timeout_minutes: 99_999 }, null)).toBe(72);
  });
});

describe('templateFlowTokens with an intent key (R9)', () => {
  const call = () => templateFlowTokens({ accountId: ACCOUNT, contactId: 'ct', conversationId: null,
    buttons: [{ type: 'QUICK_REPLY' }, { type: 'FLOW', flow_id: '987' }], intentKey: 'broadcast:b:r:form-sessions' });

  beforeEach(() => {
    h.sql = [];
    h.contexts = [];
  });

  it('creates the sessions and records their tokens on the intent in the same transaction', async () => {
    h.rows = { 'INSERT INTO outbound_intents': [{ id: 'intent-1' }], 'FROM whatsapp_forms': [{ id: FORM }],
      'INSERT INTO whatsapp_form_sessions': [{ id: 'sess-1' }] };
    const tokens = await call();
    expect(Object.keys(tokens ?? {})).toEqual(['1']);
    const claim = h.sql.find((q) => q.sql.includes('INSERT INTO outbound_intents'))!;
    expect(claim.sql).toContain('ON CONFLICT(idempotency_key) DO NOTHING');
    expect(claim.values).toContain(`${ACCOUNT}:broadcast:b:r:form-sessions`);
    const record = h.sql.find((q) => q.sql.includes('UPDATE outbound_intents'))!;
    expect(JSON.parse(record.values[0] as string)).toEqual(tokens);
    // One transaction, as the owner on the worker connection.
    expect(h.contexts).toEqual([{ accountId: ACCOUNT, role: 'owner', prisma: 'worker' }]);
  });

  it('returns the recorded tokens on a retry and creates no new session', async () => {
    h.rows = { 'INSERT INTO outbound_intents': [], 'SELECT result FROM outbound_intents': [{ result: { 1: 'tok-earlier' } }] };
    expect(await call()).toEqual({ 1: 'tok-earlier' });
    expect(h.sql.some((q) => q.sql.includes('whatsapp_form_sessions'))).toBe(false);
  });

  it('returns no token on a retry when the first call found no form', async () => {
    h.rows = { 'INSERT INTO outbound_intents': [], 'SELECT result FROM outbound_intents': [{ result: {} }] };
    expect(await call()).toBeUndefined();
  });
});

describe('sendForm — two numbers in one workspace', () => {
  const DEFAULT_NUMBER = '55555555-5555-4555-8555-555555555555';
  const SECOND_NUMBER = '66666666-6666-4666-8666-666666666666';
  const args = { accountId: ACCOUNT, userId: '44444444-4444-4444-8444-444444444444', role: 'agent' as const, sender: 'agent' as const,
    conversationId: CONV, formId: FORM, cta: 'Open', body: 'Please fill in', intentKey: 'form:inbox:two' };
  const rows = (conversationNumber: string | null) => ({
    'FROM whatsapp_forms': [{ name: 'Lead', status: 'published', meta_flow_id: '1234567890', definition }],
    'FROM conversations c JOIN contacts': [{ contact_id: 'ct-1', last_customer_message_at: new Date(Date.now() - 60_000), ...contact, whatsapp_config_id: conversationNumber }],
    'FROM whatsapp_config': [
      { id: SECOND_NUMBER, phone_number_id: 'pn-second', access_token: 'enc-2', is_default: false },
      { id: DEFAULT_NUMBER, phone_number_id: 'pn-default', access_token: 'enc-1', is_default: true },
    ],
    'INSERT INTO whatsapp_form_sessions': [{ id: 'sess-1' }],
    'INSERT INTO messages': [{ id: 'msg-1' }],
  });
  beforeEach(() => { h.steps = []; h.sql = []; h.contexts = []; h.paused = false; h.sendFlow.mockClear(); });

  it("sends from the conversation's number", async () => {
    h.rows = rows(SECOND_NUMBER);
    await sendForm(args);
    expect(h.sendFlow.mock.calls[0][0]).toMatchObject({ phoneNumberId: 'pn-second', accessToken: 'plain:enc-2' });
  });

  it('uses the default number for a legacy conversation without one', async () => {
    h.rows = rows(null);
    await sendForm(args);
    expect(h.sendFlow.mock.calls[0][0]).toMatchObject({ phoneNumberId: 'pn-default', accessToken: 'plain:enc-1' });
  });
});
