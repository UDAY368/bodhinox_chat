import { beforeEach, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ enabled: true, role: 'admin', mutationOk: true, sessions: 0, connected: true, queued: 0 }));

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
vi.mock('@/lib/meta-ads/insights', async (original) => ({
  ...(await original<typeof import('@/lib/meta-ads/insights')>()),
  queueInsightsSync: async () => {
    if (h.connected) h.queued++;
    return h.connected;
  },
}));

import { __resetRateLimitForTests } from '@/lib/rate-limit';
import { POST } from './route';

const post = () => POST(new Request('http://x/api/meta-ads/ads/sync', { method: 'POST' }));

beforeEach(() => {
  Object.assign(h, { enabled: true, role: 'admin', mutationOk: true, sessions: 0, connected: true, queued: 0 });
  __resetRateLimitForTests();
});

it('answers 503 while disabled, before the session', async () => {
  h.enabled = false;
  expect((await post()).status).toBe(503);
  expect(h.sessions).toBe(0);
});

it('requires the mutation check and an admin', async () => {
  h.mutationOk = false;
  expect((await post()).status).toBe(401);
  h.mutationOk = true;
  h.role = 'agent';
  expect((await post()).status).toBe(403);
  expect(h.queued).toBe(0);
});

it('queues a sync, or answers 404 without an active connection', async () => {
  expect((await post()).status).toBe(202);
  expect(h.queued).toBe(1);
  h.connected = false;
  const res = await post();
  expect(res.status).toBe(404);
  expect((await res.json()).error).toBe('not_connected');
});
