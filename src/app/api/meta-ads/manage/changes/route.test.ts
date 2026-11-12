import { beforeEach, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ enabled: true, manage: true, role: 'admin', mutationOk: true, sessions: 0, requested: [] as unknown[] }));

vi.mock('@/lib/auth/session', () => ({
  requireSession: async () => {
    h.sessions++;
    return { userId: '22222222-2222-4222-8222-222222222222', accountId: '11111111-1111-4111-8111-111111111111', role: h.role, sessionId: 's' };
  },
  assertMutation: async () => {
    if (!h.mutationOk) throw new (await import('@/lib/auth/errors')).UnauthorizedError();
  },
}));
vi.mock('@/lib/meta-ads/config', () => ({
  metaAdsConfig: () => (h.enabled ? { appId: '1' } : null),
  metaAdsManageEnabled: () => h.enabled && h.manage,
}));
vi.mock('@/lib/meta-ads/manage', async (original) => ({
  ...(await original<typeof import('@/lib/meta-ads/manage')>()),
  requestAdChange: async (_actor: unknown, input: unknown) => {
    h.requested.push(input);
    if ((input as { value: string }).value === '99999') throw new (await import('@/lib/meta-ads/connection')).MetaAdsError('over_budget_cap');
    return { id: 'c1', status: 'queued' };
  },
}));

import { __resetRateLimitForTests } from '@/lib/rate-limit';
import { POST } from './route';

const post = (body: unknown) => POST(new Request('http://x/api/meta-ads/manage/changes', { method: 'POST', body: JSON.stringify(body) }));
const pause = { objectId: '120', field: 'status', value: 'PAUSED' };

beforeEach(() => {
  Object.assign(h, { enabled: true, manage: true, role: 'admin', mutationOk: true, sessions: 0, requested: [] });
  __resetRateLimitForTests();
});

it('answers 503 while Meta ads or ad management is off, before the session', async () => {
  h.enabled = false;
  expect((await post(pause)).status).toBe(503);
  h.enabled = true;
  h.manage = false;
  const res = await post(pause);
  expect(res.status).toBe(503);
  expect((await res.json()).error).toBe('manage_not_enabled');
  expect(h.sessions).toBe(0);
});

it('requires the mutation check and an admin, before reading the body', async () => {
  h.mutationOk = false;
  expect((await post(pause)).status).toBe(401);
  h.mutationOk = true;
  for (const role of ['agent', 'viewer']) {
    h.role = role;
    expect((await post({ nonsense: true })).status).toBe(403);
  }
  expect(h.requested).toEqual([]);
});

it('refuses an invalid change and queues a valid one (202)', async () => {
  const bad = await post({ objectId: '120', field: 'bid_amount', value: '1' });
  expect(bad.status).toBe(400);
  expect((await bad.json()).error).toBe('invalid_request');
  const ok = await post(pause);
  expect(ok.status).toBe(202);
  expect((await ok.json()).change).toEqual({ id: 'c1', status: 'queued' });
  expect(h.requested).toEqual([pause]);
});

it('passes the budget cap refusal through as 422 with a translated message', async () => {
  const res = await post({ objectId: '120', field: 'daily_budget', value: 99999 });
  expect(res.status).toBe(422);
  const body = await res.json();
  expect(body.error).toBe('over_budget_cap');
  expect(typeof body.message).toBe('string');
});
