import { beforeEach, expect, it, vi } from 'vitest';

const ACCOUNT = '11111111-1111-4111-8111-111111111111';
const SHARE = '44444444-4444-4444-8444-444444444444';
const h = vi.hoisted(() => ({
  session: null as null | { userId: string; accountId: string; role: string },
  peeked: [] as unknown[],
  fail: null as unknown,
}));

vi.mock('@/lib/auth/session', () => ({ resolveSession: async () => h.session }));
vi.mock('@/lib/analytics/report-shares', async (original) => ({
  ...(await original<typeof import('@/lib/analytics/report-shares')>()),
  peekShare: async (session: unknown, id: string) => {
    if (h.fail) throw h.fail;
    h.peeked.push({ session, id });
    return { kind: 'campaign_summary', format: 'pdf', expiresAt: '2026-11-10T00:00:00.000Z' };
  },
}));

import { ShareError } from '@/lib/analytics/report-shares';
import { __resetRateLimitForTests } from '@/lib/rate-limit';
import { GET } from './route';

const get = (id = SHARE) => GET(new Request(`http://app.test/api/reports/shared/${id}/info`), { params: Promise.resolve({ shareId: id }) });

beforeEach(() => {
  h.session = { userId: '22222222-2222-4222-8222-222222222222', accountId: ACCOUNT, role: 'viewer' };
  h.peeked = [];
  h.fail = null;
  __resetRateLimitForTests();
});

it('needs a session and peeks nothing without one', async () => {
  h.session = null;
  const res = await get();
  expect(res.status).toBe(401);
  expect(h.peeked).toEqual([]);
});

it('returns the kind, format and expiry for the live session, privately', async () => {
  const res = await get();
  expect(res.status).toBe(200);
  expect(res.headers.get('cache-control')).toBe('private, no-store');
  expect(await res.json()).toEqual({ share: { kind: 'campaign_summary', format: 'pdf', expiresAt: '2026-11-10T00:00:00.000Z' } });
  expect(h.peeked).toEqual([{ session: h.session, id: SHARE }]);
});

it('answers every refusal with the same 404 and no detail', async () => {
  h.fail = new ShareError('not_found', 404);
  const res = await get();
  expect(res.status).toBe(404);
  const body = await res.json();
  expect(Object.keys(body)).toEqual(['error']);
});
