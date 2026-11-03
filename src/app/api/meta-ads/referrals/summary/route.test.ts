import { expect, it, vi } from 'vitest';

vi.mock('@/lib/auth/session', () => ({
  requireSession: async () => ({ userId: '22222222-2222-4222-8222-222222222222', accountId: '11111111-1111-4111-8111-111111111111', role: 'viewer', sessionId: 's' }),
}));
vi.mock('@/lib/meta-ads/config', () => ({ metaAdsConfig: () => null }));
vi.mock('@/lib/meta-ads/insights', () => ({ countAdStartedConversations: async (_a: unknown, days: number) => (days === 30 ? 7 : -1) }));

import { GET } from './route';

it('counts ad-started conversations from stored referrals even while Meta ads are off', async () => {
  const res = await GET(new Request('http://x/api/meta-ads/referrals/summary'));
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ conversations: 7, days: 30 });
});
