import { beforeEach, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ enabled: true, mutationOk: true, sessions: 0, calls: [] as unknown[][] }));

vi.mock('@/lib/auth/session', () => ({
  requireSession: async () => {
    h.sessions++;
    return { userId: '22222222-2222-4222-8222-222222222222', accountId: '11111111-1111-4111-8111-111111111111', role: 'admin', sessionId: 's' };
  },
  assertMutation: async () => {
    if (!h.mutationOk) throw new (await import('@/lib/auth/errors')).UnauthorizedError();
  },
}));
vi.mock('@/lib/meta-ads/config', () => ({ metaAdsConfig: () => (h.enabled ? { appId: '1' } : null), metaAdsManageEnabled: () => true }));
vi.mock('@/lib/meta-ads/audiences', async (original) => ({
  ...(await original<typeof import('@/lib/meta-ads/audiences')>()),
  listAudiences: async () => [{ id: 'a1' }],
  requestAudienceCreate: async (...args: unknown[]) => { h.calls.push(['create', args[1]]); return { id: 'a2', status: 'queued' }; },
  requestAudienceSync: async (...args: unknown[]) => { h.calls.push(['sync', args[1]]); return { id: args[1], status: 'queued' }; },
  setAudienceAutoSync: async (...args: unknown[]) => { h.calls.push(['auto_sync', args[1], args[2]]); return { id: args[1] }; },
  recheckAudience: async (...args: unknown[]) => {
    h.calls.push(['recheck', args[1]]);
    throw new (await import('@/lib/meta-ads/connection')).MetaAdsError('name_taken');
  },
  removeAudience: async (...args: unknown[]) => { h.calls.push(['remove', args[1]]); },
}));

import { __resetRateLimitForTests } from '@/lib/rate-limit';
import { GET, POST } from './route';

const post = (body: unknown) => POST(new Request('http://x/api/meta-ads/audiences', { method: 'POST', body: JSON.stringify(body) }));
const ID = '33333333-3333-4333-8333-333333333333';
const list = { action: 'create', kind: 'customer_list', adAccountId: '555', name: 'Paid', segmentId: ID };

beforeEach(() => {
  Object.assign(h, { enabled: true, mutationOk: true, sessions: 0, calls: [] });
  __resetRateLimitForTests();
});

it('answers 503 before any session work while disabled', async () => {
  h.enabled = false;
  expect((await GET(new Request('http://x/api/meta-ads/audiences'))).status).toBe(503);
  expect((await post(list)).status).toBe(503);
  expect(h.sessions).toBe(0);
});

it('lists audiences for any member', async () => {
  expect(await (await GET(new Request('http://x/api/meta-ads/audiences'))).json()).toEqual({ audiences: [{ id: 'a1' }] });
});

it('checks the mutation origin before reading the body', async () => {
  h.mutationOk = false;
  expect((await post(list)).status).toBe(401);
  expect(h.calls).toEqual([]);
});

it('validates and queues a create (202)', async () => {
  expect((await post({ ...list, segmentId: 'x' })).status).toBe(400);
  expect((await post({ ...list, kind: 'pixel' })).status).toBe(400);
  const res = await post(list);
  expect(res.status).toBe(202);
  expect(h.calls).toEqual([['create', { kind: 'customer_list', adAccountId: '555', name: 'Paid', segmentId: ID, autoSync: true }]]);
});

it('routes sync, auto-sync, re-check and remove by a well-formed id', async () => {
  expect((await post({ action: 'sync', id: "1' or 1=1" })).status).toBe(400);
  expect((await post({ action: 'auto_sync', id: ID, autoSync: 'yes' })).status).toBe(400);
  expect((await post({ action: 'launch', id: ID })).status).toBe(400);
  expect((await post({ action: 'sync', id: ID })).status).toBe(202);
  expect((await post({ action: 'auto_sync', id: ID, autoSync: false })).status).toBe(200);
  expect((await post({ action: 'recheck', id: ID })).status).toBe(409);
  expect((await post({ action: 'remove', id: ID })).status).toBe(200);
  expect(h.calls).toEqual([['sync', ID], ['auto_sync', ID, false], ['recheck', ID], ['remove', ID]]);
});
