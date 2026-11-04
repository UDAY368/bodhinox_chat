import { beforeEach, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  role: 'admin',
  mutationOk: true,
  created: [] as unknown[],
  revoked: [] as unknown[],
  fail: null as unknown,
}));

vi.mock('@/lib/auth/session', () => ({
  requireSession: async () => ({ userId: '22222222-2222-4222-8222-222222222222', accountId: '11111111-1111-4111-8111-111111111111',
    role: h.role, sessionId: 's' }),
  assertMutation: async () => {
    if (!h.mutationOk) {
      const { UnauthorizedError } = await import('@/lib/auth/errors');
      throw new UnauthorizedError();
    }
  },
}));
vi.mock('@/lib/analytics/report-shares', async (original) => ({
  ...(await original<typeof import('@/lib/analytics/report-shares')>()),
  listShares: async () => [{ id: 'sh1' }],
  createShare: async (_actor: unknown, id: string, input: unknown) => {
    if (h.fail) throw h.fail;
    h.created.push({ id, input });
    return { id: 'sh2', url: null };
  },
  revokeShare: async (_actor: unknown, id: string, shareId: string) => {
    if (h.fail) throw h.fail;
    h.revoked.push({ id, shareId });
  },
}));

import { ShareError } from '@/lib/analytics/report-shares';
import { __resetRateLimitForTests } from '@/lib/rate-limit';
import { GET, POST } from './route';
import { DELETE } from './[shareId]/route';

const R = '33333333-3333-4333-8333-333333333333';
const S = '44444444-4444-4444-8444-444444444444';
const ctx = { params: Promise.resolve({ id: R }) };
const post = (body: unknown) => POST(new Request(`http://x/api/analytics/reports/${R}/shares`, { method: 'POST', body: JSON.stringify(body) }), ctx);
const del = () => DELETE(new Request(`http://x/api/analytics/reports/${R}/shares/${S}`, { method: 'DELETE' }),
  { params: Promise.resolve({ id: R, shareId: S }) });

beforeEach(() => {
  Object.assign(h, { role: 'admin', mutationOk: true, created: [], revoked: [], fail: null });
  __resetRateLimitForTests();
});

it('lists and creates shares for admins, mapping the body', async () => {
  const list = await GET(new Request(`http://x/api/analytics/reports/${R}/shares`), ctx);
  expect(list.status).toBe(200);
  expect(list.headers.get('cache-control')).toBe('private, no-store');
  const res = await post({ min_role: 'viewer', expires_in_hours: 24 });
  expect(res.status).toBe(201);
  expect(h.created).toEqual([{ id: R, input: { minRole: 'viewer', expiresInHours: 24 } }]);
});

it('refuses agents and viewers, and failed CSRF, before creating or revoking', async () => {
  h.role = 'agent';
  expect((await GET(new Request(`http://x/api/analytics/reports/${R}/shares`), ctx)).status).toBe(403);
  expect((await post({ min_role: 'viewer', expires_in_hours: 24 })).status).toBe(403);
  expect((await del()).status).toBe(403);
  h.role = 'admin';
  h.mutationOk = false;
  expect((await post({ min_role: 'viewer', expires_in_hours: 24 })).status).toBe(401);
  expect((await del()).status).toBe(401);
  expect(h.created).toEqual([]);
  expect(h.revoked).toEqual([]);
});

it('maps share errors to 400, 404 and 409', async () => {
  h.fail = new ShareError('role_too_low', 400);
  expect((await post({ min_role: 'viewer', expires_in_hours: 24 })).status).toBe(400);
  h.fail = new ShareError('not_ready', 409);
  expect((await post({ min_role: 'agent', expires_in_hours: 24 })).status).toBe(409);
  h.fail = new ShareError('not_found', 404);
  expect((await post({ min_role: 'agent', expires_in_hours: 24 })).status).toBe(404);
  expect((await del()).status).toBe(404);
});

it('revokes', async () => {
  expect((await del()).status).toBe(204);
  expect(h.revoked).toEqual([{ id: R, shareId: S }]);
});
