import { beforeEach, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  enabled: true, role: 'admin', mutationOk: true, sessions: 0,
  calls: [] as unknown[], disconnected: { id: 'c1', status: 'disconnected' } as unknown, fail: null as unknown,
}));

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
  finishConnection: async (_a: unknown, input: unknown) => {
    h.calls.push(['finish', input]);
    return { id: 'c1', status: 'active' };
  },
  updateCapiSettings: async (_a: unknown, input: unknown) => {
    h.calls.push(['capi', input]);
    return { id: 'c1', status: 'active', capiEnabled: true };
  },
  disconnect: async () => {
    if (h.fail) throw h.fail;
    h.calls.push(['disconnect']);
    return h.disconnected;
  },
}));

import { MetaAdsError } from '@/lib/meta-ads/connection';
import { __resetRateLimitForTests } from '@/lib/rate-limit';
import { DELETE, PATCH } from './route';

const patch = (body: unknown) => PATCH(new Request('http://x/api/meta-ads/connection', { method: 'PATCH', body: JSON.stringify(body) }));
const del = () => DELETE(new Request('http://x/api/meta-ads/connection', { method: 'DELETE' }));

beforeEach(() => {
  Object.assign(h, { enabled: true, role: 'admin', mutationOk: true, sessions: 0, calls: [], disconnected: { id: 'c1', status: 'disconnected' }, fail: null });
  __resetRateLimitForTests();
});

it('answers PATCH with 503 before anything else while disabled', async () => {
  h.enabled = false;
  expect((await patch({ adAccountId: '1', pageId: '2' })).status).toBe(503);
  expect(h.sessions).toBe(0);
  expect(h.calls).toEqual([]);
});

it('still lets an admin disconnect while disabled, behind the same session, mutation and role checks', async () => {
  h.enabled = false;
  expect((await del()).status).toBe(200);
  expect(h.calls).toEqual([['disconnect']]);
  h.mutationOk = false;
  expect((await del()).status).toBe(401);
  h.mutationOk = true;
  h.role = 'agent';
  expect((await del()).status).toBe(403);
  expect(h.calls).toEqual([['disconnect']]);
});

it('requires the mutation check and an admin', async () => {
  h.mutationOk = false;
  expect((await del()).status).toBe(401);
  h.mutationOk = true;
  h.role = 'agent';
  expect((await patch({ capiEnabled: true })).status).toBe(403);
  expect(h.calls).toEqual([]);
});

it('routes a finish and a CAPI update, and rejects anything else', async () => {
  expect((await patch({ adAccountId: '111', pageId: '222' })).status).toBe(200);
  expect((await patch({ capiEnabled: true, capiWhatsappConfigId: '33333333-3333-4333-8333-333333333333' })).status).toBe(200);
  expect(h.calls).toEqual([
    ['finish', { adAccountId: '111', pageId: '222' }],
    ['capi', { capiEnabled: true, capiWhatsappConfigId: '33333333-3333-4333-8333-333333333333' }],
  ]);
  for (const bad of [{}, { adAccountId: 'act_1', pageId: '2' }, { capiEnabled: 'yes' }, { capiWhatsappConfigId: 'x' }, { other: 1 }]) {
    const res = await patch(bad);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('invalid_request');
  }
});

it('disconnects, answers 404 when nothing is connected and 502 when Meta cannot revoke', async () => {
  expect((await del()).status).toBe(200);
  h.disconnected = null;
  expect((await del()).status).toBe(404);
  h.fail = new MetaAdsError('revoke_failed');
  const res = await del();
  expect(res.status).toBe(502);
  expect((await res.json()).error).toBe('revoke_failed');
});
