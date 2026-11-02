import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  numbers: [] as Record<string, unknown>[],
  resolved: [] as unknown[][],
  sent: 0,
}));

vi.mock('@/lib/auth/api-context', () => ({
  requireApiKey: async () => ({
    accountId: 'acct',
    db: {
      from() {
        const filters: Record<string, unknown> = {};
        const b: Record<string, unknown> = {
          select: () => b,
          eq: (field: string, value: unknown) => { filters[field] = value; return b; },
          maybeSingle: async () => ({
            data: h.numbers.find((n) => Object.entries(filters).every(([k, v]) => n[k] === v)) ?? null,
            error: null,
          }),
        };
        return b;
      },
    },
  }),
}));
vi.mock('@/lib/whatsapp/resolve-conversation', () => ({
  resolveConversationByPhone: async (...args: unknown[]) => {
    h.resolved.push(args);
    return { conversationId: 'cv-1', contactId: 'ct-1', contactCreated: false, whatsappConfigId: 'x' };
  },
}));
vi.mock('@/lib/whatsapp/send-message', async (importOriginal) => ({
  ...await importOriginal<Record<string, unknown>>(),
  sendMessageToConversation: async () => { h.sent++; return { messageId: 'm-1', whatsappMessageId: 'wamid.1' }; },
}));

import { POST } from './route';

const B = '22222222-2222-4222-8222-22222222222b';
const send = (body: Record<string, unknown>) =>
  POST(new Request('http://localhost/api/v1/messages', { method: 'POST', body: JSON.stringify(body) }));

describe('POST /api/v1/messages phone_number_id', () => {
  beforeEach(() => {
    h.resolved = [];
    h.sent = 0;
    h.numbers = [
      { id: B, account_id: 'acct', phone_number_id: '2000' },
      { id: 'foreign', account_id: 'other', phone_number_id: '3000' },
    ];
  });

  it('sends from the named number of this workspace', async () => {
    const res = await send({ to: '+15551234567', text: 'hi', phone_number_id: '2000' });
    expect(res.status).toBe(201);
    expect(h.resolved[0][4]).toEqual({ whatsappConfigId: B });
  });

  it('uses the default number when omitted (unchanged behaviour)', async () => {
    const res = await send({ to: '+15551234567', text: 'hi' });
    expect(res.status).toBe(201);
    expect(h.resolved[0][4]).toEqual({ whatsappConfigId: null });
  });

  it("refuses another workspace's number or a malformed value before creating anything", async () => {
    expect((await send({ to: '+15551234567', text: 'hi', phone_number_id: '3000' })).status).toBe(400);
    expect((await send({ to: '+15551234567', text: 'hi', phone_number_id: 42 })).status).toBe(400);
    expect(h.resolved).toHaveLength(0);
    expect(h.sent).toBe(0);
  });

  it('refuses a disconnected number with 409 before creating anything', async () => {
    h.numbers[0] = { ...h.numbers[0], status: 'disconnected', access_token: '' };
    const res = await send({ to: '+15551234567', text: 'hi', phone_number_id: '2000' });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: { code: 'whatsapp_number_disconnected', message: expect.any(String) } });
    expect(h.resolved).toHaveLength(0);
    expect(h.sent).toBe(0);
  });
});
