// Stage 3 (3D): a flow's payment-link message. On Instagram it goes out as a
// card (the message with a "Pay now" URL button); when it cannot be a card it
// goes as the plain text; on WhatsApp it is exactly the text it always was.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  channel: 'instagram',
  dispatch: vi.fn(async (_account: string, _key: string, send: () => Promise<unknown>) => send()),
  waText: vi.fn(async (args: Record<string, unknown>) => (void args, { whatsapp_message_id: 'wamid.1' })),
  igText: vi.fn(async () => ({ messageId: 'mid.text', recipientId: '9001' })),
  igButtons: vi.fn(async () => ({ messageId: 'mid.card', recipientId: '9001' })),
  store: vi.fn(async (tx: unknown, row: Record<string, unknown>) => (void tx, void row, 'msg-1')),
}));

vi.mock('./admin-client', () => ({
  databaseAdmin: () => ({
    from: () => ({ select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { channel: h.channel }, error: null }) }) }) }) }),
  }),
}));
vi.mock('@/lib/jobs/dispatch', () => ({ dispatchOnce: h.dispatch }));
vi.mock('@/lib/whatsapp/bot-pause', () => ({ assertBotRepliesEnabled: async () => {} }));
vi.mock('@/lib/storage/server', () => ({ providerMediaUrl: async (_a: string, link: string) => link }));
vi.mock('@/lib/db/prisma', () => ({ getWorkerPrisma: () => ({}) }));
vi.mock('@/lib/db/tenant', () => ({
  withTenant: async (_c: unknown, work: (tx: unknown) => unknown) => work({ $executeRaw: async () => 1 }),
}));
vi.mock('./meta-send', () => ({
  engineSendText: h.waText, engineSendMedia: vi.fn(), engineSendInteractiveButtons: vi.fn(), engineSendInteractiveList: vi.fn(),
}));
vi.mock('@/lib/channels/sender', async (original) => ({
  ...(await original<typeof import('@/lib/channels/sender')>()),
  loadInstagramTarget: async () => ({ igUserId: '1', igsid: '2', accessTokenEnc: 'x', lastCustomerAt: new Date() }),
  checkInstagramText: () => ({ humanAgentTag: false }),
  checkInstagramButtonTemplate: () => ({ humanAgentTag: false }),
  sendInstagramText: h.igText,
  sendInstagramButtonTemplate: h.igButtons,
  storeInstagramSentMessage: h.store,
}));

import { flowSend } from './channel-send';

let run = { account_id: 'a1', conversation_id: 'c1' };
const base = { accountId: 'a1', userId: 'u1', conversationId: 'c1', contactId: 'ct1' };
const URL = 'https://rzp.io/i/abc';
const pay = (message: string, url = URL) => ({
  kind: 'payment_link' as const,
  args: { ...base, text: message ? `${message}\n${url}` : url, message, url },
});

beforeEach(() => {
  vi.clearAllMocks();
  h.channel = 'instagram';
  run = { account_id: 'a1', conversation_id: 'c1' };
});

describe('payment_link flow send', () => {
  it('sends an Instagram card with a Pay now URL button and stores it as interactive', async () => {
    await flowSend(run, 'k1', pay('Your order total is 499'));
    expect(h.igText).not.toHaveBeenCalled();
    expect(h.igButtons).toHaveBeenCalledTimes(1);
    const args = h.igButtons.mock.calls[0] as unknown as unknown[];
    expect(args[1]).toBe('Your order total is 499');
    expect(args[2]).toEqual([{ type: 'web_url', title: 'Pay now', url: URL }]);
    const row = h.store.mock.calls[0][1];
    expect(row.contentType).toBe('interactive');
    expect(row.contentText).toBe('Your order total is 499');
    expect(row.interactivePayload).toMatchObject({ kind: 'buttons', buttons: [{ url: URL, title: 'Pay now' }], ig: { payment_link: true } });
    expect(h.waText).not.toHaveBeenCalled();
  });

  it('uses a default message when the step has none', async () => {
    await flowSend(run, 'k2', pay(''));
    expect((h.igButtons.mock.calls[0] as unknown as unknown[])[1]).toBe('Here is your payment link.');
  });

  it('falls back to the plain text with the URL when the message is too long for a card', async () => {
    await flowSend(run, 'k3', pay('x'.repeat(641)));
    expect(h.igButtons).not.toHaveBeenCalled();
    expect(h.igText).toHaveBeenCalledTimes(1);
  });

  it('falls back to the plain text when the link is not https', async () => {
    await flowSend(run, 'k4', pay('Pay here', 'http://example.com/p'));
    expect(h.igButtons).not.toHaveBeenCalled();
    expect(h.igText).toHaveBeenCalledTimes(1);
  });

  it('sends the unchanged text on WhatsApp', async () => {
    h.channel = 'whatsapp';
    await flowSend(run, 'k5', pay('Pay here'));
    expect(h.waText).toHaveBeenCalledTimes(1);
    expect(h.waText.mock.calls[0][0]).toMatchObject({ text: `Pay here\n${URL}` });
    expect(h.igButtons).not.toHaveBeenCalled();
    expect(h.igText).not.toHaveBeenCalled();
  });
});
