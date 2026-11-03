import { beforeEach, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ role: 'agent', mutationOk: true, estimate: vi.fn(), compare: vi.fn() }));

vi.mock('@/lib/auth/session', () => ({
  requireSession: async () => ({ userId: '22222222-2222-4222-8222-222222222222', accountId: '11111111-1111-4111-8111-111111111111',
    role: h.role, sessionId: 's', user: { id: 'u', email: 'a@example.test' } }),
  assertMutation: async () => {
    if (!h.mutationOk) {
      const { UnauthorizedError } = await import('@/lib/auth/errors');
      throw new UnauthorizedError();
    }
  },
}));
vi.mock('@/lib/analytics/campaign-cost', () => ({ estimateAudienceCost: h.estimate, campaignCostComparison: h.compare }));

import { GET, POST } from './route';

const post = (body: string) => POST(new Request('http://x/api/broadcasts/estimate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body }));

beforeEach(() => {
  h.role = 'agent';
  h.mutationOk = true;
  h.estimate.mockReset().mockResolvedValue({ recipients: 3, total: 10 });
  h.compare.mockReset().mockResolvedValue({ countries: [] });
});

it('estimates for agents, scoped to the session workspace', async () => {
  const res = await post(JSON.stringify({ templateId: 't', audience: { type: 'all' } }));
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ recipients: 3, total: 10 });
  expect(h.estimate).toHaveBeenCalledWith({ accountId: '11111111-1111-4111-8111-111111111111', userId: '22222222-2222-4222-8222-222222222222', role: 'agent' },
    { templateId: 't', audience: { type: 'all' } });
});

it('refuses viewers, failed mutation checks and bad JSON before counting', async () => {
  h.role = 'viewer';
  expect((await post('{}')).status).toBe(403);
  h.role = 'agent';
  h.mutationOk = false;
  expect((await post('{}')).status).toBe(401);
  h.mutationOk = true;
  expect((await post('{nope')).status).toBe(400);
  expect(h.estimate).not.toHaveBeenCalled();
});

it('compares a campaign for any member and 404s an unknown one', async () => {
  h.role = 'viewer';
  const res = await GET(new Request('http://x/api/broadcasts/estimate?broadcastId=b1&currency=USD'));
  expect(res.status).toBe(200);
  expect(h.compare).toHaveBeenCalledWith(expect.objectContaining({ accountId: '11111111-1111-4111-8111-111111111111' }), 'b1', 'USD');
  h.compare.mockResolvedValue(null);
  expect((await GET(new Request('http://x/api/broadcasts/estimate?broadcastId=b2'))).status).toBe(404);
});
