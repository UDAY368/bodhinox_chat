import { beforeEach, expect, it, vi } from 'vitest';

const ctx = { accountId: '11111111-1111-4111-8111-111111111111', userId: '22222222-2222-4222-8222-222222222222', role: 'admin' };
const h = vi.hoisted(() => ({
  requireRole: vi.fn(),
  getCurrentAccount: vi.fn(),
  stored: null as null | { id: string; provider: 'razorpay'; mode: 'test' | 'live'; key_id: string; connected_at: Date; secret: string; webhook: string | null },
  testCredentials: vi.fn<(creds: { keyId: string; keySecret: string }) => Promise<{ ok: true } | { ok: false; reason: 'auth' | 'unreachable' }>>(async () => ({ ok: true })),
  save: vi.fn(),
  rateLimited: false,
}));

vi.mock('@/lib/auth/account', () => ({
  requireRole: h.requireRole,
  getCurrentAccount: h.getCurrentAccount,
  toErrorResponse: (e: unknown) => Response.json({ error: 'Forbidden' }, { status: (e as { status?: number })?.status ?? 403 }),
}));
vi.mock('@/lib/auth/csrf', () => ({ appOrigin: () => 'https://app.example.test' }));
vi.mock('@/lib/db/prisma', () => ({ getWorkerPrisma: () => ({}) }));
vi.mock('@/lib/db/tenant', () => ({
  withTenant: (_c: unknown, op: (tx: unknown) => unknown) => op({
    // The worker read that says whether a webhook secret is stored; it never selects the secret itself.
    $queryRaw: async (strings: TemplateStringsArray) => {
      expect(strings.join('?')).toContain('webhook_secret_enc IS NOT NULL');
      return h.stored ? [{ set: !!h.stored.webhook }] : [];
    },
  }),
}));
vi.mock('@/lib/payments/providers', () => ({
  PaymentProviderError: class extends Error {},
  getPaymentProvider: async () => (h.stored ? { id: h.stored.id, provider: 'razorpay', mode: h.stored.mode, key_id: h.stored.key_id, connected_at: h.stored.connected_at } : null),
  savePaymentProvider: async (_tx: unknown, _a: string, input: { keyId: string; keySecret: string; webhookSecret?: string }) => {
    h.save(input);
    h.stored = { id: 'p1', provider: 'razorpay', mode: input.keyId.startsWith('rzp_live_') ? 'live' : 'test', key_id: input.keyId,
      connected_at: new Date('2026-11-02T10:00:00Z'), secret: input.keySecret, webhook: input.webhookSecret ?? h.stored?.webhook ?? null };
    return { id: 'p1', provider: 'razorpay', mode: h.stored.mode, key_id: input.keyId, connected_at: h.stored.connected_at };
  },
  deletePaymentProvider: async () => { const had = !!h.stored; h.stored = null; return had; },
}));
vi.mock('@/lib/payments/razorpay', async (orig) => ({ ...(await orig<typeof import('@/lib/payments/razorpay')>()), testCredentials: h.testCredentials }));
vi.mock('@/lib/rate-limit', () => ({
  RATE_LIMITS: { adminAction: { limit: 30, windowMs: 60_000 } },
  checkRateLimit: () => ({ success: !h.rateLimited }),
  rateLimitResponse: () => Response.json({}, { status: 429 }),
}));

import { DELETE, GET, PUT } from './route';

const put = (body: unknown) => PUT(new Request('http://localhost/api/payments/razorpay/settings', { method: 'PUT', body: JSON.stringify(body) }));
const KEY = 'rzp_test_AbCdEf123456';

beforeEach(() => {
  vi.clearAllMocks();
  h.stored = null;
  h.rateLimited = false;
  h.requireRole.mockResolvedValue(ctx);
  h.getCurrentAccount.mockResolvedValue({ ...ctx, role: 'viewer' });
});

