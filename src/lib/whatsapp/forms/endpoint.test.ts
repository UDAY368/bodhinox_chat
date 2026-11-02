import { beforeEach, describe, expect, it } from 'vitest';

import { validateFormDefinition } from './definition';
import { compileFlowJson } from './flow-json';
import { handleFormsExchange, validateScreenAnswers, type FormAnswers, type FormsSession, type FormsSessionStore } from './endpoint';
import type { FormDefinition } from './types';

const TOKEN = 'A'.repeat(43);
const definition: FormDefinition = {
  version: 1,
  screens: [
    {
      id: 'ABOUT', title: 'About you', button_label: 'Next', fields: [
        { id: 'intro', type: 'heading', label: 'Welcome' },
        { id: 'name', type: 'short_text', label: 'Name', required: true, min: 2 },
        { id: 'email', type: 'email', label: 'Email', required: true },
        { id: 'phone', type: 'phone', label: 'Phone' },
        { id: 'seats', type: 'number', label: 'Seats' },
      ],
    },
    {
      id: 'PLAN', title: 'Your plan', button_label: 'Send', fields: [
        { id: 'plan', type: 'radio', label: 'Plan', required: true, options: [{ id: 'basic', title: 'Basic' }, { id: 'pro', title: 'Pro' }] },
        { id: 'topics', type: 'checkboxes', label: 'Topics', min: 1, max: 2, options: [{ id: 'a', title: 'A' }, { id: 'b', title: 'B' }, { id: 'c', title: 'C' }] },
        { id: 'start', type: 'date', label: 'Start date' },
        { id: 'agree', type: 'opt_in', label: 'I agree to be contacted', required: true },
      ],
    },
  ],
};

class MemoryStore implements FormsSessionStore {
  session: FormsSession = { id: 's-1', definition, answers: {}, expired: false, completed: false };
  async find(token: string) { return token === TOKEN ? { ...this.session, answers: { ...this.session.answers } } : null; }
  async saveAnswers(_id: string, values: FormAnswers) { this.session.answers = { ...this.session.answers, ...values }; }
  async complete(_id: string, values: FormAnswers) {
    if (this.session.completed) return null;
    this.session.answers = { ...this.session.answers, ...values };
    this.session.completed = true;
    return this.session.answers;
  }
}

let store: MemoryStore;
const call = (request: Record<string, unknown>) => handleFormsExchange({ version: '3.0', flow_token: TOKEN, ...request }, store);
const about = { name: 'Ana', email: 'ana@example.com', phone: '+1 415 555 0100', seats: '3' };
const plan = { plan: 'pro', topics: ['a', 'b'], start: '2026-12-01', agree: true };

beforeEach(() => { store = new MemoryStore(); });

