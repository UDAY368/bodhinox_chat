import { beforeEach, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ enabled: true, signedIn: true, connectionReads: 0 }));

vi.mock('@/lib/auth/session', () => ({
  requireSession: async () => {
    if (!h.signedIn) throw new (await import('@/lib/auth/errors')).UnauthorizedError();
    return { userId: '22222222-2222-4222-8222-222222222222', accountId: '11111111-1111-4111-8111-111111111111', role: 'viewer', sessionId: 's' };
  },
}));
vi.mock('@/lib/meta-ads/config', async (original) => ({
  ...(await original<typeof import('@/lib/meta-ads/config')>()),
  metaAdsStatus: () => (h.enabled ? { enabled: true, appId: '123', loginConfigId: '456' } : { enabled: false, reason: 'flag_off' }),
}));
vi.mock('@/lib/meta-ads/connection', async (original) => ({
  ...(await original<typeof import('@/lib/meta-ads/connection')>()),
  getConnection: async () => {
    h.connectionReads++;
    return { id: 'c1', status: 'active', scopes: ['ads_read', 'whatsapp_business_manage_events'] };
  },
}));

import { GET } from './route';

const get = () => GET(new Request('http://x/api/meta-ads/status'));

beforeEach(() => Object.assign(h, { enabled: true, signedIn: true, connectionReads: 0 }));

it('says not enabled, with no connection read, while the flag is off', async () => {
  h.enabled = false;
  const res = await get();
  expect(res.status).toBe(200);
  expect(await res.json()).toMatchObject({ enabled: false, reason: 'flag_off', connection: null });
  expect(h.connectionReads).toBe(0);
});

it('gives any member the public config, the connection and the missing permissions', async () => {
  const res = await get();
  expect(res.headers.get('cache-control')).toBe('private, no-store');
  const body = await res.json();
  expect(body).toMatchObject({ enabled: true, appId: '123', loginConfigId: '456', connection: { id: 'c1' } });
  expect(body.missingScopes.insights).toEqual([]);
  expect(body.missingScopes.capi).toEqual([]);
  expect(body.missingScopes.leads).toContain('leads_retrieval');
  expect(JSON.stringify(body)).not.toMatch(/secret/i);
});

it('needs a session', async () => {
  h.signedIn = false;
  expect((await get()).status).toBe(401);
});
