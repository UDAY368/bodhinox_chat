// POST /api/ai/test ("Test connection"): admin role, the proxy's CSRF/origin
// check for cookie sessions, the real per-admin rate limit, and the key
// (typed or stored) never comes back in the answer.
import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  requireRole: vi.fn(),
  validate: vi.fn(),
  mutation: vi.fn(),
  stored: null as { api_key: string | null; provider: string; base_url: string | null } | null,
}));

vi.mock('@/lib/auth/account', () => ({
  requireRole: h.requireRole,
  toErrorResponse: (error: unknown) =>
    new Response(JSON.stringify({ error: 'denied' }), { status: (error as { status?: number }).status ?? 500 }),
}));
vi.mock('@/lib/ai/validate', () => ({ validateAiCredentials: h.validate }));
vi.mock('@/lib/whatsapp/encryption', () => ({ decrypt: (value: string) => `plain-${value}` }));
vi.mock('@/lib/auth/session', () => ({
  requireSession: async () => ({ userId: 'u', accountId: 'a', role: 'admin', sessionId: 's' }),
  resolveSession: async () => ({ userId: 'u', accountId: 'a', role: 'admin', sessionId: 's' }),
  resolveEnrollmentSession: async () => null,
  assertMutation: h.mutation,
}));

import { POST } from './route';
import { proxy } from '@/proxy';
import { ForbiddenError } from '@/lib/auth/errors';
import { AiError } from '@/lib/ai/types';

const db = {
  from: () => {
    const b: Record<string, unknown> = {};
    b.select = () => b;
    b.eq = () => b;
    b.maybeSingle = async () => ({ data: h.stored, error: null });
    return b;
  },
};

let admin = 0;
const post = (body: unknown) =>
  POST(new Request('https://crm.test/api/ai/test', { method: 'POST', body: JSON.stringify(body) }));

beforeEach(() => {
  // A fresh admin per test, so the in-memory limiter starts empty.
  admin += 1;
  h.requireRole.mockResolvedValue({ db, accountId: 'account-1', userId: `admin-${admin}` });
  h.validate.mockResolvedValue(undefined);
  h.stored = null;
  delete process.env.AI_ENABLED;
});
afterEach(() => vi.clearAllMocks());

describe('POST /api/ai/test', () => {
  it('asks for the admin role and refuses others before any provider call', async () => {
    h.requireRole.mockRejectedValue(Object.assign(new Error('Forbidden'), { status: 403 }));
    const res = await post({ provider: 'openai', model: 'gpt-5.4-mini', api_key: 'sk-typed-secret' });
    expect(res.status).toBe(403);
    expect(h.requireRole).toHaveBeenCalledWith('admin');
    expect(h.validate).not.toHaveBeenCalled();
  });

  it('answers ok without echoing the typed key', async () => {
    const res = await post({ provider: 'openai', model: 'gpt-5.4-mini', api_key: 'sk-typed-secret' });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({ ok: true });
    expect(text).not.toContain('sk-typed-secret');
    expect(h.validate).toHaveBeenCalledWith(expect.objectContaining({ apiKey: 'sk-typed-secret', model: 'gpt-5.4-mini' }));
  });

  it('tests the stored key without sending it back, on success or failure', async () => {
    h.stored = { api_key: 'cipher', provider: 'anthropic', base_url: null };
    const ok = await post({ provider: 'anthropic', model: 'claude-haiku-5-5' });
    expect(await ok.text()).not.toContain('plain-cipher');
    expect(h.validate).toHaveBeenCalledWith(expect.objectContaining({ apiKey: 'plain-cipher' }));

    h.validate.mockRejectedValue(new AiError('The provider rejected the key.', { code: 'invalid_key', status: 401 }));
    const failed = await post({ provider: 'anthropic', model: 'claude-haiku-5-5' });
    expect(failed.status).toBe(400);
    const body = await failed.text();
    expect(body).not.toContain('plain-cipher');
    expect(body).not.toContain('cipher');
  });

  it('accepts a saved free-text model that is not in the picker list', async () => {
    const res = await post({ provider: 'openai', model: 'my-fine-tune:2026', api_key: 'sk-x' });
    expect(res.status).toBe(200);
    expect(h.validate).toHaveBeenCalledWith(expect.objectContaining({ model: 'my-fine-tune:2026' }));
  });

  it('rate limits each admin (30 a minute) before calling the provider', async () => {
    for (let i = 0; i < 30; i++) expect((await post({ provider: 'openai', model: 'm', api_key: 'sk-x' })).status).toBe(200);
    const limited = await post({ provider: 'openai', model: 'm', api_key: 'sk-x' });
    expect(limited.status).toBe(429);
    expect(h.validate).toHaveBeenCalledTimes(30);
  });

  it('sits behind the proxy’s CSRF/origin check for cookie sessions', async () => {
    h.mutation.mockRejectedValue(new ForbiddenError('Invalid CSRF token'));
    const res = await proxy(new NextRequest('https://crm.test/api/ai/test', {
      method: 'POST', headers: { cookie: 'bnx_access=jwt' }, body: JSON.stringify({ provider: 'openai', model: 'm' }),
    }));
    expect(res.status).toBe(403);
    expect(h.mutation).toHaveBeenCalled();
    expect(h.validate).not.toHaveBeenCalled();
  });
});