describe('forms data endpoint', () => {
  it('fixture is a valid definition whose endpoint Flow JSON uses the same screen ids', () => {
    expect(validateFormDefinition(definition).ok).toBe(true);
    const json = compileFlowJson(definition, { usesEndpoint: true });
    expect(json.routing_model).toEqual({ ABOUT: ['PLAN'], PLAN: [] });
  });

  it('answers a health check ping without a token', async () => {
    expect(await handleFormsExchange({ version: '3.0', action: 'ping' }, store)).toEqual({ status: 200, body: { data: { status: 'active' } } });
  });

  it('acknowledges error notifications', async () => {
    expect(await call({ action: 'data_exchange', data: { error: 'INVALID_SCREEN', error_message: 'x' } }))
      .toEqual({ status: 200, body: { data: { acknowledged: true } } });
  });

  it('INIT opens the first screen; BACK returns to the previous one', async () => {
    expect(await call({ action: 'INIT' })).toEqual({ status: 200, body: { screen: 'ABOUT', data: {} } });
    expect(await call({ action: 'BACK', screen: 'PLAN' })).toEqual({ status: 200, body: { screen: 'ABOUT', data: {} } });
    expect(await call({ action: 'BACK', screen: 'ABOUT' })).toEqual({ status: 200, body: { screen: 'ABOUT', data: {} } });
  });

  it('keeps each screen, then completes with every answer and the token', async () => {
    expect(await call({ action: 'data_exchange', screen: 'ABOUT', data: { ...about, injected: 'x' } }))
      .toEqual({ status: 200, body: { screen: 'PLAN', data: {} } });
    expect(store.session.answers).toEqual({ name: 'Ana', email: 'ana@example.com', phone: '+1 415 555 0100', seats: '3' });
    const done = await call({ action: 'data_exchange', screen: 'PLAN', data: plan });
    expect(done).toEqual({
      status: 200,
      body: { screen: 'SUCCESS', data: { extension_message_response: { params: { flow_token: TOKEN, ...about, ...plan } } } },
    });
    expect(store.session.completed).toBe(true);
    // The form cannot be reopened once complete.
    expect(await call({ action: 'INIT' })).toEqual({ status: 427 });
    expect(await call({ action: 'BACK', screen: 'PLAN' })).toEqual({ status: 427 });
    expect(await call({ action: 'data_exchange', screen: 'ABOUT', data: about })).toEqual({ status: 427 });
  });

  it('replays SUCCESS when the final submission is retried after completing, without completing twice', async () => {
    await call({ action: 'data_exchange', screen: 'ABOUT', data: about });
    const first = await call({ action: 'data_exchange', screen: 'PLAN', data: plan });
    let completes = 0;
    const complete = store.complete.bind(store);
    store.complete = async (id, values) => { completes += 1; return complete(id, values); };
    // The SUCCESS response was lost; WhatsApp resends the same request.
    expect(await call({ action: 'data_exchange', screen: 'PLAN', data: plan })).toEqual(first);
    expect(completes).toBe(0);
    // A retry is still validated, and an expired session is still refused.
    expect(await call({ action: 'data_exchange', screen: 'PLAN', data: { ...plan, plan: 'gold' } }))
      .toMatchObject({ status: 200, body: { screen: 'PLAN', data: { error_message: expect.any(String) } } });
    store.session.expired = true;
    expect(await call({ action: 'data_exchange', screen: 'PLAN', data: plan })).toEqual({ status: 427 });
  });

  it('replays SUCCESS when a concurrent duplicate completed the session first', async () => {
    await call({ action: 'data_exchange', screen: 'ABOUT', data: about });
    // This request reads an open session; a duplicate wins complete() in between.
    const open = await store.find(TOKEN);
    let reads = 0;
    const find = store.find.bind(store);
    store.find = async (token) => (reads++ === 0 ? open : find(token));
    await store.complete('s-1', plan);
    expect(await call({ action: 'data_exchange', screen: 'PLAN', data: plan })).toEqual({
      status: 200,
      body: { screen: 'SUCCESS', data: { extension_message_response: { params: { flow_token: TOKEN, ...about, ...plan } } } },
    });
    expect(reads).toBe(2);
  });

  it('returns the same screen with an error message and stores nothing when an answer is invalid', async () => {
    const res = await call({ action: 'data_exchange', screen: 'ABOUT', data: { ...about, email: 'not-an-email' } });
    expect(res).toMatchObject({ status: 200, body: { screen: 'ABOUT', data: { error_message: expect.any(String) } } });
    expect(store.session.answers).toEqual({});
  });

  it('will not complete when an earlier screen was skipped', async () => {
    const res = await call({ action: 'data_exchange', screen: 'PLAN', data: plan });
    expect(res).toMatchObject({ status: 200, body: { screen: 'ABOUT', data: { error_message: expect.any(String) } } });
    expect(store.session.completed).toBe(false);
  });

  it('refuses unknown, malformed, expired and completed tokens with 427', async () => {
    expect(await handleFormsExchange({ action: 'INIT', flow_token: 'B'.repeat(43) }, store)).toEqual({ status: 427 });
    expect(await handleFormsExchange({ action: 'INIT', flow_token: 'short' }, store)).toEqual({ status: 427 });
    expect(await handleFormsExchange({ action: 'INIT' }, store)).toEqual({ status: 427 });
    store.session.expired = true;
    expect(await call({ action: 'INIT' })).toEqual({ status: 427 });
    store.session.expired = false;
    store.session.completed = true;
    expect(await call({ action: 'INIT' })).toEqual({ status: 427 });
  });

  it('a stored definition with a field named error no longer validates, so it cannot be mistaken for an error notice', () => {
    const [first, second] = definition.screens;
    const withErrorField = { ...definition, screens: [{ ...first, fields: [...first.fields, { id: 'error', type: 'short_text' as const, label: 'Error' }] }, second] };
    expect(validateFormDefinition(withErrorField).ok).toBe(false);
  });

  it('rejects an unknown action or screen', async () => {
    expect(await call({ action: 'navigate' })).toEqual({ status: 400 });
    expect(await call({ action: 'data_exchange', screen: 'NOPE', data: {} })).toEqual({ status: 400 });
  });
});

describe('validateScreenAnswers', () => {
  const [aboutScreen, planScreen] = definition.screens;
  const err = (screen = aboutScreen, data: Record<string, unknown>) => {
    const r = validateScreenAnswers(screen, data);
    return r.ok ? null : r.fieldId;
  };

  it('checks required fields, lengths and formats', () => {
    expect(err(aboutScreen, { ...about, name: '  ' })).toBe('name');
    expect(err(aboutScreen, { ...about, name: 'A' })).toBe('name');
    expect(err(aboutScreen, { ...about, name: 'x'.repeat(81) })).toBe('name');
    expect(err(aboutScreen, { ...about, phone: '12' })).toBe('phone');
    expect(err(aboutScreen, { ...about, phone: 'call me' })).toBe('phone');
    expect(err(aboutScreen, { ...about, seats: 'three' })).toBe('seats');
    expect(err(aboutScreen, { ...about, name: { nested: true } })).toBe('name');
    expect(validateScreenAnswers(aboutScreen, { name: 'Ana', email: 'ana@example.com', phone: '' })).toEqual({ ok: true, values: { name: 'Ana', email: 'ana@example.com' } });
  });

  it('checks options, selection counts, dates and opt-in', () => {
    expect(err(planScreen, { ...plan, plan: 'gold' })).toBe('plan');
    expect(err(planScreen, { ...plan, topics: ['a', 'z'] })).toBe('topics');
    expect(err(planScreen, { ...plan, topics: ['a', 'b', 'c'] })).toBe('topics');
    expect(err(planScreen, { ...plan, topics: 'a' })).toBe('topics');
    expect(err(planScreen, { ...plan, start: '2026-02-30' })).toBe('start');
    expect(err(planScreen, { ...plan, agree: false })).toBe('agree');
    expect(err(planScreen, { ...plan, start: '1764547200000' })).toBeNull();
    expect(validateScreenAnswers(planScreen, { plan: 'basic', topics: ['a', 'a'], agree: 'true' }))
      .toEqual({ ok: true, values: { plan: 'basic', topics: ['a'], agree: true } });
  });
});
