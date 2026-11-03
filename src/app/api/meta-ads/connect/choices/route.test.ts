import { beforeEach, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ enabled: true, role: 'admin', sessions: 0, calls: 0 }));

vi.mock('@/lib/auth/session', () => ({
  requireSession: async () => {
    h.sessions++;
    return { userId: '22222222-2222-4222-8222-222222222222', accountId: '11111111-1111-4111-8111-111111111111', role: h.role, sessionId: 's' };
  },
}));
vi.mock('@/lib/meta-ads/config', () => ({ metaAdsConfig: () => (h.enabled ? { appId: '1' } : null) }));
vi.mock('@/lib/meta-ads/connection', async (original) => ({
  ...(await original<typeof import('@/lib/meta-ads/connection')>()),
  listChoices: async () => {
    h.calls++;
    return { adAccounts: [{ id: '111', name: 'A', currency: 'INR' }], pages: [{ id: '222', name: 'P' }] };
  },
}));

import { __resetRateLimitForTests } from '@/lib/rate-limit';
import { GET } from './route';

const get = () => GET(new Request('http://x/api/meta-ads/connect/choices'));

beforeEach(() => {
  Object.assign(h, { enabled: true, role: 'admin', sessions: 0, calls: 0 });
  __resetRateLimitForTests();
});

it('answers 503 while disabled and 403 below admin', async () => {
  h.enabled = false;
  expect((await get()).status).toBe(503);
  expect(h.sessions).toBe(0);
  h.enabled = true;
  h.role = 'agent';
  expect((await get()).status).toBe(403);
  expect(h.calls).toBe(0);
});

it('returns ids and names only', async () => {
  const body = await (await get()).json();
  expect(body.pages).toEqual([{ id: '222', name: 'P' }]);
  expect(JSON.stringify(body)).not.toMatch(/token/i);
});
