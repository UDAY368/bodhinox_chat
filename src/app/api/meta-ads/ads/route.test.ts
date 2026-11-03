import { beforeEach, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ enabled: true, sessions: 0, queries: [] as unknown[] }));

vi.mock('@/lib/auth/session', () => ({
  requireSession: async () => {
    h.sessions++;
    return { userId: '22222222-2222-4222-8222-222222222222', accountId: '11111111-1111-4111-8111-111111111111', role: 'viewer', sessionId: 's' };
  },
}));
vi.mock('@/lib/meta-ads/config', () => ({ metaAdsConfig: () => (h.enabled ? { appId: '1' } : null) }));
vi.mock('@/lib/meta-ads/insights', async (original) => ({
  ...(await original<typeof import('@/lib/meta-ads/insights')>()),
  listAdsWithInsights: async (_a: unknown, query: unknown) => {
    h.queries.push(query);
    return { rows: [], insightsSyncedAt: null };
  },
}));

import { GET } from './route';

const get = (qs = '') => GET(new Request(`http://x/api/meta-ads/ads${qs}`));

beforeEach(() => Object.assign(h, { enabled: true, sessions: 0, queries: [] }));

it('answers 503 before reading anything while disabled', async () => {
  h.enabled = false;
  expect((await get()).status).toBe(503);
  expect(h.sessions).toBe(0);
});

it('lets any member read stored rows for a valid range', async () => {
  const res = await get('?level=ad&from=2026-10-01&to=2026-10-31');
  expect(res.status).toBe(200);
  expect(h.queries).toEqual([{ level: 'ad', from: '2026-10-01', to: '2026-10-31' }]);
});

it('rejects an invalid range or level', async () => {
  expect((await get('?level=adset')).status).toBe(400);
  expect((await get('?from=2026-10-31&to=2026-10-01')).status).toBe(400);
  expect(h.queries).toEqual([]);
});
