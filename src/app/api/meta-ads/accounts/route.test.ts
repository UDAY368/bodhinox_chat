import { beforeEach, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ enabled: true, mutationOk: true, calls: [] as unknown[][] }));

vi.mock('@/lib/auth/session', () => ({
  requireSession: async () => ({ userId: '22222222-2222-4222-8222-222222222222', accountId: '11111111-1111-4111-8111-111111111111', role: 'admin', sessionId: 's' }),
  assertMutation: async () => {
    if (!h.mutationOk) throw new (await import('@/lib/auth/errors')).UnauthorizedError();
  },
}));
vi.mock('@/lib/meta-ads/config', () => ({ metaAdsConfig: () => (h.enabled ? { appId: '1' } : null) }));
vi.mock('@/lib/meta-ads/accounts', async (original) => ({
  ...(await original<typeof import('@/lib/meta-ads/accounts')>()),
  listLinkedAdAccounts: async () => [{ adAccountId: '555', isPrimary: true }],
  listAvailableAdAccounts: async () => {
    h.calls.push(['available']);
    return [{ adAccountId: '777' }];
  },
  addAdAccount: async (_a: unknown, id: string) => {
    h.calls.push(['add', id]);
    return [];
  },
  removeAdAccount: async (_a: unknown, id: string) => {
    h.calls.push(['remove', id]);
    return [];
  },
}));

import { __resetRateLimitForTests } from '@/lib/rate-limit';
import { GET, POST } from './route';

const post = (body: unknown) => POST(new Request('http://x/api/meta-ads/accounts', { method: 'POST', body: JSON.stringify(body) }));

beforeEach(() => {
  Object.assign(h, { enabled: true, mutationOk: true, calls: [] });
  __resetRateLimitForTests();
});

it('lists linked accounts without calling Meta; ?available=1 also lists the others', async () => {
  expect(await (await GET(new Request('http://x/api/meta-ads/accounts'))).json()).toEqual({ accounts: [{ adAccountId: '555', isPrimary: true }] });
  expect(h.calls).toEqual([]);
  const res = await GET(new Request('http://x/api/meta-ads/accounts?available=1'));
  expect((await res.json()).available).toEqual([{ adAccountId: '777' }]);
});

it('adds and removes by a numeric id after the mutation check', async () => {
  h.mutationOk = false;
  expect((await post({ action: 'add', adAccountId: '777' })).status).toBe(401);
  h.mutationOk = true;
  expect((await post({ action: 'add', adAccountId: 'act_777' })).status).toBe(400);
  expect((await post({ action: 'rename', adAccountId: '777' })).status).toBe(400);
  expect((await post({ action: 'add', adAccountId: '777' })).status).toBe(200);
  expect((await post({ action: 'remove', adAccountId: '777' })).status).toBe(200);
  expect(h.calls).toEqual([['add', '777'], ['remove', '777']]);
});

it('answers 503 while disabled', async () => {
  h.enabled = false;
  expect((await GET(new Request('http://x/api/meta-ads/accounts'))).status).toBe(503);
  expect((await post({ action: 'add', adAccountId: '777' })).status).toBe(503);
});
