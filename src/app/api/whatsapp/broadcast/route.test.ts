import { beforeEach, describe, expect, it, vi } from 'vitest';

const A = '11111111-1111-4111-8111-11111111111a';
const B = '22222222-2222-4222-8222-22222222222b';
const h = vi.hoisted(() => ({
  numbers: [] as Record<string, unknown>[],
  templates: [] as Record<string, unknown>[],
  sent: [] as Record<string, unknown>[],
}));

vi.mock('@/lib/auth/account', () => ({
  requireRole: async () => ({
    accountId: 'acct',
    userId: 'u-1',
    db: {
      from(table: string) {
        const filters: Record<string, unknown> = {};
        const rows = () => (table === 'whatsapp_config' ? h.numbers : table === 'message_templates' ? h.templates : [])
          .filter((r) => Object.entries(filters).every(([k, v]) => k === 'account_id' || r[k] === v));
        const b: Record<string, unknown> = {
          select: () => b,
          eq: (field: string, value: unknown) => { filters[field] = value; return b; },
          maybeSingle: async () => ({ data: rows()[0] ?? null, error: null }),
          then: (resolve: (r: { data: unknown[]; error: null }) => unknown) => resolve({ data: rows(), error: null }),
        };
        return b;
      },
    },
  }),
  toErrorResponse: () => new Response(null, { status: 500 }),
}));
vi.mock('@/lib/rate-limit', () => ({ checkRateLimit: () => ({ success: true }), rateLimitResponse: () => null, RATE_LIMITS: { broadcast: {} } }));
vi.mock('@/lib/whatsapp/encryption', () => ({ decrypt: (v: string) => `plain:${v}` }));
vi.mock('@/lib/whatsapp/meta-api', () => ({
  sendTemplateMessage: async (args: Record<string, unknown>) => { h.sent.push(args); return { messageId: 'wamid.b' }; },
}));

import { POST } from './route';

const TEMPLATE = { id: 't', user_id: 'u', name: 'promo', category: 'Marketing', language: 'en_US', body_text: 'Hi', created_at: '2026-01-01T00:00:00Z' };
const broadcast = (extra: Record<string, unknown> = {}) => POST(new Request('http://localhost/api/whatsapp/broadcast', {
  method: 'POST', body: JSON.stringify({ template_name: 'promo', recipients: [{ phone: '+15551234567' }], ...extra }),
}));

describe('POST /api/whatsapp/broadcast with two numbers', () => {
  beforeEach(() => {
    h.sent = [];
    h.templates = [];
    h.numbers = [
      { id: A, phone_number_id: 'pn-default', access_token: 'tok-a', waba_id: 'waba-a', is_default: true, created_at: '2026-01-01T00:00:00Z' },
      { id: B, phone_number_id: 'pn-second', access_token: 'tok-b', waba_id: 'waba-b', is_default: false, created_at: '2026-02-01T00:00:00Z' },
    ];
  });

  it('sends from the default number when none is named', async () => {
    expect((await broadcast()).status).toBe(200);
    expect(h.sent[0]).toMatchObject({ phoneNumberId: 'pn-default', accessToken: 'plain:tok-a' });
  });

  it('sends from the named number', async () => {
    expect((await broadcast({ whatsapp_config_id: B })).status).toBe(200);
    expect(h.sent[0]).toMatchObject({ phoneNumberId: 'pn-second' });
  });

  it('refuses an unknown number and a template from another WABA without sending', async () => {
    expect((await broadcast({ whatsapp_config_id: '33333333-3333-4333-8333-333333333333' })).status).toBe(400);
    h.templates = [{ ...TEMPLATE, waba_id: 'waba-a' }];
    const res = await broadcast({ whatsapp_config_id: B });
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ code: 'template_wrong_number' });
    expect(h.sent).toHaveLength(0);
  });

  it('refuses a disconnected number with 409 without sending', async () => {
    h.numbers = h.numbers.map((row) => row.id === B ? { ...row, status: 'disconnected', access_token: '' } : row);
    const res = await broadcast({ whatsapp_config_id: B });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'whatsapp_number_disconnected', error: expect.any(String) });
    expect(h.sent).toHaveLength(0);
  });
});
