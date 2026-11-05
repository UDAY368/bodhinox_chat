import { beforeEach, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  email: 'ops@bodhinox.test',
  mutationOk: true,
  writes: [] as unknown[],
  listed: [] as unknown[],
  audits: [] as unknown[],
  mfa: 'ok' as 'ok' | 'step_up',
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
// The real guard, with the session, MFA state and audit trail faked.
vi.mock('@/lib/db/prisma', () => ({
  platformDatabaseConfigured: () => false,
  getAuthPrisma: () => ({
    $queryRaw: async () => [{ factor: true, mfa_verified_at: h.mfa === 'ok' ? new Date() : new Date(Date.now() - 13 * 3_600_000) }],
  }),
}));
vi.mock('@/lib/platform/audit', () => ({
  hashRequestIp: () => null,
  recordPlatformAudit: async (entry: unknown, via: string) => {
    h.audits.push({ entry, via });
    return 'audit-id';
  },
}));
vi.mock('@/lib/analytics/rate-card', async (original) => ({
  ...(await original<typeof import('@/lib/analytics/rate-card')>()),
  listRateCards: async (filter: unknown) => {
    h.listed.push(filter);
    return [{ category: 'marketing', countryCode: 'IN', currency: 'USD', priceMinor: 1.07 }];
  },
  // The audit entry travels into the upsert's own transaction.
  upsertRateCards: async (cards: unknown[], audit: unknown) => {
    h.writes.push(...cards);
    if (audit) h.audits.push({ entry: audit, via: 'same-transaction' });
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
  h.audits = [];
  h.mfa = 'ok';
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

it('asks a platform admin without a recent MFA check to step up, and audits each write', async () => {
  h.mfa = 'step_up';
  const refused = await put({ cards: [{ category: 'marketing', country_code: 'IN', currency: 'USD', price_minor: 1 }] });
  expect(refused.status).toBe(403);
  expect((await refused.json()).code).toBe('mfa_step_up_required');
  expect(h.writes).toEqual([]);
  h.mfa = 'ok';
  expect((await put({ cards: [{ category: 'marketing', country_code: 'IN', currency: 'USD', price_minor: 1 }] })).status).toBe(200);
  expect(h.audits).toEqual([{ via: 'same-transaction', entry: expect.objectContaining({ adminEmail: 'ops@bodhinox.test', action: 'analytics.rate_cards_updated',
    detail: { rows: 1, removed: 0 } }) }]);
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
