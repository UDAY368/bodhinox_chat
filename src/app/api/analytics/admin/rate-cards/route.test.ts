import { beforeEach, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  email: 'ops@bodhinox.test',
  mutationOk: true,
  writes: [] as unknown[],
  listed: [] as unknown[],
}));

vi.mock('@/lib/auth/session', () => ({
  requireSession: async () => ({ userId: '22222222-2222-4222-8222-222222222222', accountId: '11111111-1111-4111-8111-111111111111',
    role: 'owner', sessionId: 's', user: { id: 'u', email: h.email, user_metadata: { full_name: 'Ops' } } }),
  assertMutation: async () => {
    if (!h.mutationOk) {
      const { UnauthorizedError } = await import('@/lib/auth/errors');
      throw new UnauthorizedError();
    }
  },
}));
vi.mock('@/lib/analytics/rate-card', async (original) => ({
  ...(await original<typeof import('@/lib/analytics/rate-card')>()),
  listRateCards: async (filter: unknown) => {
    h.listed.push(filter);
    return [{ category: 'marketing', countryCode: 'IN', currency: 'USD', priceMinor: 1.07 }];
  },
  upsertRateCards: async (cards: unknown[]) => {
    h.writes.push(...cards);
    return cards.length;
  },
}));

import { GET, PUT } from './route';

const put = (body: unknown) => PUT(new Request('http://x/api/analytics/admin/rate-cards', { method: 'PUT', body: JSON.stringify(body) }));

beforeEach(() => {
  process.env.PLATFORM_ADMIN_EMAILS = 'ops@bodhinox.test';
  h.email = 'ops@bodhinox.test';
  h.mutationOk = true;
  h.writes = [];
  h.listed = [];
});

it('lets members read the rate card, filtered', async () => {
  const res = await GET(new Request('http://x/api/analytics/admin/rate-cards?category=marketing&currency=USD'));
  expect(res.status).toBe(200);
  expect((await res.json()).cards).toHaveLength(1);
  expect(h.listed).toEqual([{ category: 'marketing', currency: 'USD' }]);
  expect((await GET(new Request('http://x/api/analytics/admin/rate-cards?category=promo'))).status).toBe(400);
});

it('lets only platform admins write, after the mutation check', async () => {
  h.email = 'owner@customer.test';
  expect((await put({ cards: [{ category: 'marketing', country_code: 'IN', currency: 'USD', price_minor: 1 }] })).status).toBe(403);
  h.email = 'ops@bodhinox.test';
  h.mutationOk = false;
  expect((await put({ cards: [{ category: 'marketing', country_code: 'IN', currency: 'USD', price_minor: 1 }] })).status).toBe(401);
  expect(h.writes).toEqual([]);
});

it('validates every row before writing any', async () => {
  expect((await put({ cards: [] })).status).toBe(400);
  expect((await put({ cards: [{ category: 'marketing', country_code: 'IN', currency: 'USD', price_minor: 1 }, { category: 'x' }] })).status).toBe(400);
  expect((await put({ cards: Array(1001).fill({ category: 'marketing', country_code: 'IN', currency: 'USD', price_minor: 1 }) })).status).toBe(400);
  expect(h.writes).toEqual([]);
  const res = await put({ cards: [{ category: 'marketing', country_code: 'IN', currency: 'USD', price_minor: 1.07 },
    { category: 'utility', country_code: 'IN', currency: 'USD', price_minor: null }] });
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ updated: 2 });
  expect(h.writes).toEqual([{ category: 'marketing', countryCode: 'IN', currency: 'USD', priceMinor: 1.07 },
    { category: 'utility', countryCode: 'IN', currency: 'USD', priceMinor: null }]);
});
