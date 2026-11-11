// Stage 5 (5G) public API helpers: Idempotency-Key parsing, flow start
// checks, custom fields by key and the conversation send's idempotency and
// Instagram window refusals. The database paths are covered by
// stage5-api.integration.test.ts.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  intents: new Map<string, unknown>(),
  sendInstagramText: vi.fn(),
  loadInstagramTarget: vi.fn(),
  checkInstagramText: vi.fn(),
  sendMessageToConversation: vi.fn(),
  allowed: vi.fn(async () => true),
}));

vi.mock('@/lib/jobs/dispatch', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/jobs/dispatch')>();
  return {
    ...actual,
    // An in-memory outbound intent: the first call runs the work and stores its result; later calls replay it.
    dispatchOnce: vi.fn(async (_a: string, key: string, work: () => Promise<unknown>) => {
      if (mocks.intents.has(key)) return mocks.intents.get(key);
      const result = await work();
      mocks.intents.set(key, result);
      return result;
    }),
  };
});
vi.mock('@/lib/db/tenant', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/db/tenant')>()),
  withTenant: vi.fn(async (_c: unknown, work: (tx: unknown) => Promise<unknown>) => work({
    $queryRaw: vi.fn(async () => [{ id: '99999999-9999-4999-8999-999999999999' }]), $executeRaw: vi.fn(async () => 1),
  })),
}));
vi.mock('@/lib/db/prisma', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/db/prisma')>()), getWorkerPrisma: vi.fn(() => ({})),
}));
vi.mock('@/lib/channels/sender', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/channels/sender')>()),
  sendInstagramText: mocks.sendInstagramText, loadInstagramTarget: mocks.loadInstagramTarget, checkInstagramText: mocks.checkInstagramText,
}));
vi.mock('@/lib/whatsapp/send-message', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/whatsapp/send-message')>()), sendMessageToConversation: mocks.sendMessageToConversation,
}));
vi.mock('@/lib/contacts/channel-consent', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/contacts/channel-consent')>()), instagramAutomationAllowed: mocks.allowed,
}));

import type { DataClient } from '@/lib/data/types';
import { InstagramError } from '@/lib/instagram/errors';
import { SendMessageError } from '@/lib/whatsapp/send-message';
import { apiText, sendApiConversationText } from './conversation-send';
import { CustomFieldInputError, parseCustomFieldPatch, resolveFieldKey } from './custom-fields';
import { idempotencyKeyOf, prepareStartFlow, scopeChannels } from './start-flow';

const A = '11111111-1111-4111-8111-111111111111';
const CONV = '66666666-6666-4666-8666-666666666666';
const CONTACT = '55555555-5555-4555-8555-555555555555';
const FLOW = '33333333-3333-4333-8333-333333333333';

/** A tiny DataClient double: each table answers fixed rows to any filter chain. */
function fakeDb(tables: Record<string, unknown>): DataClient {
  const chain = (table: string): unknown => {
    const result = { data: tables[table] ?? null, error: null };
    const self: Record<string, unknown> = {};
    for (const m of ['select', 'eq', 'order', 'limit', 'in']) self[m] = () => self;
    self.maybeSingle = async () => ({ data: Array.isArray(result.data) ? result.data[0] ?? null : result.data, error: null });
    self.then = (resolve: (v: unknown) => unknown) => resolve(result);
    return self;
  };
  return { from: (t: string) => chain(t) } as unknown as DataClient;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.intents.clear();
  mocks.allowed.mockResolvedValue(true);
});

describe('Idempotency-Key and flow start', () => {
  const req = (value?: string) => new Request('https://x.test', { headers: value === undefined ? {} : { 'idempotency-key': value } });
  it('accepts 1-200 printable characters', () => {
    expect(idempotencyKeyOf(req())).toBeNull();
    expect(idempotencyKeyOf(req(' order-42 '))).toBe('order-42');
    expect(idempotencyKeyOf(req('x'.repeat(201)))).toBe('invalid');
    expect(idempotencyKeyOf(req('two words'))).toBe('invalid');
  });
  it('maps channel scopes', () => {
    expect(scopeChannels('instagram')).toEqual(['instagram']);
    expect(scopeChannels('any')).toEqual(['whatsapp', 'instagram']);
    expect(scopeChannels(null)).toEqual(['whatsapp']);
  });
  it('refuses unknown contacts and flows, inactive flows and contacts without a matching conversation', async () => {
    const base = { contacts: { id: CONTACT }, flows: { id: FLOW, status: 'active', channel_scope: 'instagram' },
      conversations: [{ id: CONV, channel: 'whatsapp' }] };
    expect(await prepareStartFlow(fakeDb({ ...base, contacts: null }), A, CONTACT, FLOW)).toEqual({ ok: false, reason: 'contact_not_found' });
    expect(await prepareStartFlow(fakeDb({ ...base, flows: null }), A, CONTACT, FLOW)).toEqual({ ok: false, reason: 'flow_not_found' });
    expect(await prepareStartFlow(fakeDb({ ...base, flows: { ...base.flows, status: 'draft' } }), A, CONTACT, FLOW)).toEqual({ ok: false, reason: 'flow_not_active' });
    expect(await prepareStartFlow(fakeDb(base), A, CONTACT, FLOW)).toEqual({ ok: false, reason: 'no_conversation' });
    expect(await prepareStartFlow(fakeDb({ ...base, conversations: [{ id: CONV, channel: 'instagram' }] }), A, CONTACT, FLOW))
      .toEqual({ ok: true, conversationId: CONV, channel: 'instagram' });
    expect(await prepareStartFlow(fakeDb(base), A, 'not-a-uuid', FLOW)).toEqual({ ok: false, reason: 'contact_not_found' });
  });
});