it('tells any member whether Razorpay is connected, with the webhook URL and never a secret', async () => {
  expect(await (await GET()).json()).toEqual({
    connected: false, mode: null, key_id: null, connected_at: null, webhook_secret_set: false,
    webhook_url: `https://app.example.test/api/payments/razorpay/webhook/${ctx.accountId}`,
  });
  await put({ key_id: KEY, key_secret: 'top-secret', webhook_secret: 'hook-secret' });
  const res = await GET();
  const text = await res.clone().text();
  expect(text).not.toContain('top-secret');
  expect(text).not.toContain('hook-secret');
  expect(res.headers.get('cache-control')).toContain('no-store');
  expect(await res.json()).toMatchObject({ connected: true, mode: 'test', key_id: KEY, webhook_secret_set: true });
});

it('saves keys only for admins and only after Razorpay accepts them', async () => {
  h.requireRole.mockRejectedValueOnce(Object.assign(new Error('Insufficient workspace role'), { status: 403 }));
  expect((await put({ key_id: KEY, key_secret: 's' })).status).toBe(403);
  expect(h.requireRole).toHaveBeenCalledWith('admin');
  expect(h.save).not.toHaveBeenCalled();

  h.testCredentials.mockResolvedValueOnce({ ok: false, reason: 'auth' });
  const refused = await put({ key_id: KEY, key_secret: 'wrong' });
  expect(refused.status).toBe(400);
  expect(await refused.json()).toMatchObject({ code: 'auth' });
  expect(h.save).not.toHaveBeenCalled();

  h.testCredentials.mockResolvedValueOnce({ ok: false, reason: 'unreachable' });
  expect((await put({ key_id: KEY, key_secret: 'right' })).status).toBe(502);
  expect(h.save).not.toHaveBeenCalled();

  const ok = await put({ key_id: KEY, key_secret: 'right', webhook_secret: 'hook' });
  expect(ok.status).toBe(200);
  expect(h.testCredentials).toHaveBeenLastCalledWith({ keyId: KEY, keySecret: 'right' });
  expect(h.save).toHaveBeenCalledWith({ keyId: KEY, keySecret: 'right', webhookSecret: 'hook' });
  expect(JSON.stringify(await ok.json())).not.toContain('right');
});

it('refuses a malformed key, a mode that disagrees with the key, and a bad webhook secret before calling Razorpay', async () => {
  expect((await put({ key_id: 'sk_live_x', key_secret: 's' })).status).toBe(400);
  expect((await put({ key_id: KEY, key_secret: '' })).status).toBe(400);
  const mismatch = await put({ key_id: KEY, key_secret: 's', mode: 'live' });
  expect(mismatch.status).toBe(400);
  expect(await mismatch.json()).toMatchObject({ code: 'mode_mismatch' });
  expect((await put({ key_id: KEY, key_secret: 's', webhook_secret: 'x'.repeat(201) })).status).toBe(400);
  expect((await PUT(new Request('http://localhost/x', { method: 'PUT', body: 'not json' }))).status).toBe(400);
  expect(h.testCredentials).not.toHaveBeenCalled();
});

it('keeps the stored webhook secret when none is sent', async () => {
  await put({ key_id: KEY, key_secret: 'one', webhook_secret: 'hook' });
  await put({ key_id: KEY, key_secret: 'two' });
  expect(h.save).toHaveBeenLastCalledWith({ keyId: KEY, keySecret: 'two', webhookSecret: undefined });
  expect(await (await GET()).json()).toMatchObject({ webhook_secret_set: true });
});

it('disconnects for admins only, and is rate limited', async () => {
  await put({ key_id: KEY, key_secret: 'one' });
  h.requireRole.mockRejectedValueOnce(Object.assign(new Error('no'), { status: 403 }));
  expect((await DELETE()).status).toBe(403);
  expect(h.stored).not.toBeNull();
  expect(await (await DELETE()).json()).toEqual({ removed: true });
  expect(h.stored).toBeNull();
  h.rateLimited = true;
  expect((await DELETE()).status).toBe(429);
  expect((await put({ key_id: KEY, key_secret: 'one' })).status).toBe(429);
});
