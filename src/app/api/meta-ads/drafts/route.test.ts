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
vi.mock('@/lib/meta-ads/create', async (original) => ({
  ...(await original<typeof import('@/lib/meta-ads/create')>()),
  listAdDrafts: async () => [{ id: 'd1' }],
  requestAdCreate: async (...args: unknown[]) => {
    h.calls.push(['create', ...args]);
    return { id: 'd2', status: 'queued' };
  },
  recheckAdDraft: async (...args: unknown[]) => {
    h.calls.push(['recheck', ...args]);
    throw new (await import('@/lib/meta-ads/connection')).MetaAdsError('not_found');
  },
  discardAdDraft: async (...args: unknown[]) => {
    h.calls.push(['discard', ...args]);
    return { id: args[1], status: 'discarded' };
  },
}));

import { __resetRateLimitForTests } from '@/lib/rate-limit';
import { GET, POST } from './route';

const post = (body: unknown) => POST(new Request('http://x/api/meta-ads/drafts', { method: 'POST', body: JSON.stringify(body) }));
const valid = {
  action: 'create', adAccountId: '555', kind: 'whatsapp', name: 'Diwali', dailyBudgetMinor: 50000, countries: ['IN'],
  primaryText: 'Chat with us', imageHash: 'abcdef0123456789abcdef0123456789',
};
const ID = '33333333-3333-4333-8333-333333333333';

beforeEach(() => {
  Object.assign(h, { enabled: true, mutationOk: true, sessions: 0, calls: [] });
  __resetRateLimitForTests();
});

it('answers 503 before any session work while disabled', async () => {
  h.enabled = false;
  expect((await GET(new Request('http://x/api/meta-ads/drafts'))).status).toBe(503);
  expect((await post(valid)).status).toBe(503);
  expect(h.sessions).toBe(0);
});

it('lists drafts for any member', async () => {
  const res = await GET(new Request('http://x/api/meta-ads/drafts'));
  expect(await res.json()).toEqual({ drafts: [{ id: 'd1' }] });
});

it('checks the mutation origin before anything else', async () => {
  h.mutationOk = false;
  expect((await post(valid)).status).toBe(401);
  expect(h.calls).toEqual([]);
});

it('validates the request and queues a create (202)', async () => {
  expect((await post({ ...valid, dailyBudgetMinor: -1 })).status).toBe(400);
  expect((await post({ ...valid, action: 'launch' })).status).toBe(400);
  expect((await post(null)).status).toBe(400);
  const res = await post(valid);
  expect(res.status).toBe(202);
  expect(h.calls).toHaveLength(1);
  expect(h.calls[0][2]).toMatchObject({ adAccountId: '555', kind: 'whatsapp', countries: ['IN'], publish: false });
});

it('routes re-check and discard by id; a malformed id never reaches the library', async () => {
  expect((await post({ action: 'recheck', id: "1' or 1=1" })).status).toBe(400);
  expect((await post({ action: 'recheck', id: ID })).status).toBe(404);
  const res = await post({ action: 'discard', id: ID });
  expect(await res.json()).toEqual({ draft: { id: ID, status: 'discarded' } });
  expect(h.calls.map((c) => c[0])).toEqual(['recheck', 'discard']);
});
