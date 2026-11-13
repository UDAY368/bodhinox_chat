import { beforeEach, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ enabled: true, role: 'admin', mutationOk: true, sessions: 0, codes: [] as string[], fail: null as unknown }));

vi.mock('@/lib/auth/session', () => ({
  requireSession: async () => {
    h.sessions++;
    return { userId: '22222222-2222-4222-8222-222222222222', accountId: '11111111-1111-4111-8111-111111111111', role: h.role, sessionId: 's' };
  },
  assertMutation: async () => {
    if (!h.mutationOk) throw new (await import('@/lib/auth/errors')).UnauthorizedError();
  },
}));
vi.mock('@/lib/meta-ads/config', () => ({ metaAdsConfig: () => (h.enabled ? { appId: '1' } : null) }));
vi.mock('@/lib/meta-ads/connection', async (original) => ({
  ...(await original<typeof import('@/lib/meta-ads/connection')>()),
  startConnection: async (_actor: unknown, code: string) => {
    if (h.fail) throw h.fail;
    h.codes.push(code);
    return { id: 'c1', status: 'pending' };
  },
}));

import { MetaAdsError } from '@/lib/meta-ads/connection';
import { __resetRateLimitForTests } from '@/lib/rate-limit';
import { POST } from './route';

const post = (body: unknown) => POST(new Request('http://x/api/meta-ads/connect', { method: 'POST', body: JSON.stringify(body) }));

beforeEach(() => {
  Object.assign(h, { enabled: true, role: 'admin', mutationOk: true, sessions: 0, codes: [], fail: null });
  __resetRateLimitForTests();
});

it('answers 503 before any session or database work while disabled', async () => {
  h.enabled = false;
  const res = await post({ accessToken: 'abc' });
  expect(res.status).toBe(503);
  expect(await res.json()).toMatchObject({ error: 'meta_ads_not_enabled' });
  expect(h.sessions).toBe(0);
});

it('checks the mutation origin and the admin role', async () => {
  h.mutationOk = false;
  expect((await post({ accessToken: 'abc' })).status).toBe(401);
  h.mutationOk = true;
  h.role = 'agent';
  expect((await post({ accessToken: 'abc' })).status).toBe(403);
  expect(h.codes).toEqual([]);
});

it('validates the login token and starts the connection', async () => {
  expect((await post({ accessToken: '' })).status).toBe(400);
  expect((await post({ accessToken: 'x'.repeat(4097) })).status).toBe(400);
  expect((await post({ accessToken: 'abc', extra: 1 })).status).toBe(400);
  // The old code body is refused: a JavaScript SDK code cannot be exchanged.
  expect((await post({ code: 'abc' })).status).toBe(400);
  const res = await post({ accessToken: 'abc' });
  expect(res.status).toBe(200);
  expect(res.headers.get('cache-control')).toBe('private, no-store');
  expect((await res.json()).connection).toEqual({ id: 'c1', status: 'pending' });
  expect(h.codes).toEqual(['abc']);
});

it('maps connection errors to their codes', async () => {
  h.fail = new MetaAdsError('already_connected');
  const res = await post({ accessToken: 'abc' });
  expect(res.status).toBe(409);
  expect((await res.json()).error).toBe('already_connected');
});

it('rate limits attempts per workspace', async () => {
  for (let i = 0; i < 10; i++) expect((await post({ accessToken: 'abc' })).status).toBe(200);
  expect((await post({ accessToken: 'abc' })).status).toBe(429);
});
