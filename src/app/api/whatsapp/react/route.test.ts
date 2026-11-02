import { beforeEach, describe, expect, it, vi } from 'vitest';

const A = '11111111-1111-4111-8111-11111111111a';
const B = '22222222-2222-4222-8222-22222222222b';
const h = vi.hoisted(() => ({
  conversationNumber: null as string | null,
  numbers: [] as Record<string, unknown>[],
  sent: [] as Record<string, unknown>[],
}));

function db() {
  return {
    from(table: string) {
      const filters: Record<string, unknown> = {};
      const rows = (): Record<string, unknown>[] => {
        if (table === 'messages') return [{ id: 'm-1', message_id: 'wamid.in', conversation_id: 'cv-1' }];
        if (table === 'conversations') return [{ id: 'cv-1', account_id: 'acct', whatsapp_config_id: h.conversationNumber, contact: { phone: '+15551234567' } }];
        if (table === 'whatsapp_config') return h.numbers.filter((n) => Object.entries(filters).every(([k, v]) => k === 'account_id' || n[k] === v));
        return [];
      };
      const b: Record<string, unknown> = {
        select: () => b,
        delete: () => b,
        upsert: async () => ({ error: null }),
        eq: (field: string, value: unknown) => { filters[field] = value; return b; },
        maybeSingle: async () => ({ data: rows()[0] ?? null, error: null }),
        then: (resolve: (r: { data: unknown[]; error: null }) => unknown) => resolve({ data: rows(), error: null }),
      };
      return b;
    },
  };
}

vi.mock('@/lib/auth/account', () => ({
  requireRole: async () => ({ db: db(), accountId: 'acct', userId: 'u-1' }),
  toErrorResponse: () => new Response(null, { status: 500 }),
}));
vi.mock('@/lib/rate-limit', () => ({ checkRateLimit: () => ({ success: true }), rateLimitResponse: () => null, RATE_LIMITS: { react: {} } }));
vi.mock('@/lib/whatsapp/encryption', () => ({ decrypt: (v: string) => `plain:${v}` }));
vi.mock('@/lib/whatsapp/meta-api', () => ({
  sendReactionMessage: async (args: Record<string, unknown>) => { h.sent.push(args); return {}; },
}));

import { POST } from './route';

const NUMBERS = [
  { id: A, phone_number_id: 'pn-default', access_token: 'tok-a', is_default: true, created_at: '2026-01-01T00:00:00Z' },
  { id: B, phone_number_id: 'pn-second', access_token: 'tok-b', is_default: false, created_at: '2026-02-01T00:00:00Z' },
];
const react = () => POST(new Request('http://localhost/api/whatsapp/react', {
  method: 'POST', body: JSON.stringify({ message_id: 'm-1', emoji: '👍' }),
}));

describe('POST /api/whatsapp/react with two numbers', () => {
  beforeEach(() => { h.sent = []; h.numbers = NUMBERS; h.conversationNumber = null; });

  it("reacts from the conversation's number", async () => {
    h.conversationNumber = B;
    const res = await react();
    expect(res.status).toBe(200);
    expect(h.sent[0]).toMatchObject({ phoneNumberId: 'pn-second', accessToken: 'plain:tok-b' });
  });

  it('uses the default number for a legacy conversation', async () => {
    const res = await react();
    expect(res.status).toBe(200);
    expect(h.sent[0]).toMatchObject({ phoneNumberId: 'pn-default' });
  });

  it("refuses with 409 when the conversation's number was disconnected", async () => {
    h.numbers = NUMBERS.map((row) => row.id === B ? { ...row, status: 'disconnected', access_token: '' } : row);
    h.conversationNumber = B;
    const res = await react();
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'whatsapp_number_disconnected', error: expect.any(String) });
    expect(h.sent).toHaveLength(0);
  });

  it('refuses when no number is connected', async () => {
    h.numbers = [];
    const res = await react();
    expect(res.status).toBe(400);
    expect(h.sent).toHaveLength(0);
  });
});
