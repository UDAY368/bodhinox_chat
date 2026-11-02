import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DataClient } from '@/lib/data/types';
import type { MessageTemplate } from '@/types';

const mocks = vi.hoisted(() => ({
  send: vi.fn(),
  tokens: vi.fn(async (args: Record<string, unknown>) => (void args, { 1: 'tok-recipient' }) as Record<number, string> | undefined),
  intents: [] as string[],
}));
vi.mock('./meta-api', async (original) => ({ ...(await original<typeof import('./meta-api')>()), sendTemplateMessage: mocks.send }));
vi.mock('@/lib/storage/server', () => ({ providerMediaUrl: async (_a: string, url: string) => url }));
vi.mock('@/lib/whatsapp/forms/send', () => ({ templateFlowTokens: mocks.tokens }));
vi.mock('@/lib/jobs/dispatch', () => ({
  dispatchOnce: async (_account: string, key: string, send: () => unknown) => {
    mocks.intents.push(key);
    return send();
  },
  UncertainDispatchError: class extends Error {},
}));
import { deliverBroadcast } from './broadcast-core';

const chain = {
  update: () => chain, select: () => chain, eq: () => chain, neq: () => chain,
  then: (resolve: (value: unknown) => unknown) => Promise.resolve({ error: null, count: 0, data: [] }).then(resolve),
};
const db = { from: () => chain } as unknown as DataClient;
const formTemplate = {
  name: 'signup', language: 'en', body_text: 'Hi', header_type: null,
  buttons: [{ type: 'QUICK_REPLY', text: 'No' }, { type: 'FLOW', text: 'Open', flow_id: '9876' }],
} as unknown as MessageTemplate;
const plan = (templateRow: MessageTemplate | null) => ({
  broadcastId: 'b-1', templateName: 'signup', templateLanguage: 'en', phoneNumberId: 'pn', accessToken: 'x', templateRow, rejected: 0,
  planned: [
    { recipientRowId: 'r-1', phone: '5511987654321', params: [], contactId: 'c-1' },
    { recipientRowId: 'r-2', phone: '14155550123', params: [], contactId: 'c-2' },
  ],
});
const options = { accountId: 'acct', assertLease: () => {}, attemptId: 'job', retryRejected: true };

describe('broadcast of a template with a FLOW button (R9)', () => {
  beforeEach(() => {
    mocks.intents = [];
    mocks.tokens.mockClear();
    mocks.send.mockReset();
  });

  it('issues each recipient their own form session once, before the send intent, and sends its token', async () => {
    // The Brazilian number's first variant is "not in allowed list", so a second variant is tried.
    mocks.send.mockRejectedValueOnce(new Error('(#131030) Recipient phone number not in allowed list'))
      .mockResolvedValue({ messageId: 'wamid' });
    await deliverBroadcast(db, plan(formTemplate), options);

    // One call per recipient, keyed by the recipient (not the variant), with its contact.
    expect(mocks.tokens).toHaveBeenCalledTimes(2);
    expect(mocks.tokens.mock.calls.map(([a]) => [a.intentKey, a.contactId, a.accountId])).toEqual([
      ['broadcast:b-1:r-1:form-sessions', 'c-1', 'acct'],
      ['broadcast:b-1:r-2:form-sessions', 'c-2', 'acct'],
    ]);
    // Every send of the recipient, both variants included, carries the token for button 1.
    expect(mocks.send).toHaveBeenCalledTimes(3);
    for (const [call] of mocks.send.mock.calls) {
      expect(call).toMatchObject({ messageParams: { flowTokens: { 1: 'tok-recipient' } } });
    }
    expect(mocks.intents.every((k) => k.startsWith('broadcast:b-1:r-'))).toBe(true);
  });

  it('marks the recipient failed without sending when its session cannot be issued', async () => {
    mocks.tokens.mockRejectedValueOnce(new Error('db down'));
    mocks.send.mockResolvedValue({ messageId: 'wamid' });
    const result = await deliverBroadcast(db, { ...plan(formTemplate), planned: plan(formTemplate).planned.slice(0, 1) }, options);
    expect(result).toEqual({ throttled: false, sent: 0 });
    expect(mocks.send).not.toHaveBeenCalled();
    expect(mocks.intents).toEqual([]);
  });

  it('issues no session for a template without a FLOW button', async () => {
    mocks.send.mockResolvedValue({ messageId: 'wamid' });
    await deliverBroadcast(db, plan({ ...formTemplate, buttons: [{ type: 'URL', text: 'x', url: 'https://e.x' }] } as unknown as MessageTemplate), options);
    expect(mocks.tokens).not.toHaveBeenCalled();
    expect(mocks.send.mock.calls[0][0]).not.toHaveProperty('messageParams');
  });
});