describe('custom fields by key', () => {
  const fields = [{ id: '0f8fad5b-d9cb-469f-a165-70867728950e', field_name: 'City' }, { id: '1f8fad5b-d9cb-469f-a165-70867728950e', field_name: 'Plan' },
    { id: '2f8fad5b-d9cb-469f-a165-70867728950e', field_name: 'plan ' }];
  it('resolves by name (trimmed, any case) or id, and flags shared names', () => {
    expect(resolveFieldKey('city', fields)).toBe(fields[0]);
    expect(resolveFieldKey(fields[1].id.toUpperCase(), fields)).toBe(fields[1]);
    expect(resolveFieldKey('Plan', fields)).toBe('ambiguous');
    expect(resolveFieldKey('Missing', fields)).toBeNull();
  });
  it('refuses unknown or ambiguous keys and bad values before anything is written', () => {
    expect([...parseCustomFieldPatch({ City: 'Pune', [fields[1].id]: null }, fields)]).toEqual([[fields[0].id, 'Pune'], [fields[1].id, null]]);
    for (const bad of [{ Nope: 'x' }, { Plan: 'x' }, { City: 5 }, { City: 'x'.repeat(1001) }, [], 'x'])
      expect(() => parseCustomFieldPatch(bad, fields)).toThrow(CustomFieldInputError);
  });
});

describe('conversation send', () => {
  const target = { accountId: A, conversationId: CONV, contactId: CONTACT };
  const send = (db: DataClient, text: string, key: string | null = 'k1') =>
    sendApiConversationText({ db, accountId: A, keyId: 'key-1', conversationId: CONV, text, idempotencyKey: key });
  const instagram = fakeDb({ conversations: { id: CONV, channel: 'instagram', contact_id: CONTACT } });

  it('validates the text', () => {
    expect(apiText('  hi ')).toBe('hi');
    expect(apiText('')).toBeNull();
    expect(apiText('x'.repeat(4097))).toBeNull();
    expect(apiText(5)).toBeNull();
  });

  it('a repeated Idempotency-Key sends once and returns the same message; another text with it is refused', async () => {
    mocks.loadInstagramTarget.mockResolvedValue(target);
    mocks.sendInstagramText.mockResolvedValue({ messageId: 'mid.1' });
    const first = await send(instagram, 'Hello');
    const again = await send(instagram, 'Hello');
    expect(first).toMatchObject({ ok: true, replayed: false, sent: { provider_message_id: 'mid.1', channel: 'instagram' } });
    expect(again).toMatchObject({ ok: true, replayed: true, sent: first.ok ? first.sent : {} });
    expect(mocks.sendInstagramText).toHaveBeenCalledTimes(1);
    expect(await send(instagram, 'Different')).toMatchObject({ ok: false, code: 'idempotency_mismatch', status: 409 });
    expect(mocks.sendInstagramText).toHaveBeenCalledTimes(1);
  });

  it('an Instagram conversation outside the window is 409 window_closed and nothing is stored or sent', async () => {
    mocks.loadInstagramTarget.mockResolvedValue(target);
    mocks.checkInstagramText.mockImplementationOnce(() => { throw new InstagramError('instagram_window_closed'); });
    expect(await send(instagram, 'Hello')).toMatchObject({ ok: false, code: 'window_closed', status: 409 });
    expect(mocks.intents.size).toBe(0);
    expect(mocks.sendInstagramText).not.toHaveBeenCalled();
    // The check runs as an automated sender (24 hours), never the human-agent window.
    expect(mocks.checkInstagramText.mock.calls[0][2]).toMatchObject({ sender: 'automated' });
  });

  it('a contact unsubscribed from Instagram automation is refused', async () => {
    mocks.allowed.mockResolvedValueOnce(false);
    expect(await send(instagram, 'Hello')).toMatchObject({ ok: false, code: 'instagram_opted_out' });
    expect(mocks.loadInstagramTarget).not.toHaveBeenCalled();
  });

  it('WhatsApp uses the existing send core; a refusal before Meta is the stored outcome', async () => {
    const whatsapp = fakeDb({ conversations: { id: CONV, channel: 'whatsapp', contact_id: CONTACT } });
    mocks.sendMessageToConversation.mockRejectedValueOnce(new SendMessageError('window_closed', 'closed', 409));
    expect(await send(whatsapp, 'Hi', 'w1')).toMatchObject({ ok: false, code: 'window_closed', status: 409 });
    mocks.sendMessageToConversation.mockResolvedValueOnce({ messageId: 'row', whatsappMessageId: 'wamid.1' });
    expect(await send(whatsapp, 'Hi', 'w2')).toMatchObject({ ok: true, sent: { message_id: 'row', provider_message_id: 'wamid.1', channel: 'whatsapp' } });
    expect(mocks.sendMessageToConversation).toHaveBeenCalledWith(whatsapp, A, { conversationId: CONV, messageType: 'text', contentText: 'Hi' });
  });

  it('an unknown conversation is 404', async () => {
    expect(await send(fakeDb({ conversations: null }), 'Hi')).toMatchObject({ ok: false, code: 'not_found', status: 404 });
  });
});
