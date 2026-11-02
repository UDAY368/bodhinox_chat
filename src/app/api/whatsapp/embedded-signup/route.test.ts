import { beforeEach, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  role: 'admin' as string,
  configured: true,
  limited: false,
  mutationOk: true,
  connect: vi.fn(),
  retry: vi.fn(),
}));
const ctx = { accountId: '11111111-1111-4111-8111-111111111111', userId: '22222222-2222-4222-8222-222222222222' };

vi.mock('@/lib/auth/account', () => ({
  requireRole: async (min: string) => {
    if (min === 'admin' && !['admin', 'owner'].includes(h.role)) throw Object.assign(new Error('Forbidden'), { status: 403 });
    return { ...ctx, role: h.role };
  },
  toErrorResponse: (err: { status?: number }) => Response.json({ error: 'denied' }, { status: err.status ?? 500 }),
}));
vi.mock('@/lib/auth/session', () => ({
  requireSession: async () => ({ sessionId: 's' }),
  assertMutation: async () => { if (!h.mutationOk) throw Object.assign(new Error('csrf'), { status: 403 }); },
}));
vi.mock('@/lib/rate-limit', () => ({
  RATE_LIMITS: { adminAction: { limit: 30, windowMs: 60_000 } },
  checkRateLimit: () => ({ success: !h.limited }),
  rateLimitResponse: () => Response.json({ error: 'slow down' }, { status: 429 }),
}));
vi.mock('@/lib/whatsapp/embedded-signup-connect', () => ({
  embeddedSignupConfigured: () => h.configured,
  connectEmbeddedSignup: h.connect,
  retryEmbeddedSignupRegistration: h.retry,
  isTwoStepPin: (v: unknown) => typeof v === 'string' && /^\d{6}$/.test(v),
}));

import { POST } from './route';

const body = { code: 'c0de', waba_id: '555', phone_number_id: '777' };
const post = (b: unknown = body) =>
  POST(new Request('http://x/api/whatsapp/embedded-signup', { method: 'POST', body: JSON.stringify(b), headers: { 'content-type': 'application/json' } }));

beforeEach(() => {
  vi.clearAllMocks();
  h.role = 'admin';
  h.configured = true;
  h.limited = false;
  h.mutationOk = true;
});

it('refuses agents and viewers before anything else', async () => {
  for (const role of ['agent', 'viewer']) {
    h.role = role;
    expect((await post()).status).toBe(403);
  }
  expect(h.connect).not.toHaveBeenCalled();
});

it('requires the mutation origin and CSRF proof', async () => {
  h.mutationOk = false;
  expect((await post()).status).toBe(403);
  expect(h.connect).not.toHaveBeenCalled();
});

it('answers 503 with a message when Embedded Signup is not configured', async () => {
  h.configured = false;
  const res = await post();
  expect(res.status).toBe(503);
  expect(await res.json()).toMatchObject({ code: 'notConfigured', error: expect.any(String) });
});

it('rate limits', async () => {
  h.limited = true;
  expect((await post()).status).toBe(429);
});

it('rejects a malformed body', async () => {
  expect((await post({ ...body, waba_id: 'x' })).status).toBe(400);
  expect(h.connect).not.toHaveBeenCalled();
});

it('passes the live tenant and returns the number and the one-time PIN', async () => {
  const number = { id: 'cfg', phone_number_id: '777', waba_id: '555', display_name: 'Acme', status: 'connected', is_default: true };
  h.connect.mockResolvedValue({ ok: true, number, created: true, pin: '012345' });
  const res = await post();
  expect(res.status).toBe(200);
  expect(res.headers.get('cache-control')).toContain('no-store');
  expect(await res.json()).toEqual({ number, created: true, pin: '012345' });
  expect(h.connect).toHaveBeenCalledWith({ ...ctx, role: 'admin' }, body, { pin: null });
});

it('maps a failed step to its status, with the Meta details and any PIN', async () => {
  const meta = { code: 1, subcode: null, fbtrace_id: 't', step: 'register', field: 'pin', message: 'm' };
  h.connect.mockResolvedValue({ ok: false, status: 500, code: 'saveFailed', step: 'save', meta, pin: '999999' });
  const res = await post();
  expect(res.status).toBe(500);
  expect(await res.json()).toMatchObject({ code: 'saveFailed', step: 'save', meta, pin: '999999', error: expect.any(String) });
});

it("passes the admin's existing PIN to the connect step, never inside the request object", async () => {
  h.connect.mockResolvedValue({ ok: true, number: { id: 'cfg' }, created: true, pin: null });
  const res = await post({ ...body, pin: '004321' });
  expect(res.status).toBe(200);
  expect(await res.json()).toMatchObject({ pin: null });
  expect(h.connect).toHaveBeenCalledWith({ ...ctx, role: 'admin' }, body, { pin: '004321' });
});

it('rejects a PIN that is not exactly 6 digits', async () => {
  for (const pin of ['12345', '1234567', 'abcdef', 123456]) {
    const res = await post({ ...body, pin });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: 'invalidPin' });
  }
  expect(h.connect).not.toHaveBeenCalled();
});

it('returns the row id on a wrong PIN so the admin can retry without a new signup code', async () => {
  h.connect.mockResolvedValue({ ok: false, status: 400, code: 'pinMismatch', step: 'register', config_id: '33333333-3333-4333-8333-333333333333' });
  const res = await post();
  expect(res.status).toBe(400);
  expect(await res.json()).toMatchObject({ code: 'pinMismatch', step: 'register', config_id: '33333333-3333-4333-8333-333333333333', error: expect.any(String) });
});

it('retries registration of a saved number with { config_id, pin }', async () => {
  const configId = '33333333-3333-4333-8333-333333333333';
  const number = { id: configId, phone_number_id: '777', waba_id: '555', display_name: 'Acme', status: 'connected', is_default: true };
  h.retry.mockResolvedValue({ ok: true, number, created: false, pin: null });
  const res = await post({ config_id: configId, pin: '246810' });
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ number, created: false, pin: null });
  expect(h.retry).toHaveBeenCalledWith({ ...ctx, role: 'admin' }, { config_id: configId, pin: '246810' });
  expect(h.connect).not.toHaveBeenCalled();
});

it('refuses a retry without a PIN or with a malformed row id', async () => {
  expect((await post({ config_id: '33333333-3333-4333-8333-333333333333' })).status).toBe(400);
  expect((await post({ config_id: 'nope', pin: '246810' })).status).toBe(400);
  expect(h.retry).not.toHaveBeenCalled();
});

it('applies role, CSRF and rate limits to the retry too', async () => {
  const retryBody = { config_id: '33333333-3333-4333-8333-333333333333', pin: '246810' };
  h.role = 'agent';
  expect((await post(retryBody)).status).toBe(403);
  h.role = 'admin';
  h.limited = true;
  expect((await post(retryBody)).status).toBe(429);
  expect(h.retry).not.toHaveBeenCalled();
});
