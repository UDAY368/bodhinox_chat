import { beforeEach, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  role: 'admin',
  mutationOk: true,
  requests: [] as unknown[],
  fail: null as unknown,
}));

vi.mock('@/lib/auth/session', () => ({
  requireSession: async () => ({ userId: '22222222-2222-4222-8222-222222222222', accountId: '11111111-1111-4111-8111-111111111111',
    role: h.role, sessionId: 's', user: { id: 'u', email: 'a@b.test', user_metadata: { full_name: 'A' } } }),
  assertMutation: async () => {
    if (!h.mutationOk) {
      const { UnauthorizedError } = await import('@/lib/auth/errors');
      throw new UnauthorizedError();
    }
  },
}));
vi.mock('@/lib/analytics/reports', async (original) => ({
  ...(await original<typeof import('@/lib/analytics/reports')>()),
  listReports: async () => [{ id: 'r1', status: 'ready' }],
  requestReport: async (_actor: unknown, input: unknown) => {
    if (h.fail) throw h.fail;
    h.requests.push(input);
    return { id: 'r2', status: 'queued' };
  },
}));

import { AnalyticsRangeError } from '@/lib/analytics/range';
import { ReportError } from '@/lib/analytics/reports';
import { __resetRateLimitForTests } from '@/lib/rate-limit';
import { GET, POST } from './route';

const post = (body: unknown) => POST(new Request('http://x/api/analytics/reports', { method: 'POST', body: JSON.stringify(body) }));

beforeEach(() => {
  h.role = 'admin';
  h.mutationOk = true;
  h.requests = [];
  h.fail = null;
  __resetRateLimitForTests();
});

it('lists reports for admins and refuses agents', async () => {
  const res = await GET(new Request('http://x/api/analytics/reports'));
  expect(res.status).toBe(200);
  expect((await res.json()).reports).toHaveLength(1);
  h.role = 'agent';
  expect((await GET(new Request('http://x/api/analytics/reports'))).status).toBe(403);
});

it('queues a report and acknowledges with 202', async () => {
  const res = await post({ kind: 'campaign_daily', preset: 'custom', from: '2026-10-01', to: '2026-10-07', email: true });
  expect(res.status).toBe(202);
  expect((await res.json()).report.id).toBe('r2');
  expect(h.requests).toEqual([{ kind: 'campaign_daily', range: { preset: 'custom', from: '2026-10-01', to: '2026-10-07' }, email: true }]);
});

it('checks the mutation origin and role before queueing', async () => {
  h.mutationOk = false;
  expect((await post({ kind: 'campaign_daily' })).status).toBe(401);
  h.mutationOk = true;
  h.role = 'viewer';
  expect((await post({ kind: 'campaign_daily' })).status).toBe(403);
  expect(h.requests).toEqual([]);
});

it('maps invalid input and the pending cap to 400 and 429', async () => {
  expect((await post({ kind: 'campaign_daily', email: 'yes' })).status).toBe(400);
  expect((await POST(new Request('http://x/api/analytics/reports', { method: 'POST', body: 'nope' }))).status).toBe(400);
  h.fail = new ReportError('invalid_kind', 400);
  expect((await post({ kind: 'messages' })).status).toBe(400);
  h.fail = new AnalyticsRangeError('Invalid date');
  expect((await post({ kind: 'campaign_daily', preset: 'custom', from: 'x', to: 'y' })).status).toBe(400);
  h.fail = new ReportError('too_many_pending', 429);
  expect((await post({ kind: 'campaign_daily' })).status).toBe(429);
});

it('rate limits requests per member', async () => {
  for (let i = 0; i < 10; i++) expect((await post({ kind: 'campaign_daily' })).status).toBe(202);
  expect((await post({ kind: 'campaign_daily' })).status).toBe(429);
});
