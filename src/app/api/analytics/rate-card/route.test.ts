import { beforeEach, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ email: 'ops@bodhinox.test', writes: [] as unknown[] }));

vi.mock('@/lib/auth/session', () => ({
  requireSession: async () => ({ userId: '22222222-2222-4222-8222-222222222222', accountId: '11111111-1111-4111-8111-111111111111',
    role: 'owner', sessionId: 's', user: { id: 'u', email: h.email } }),
  assertMutation: async () => undefined,
}));
// The shared PUT runs requirePlatformAdmin: a verified factor and a recent MFA check, then audits.
vi.mock('@/lib/db/prisma', () => ({
  platformDatabaseConfigured: () => false,
  getAuthPrisma: () => ({ $queryRaw: async () => [{ factor: true, mfa_verified_at: new Date() }] }),
}));
vi.mock('@/lib/platform/audit', () => ({ hashRequestIp: () => null, recordPlatformAudit: async () => 'audit-id' }));
vi.mock('@/lib/analytics/rate-card', async (original) => ({
  ...(await original<typeof import('@/lib/analytics/rate-card')>()),
  listRateCards: async () => [{ category: 'marketing', countryCode: 'IN', currency: 'INR', priceMinor: 78.46 }],
  upsertRateCards: async (cards: unknown[]) => { h.writes.push(...cards); return cards.length; },
}));

import { GET, PUT } from './route';

beforeEach(() => {
  process.env.PLATFORM_ADMIN_EMAILS = 'ops@bodhinox.test';
  h.email = 'ops@bodhinox.test';
  h.writes = [];
});

it('tells the editor whether the viewer is a platform admin', async () => {
  expect(await (await GET(new Request('http://x/api/analytics/rate-card'))).json()).toMatchObject({ canEdit: true, cards: [{ countryCode: 'IN' }] });
  h.email = 'owner@customer.test';
  expect((await (await GET(new Request('http://x/api/analytics/rate-card'))).json()).canEdit).toBe(false);
});

it('lets only platform admins write', async () => {
  const put = () => PUT(new Request('http://x/api/analytics/rate-card', { method: 'PUT',
    body: JSON.stringify({ cards: [{ category: 'marketing', country_code: 'IN', currency: 'INR', price_minor: 80 }] }) }));
  h.email = 'owner@customer.test';
  expect((await put()).status).toBe(403);
  expect(h.writes).toEqual([]);
  h.email = 'ops@bodhinox.test';
  expect((await put()).status).toBe(200);
  expect(h.writes).toHaveLength(1);
});
