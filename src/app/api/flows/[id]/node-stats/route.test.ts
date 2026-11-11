// GET /api/flows/[id]/node-stats (Stage 5): any member, this workspace's flow
// only, counts only. The SQL and RLS are proven in
// src/lib/flows/stage5-engine.integration.test.ts.
import { beforeEach, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  account: 'account-a',
  roleError: null as Error | null,
  roles: [] as string[],
}));

class Unauthorized extends Error {
  status = 401;
}
vi.mock('@/lib/auth/account', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth/account')>()),
  requireRole: async (role: string) => {
    h.roles.push(role);
    if (h.roleError) throw h.roleError;
    return { accountId: h.account, userId: 'viewer-1', role: 'viewer' };
  },
  toErrorResponse: (err: unknown) => Response.json({ error: 'x' }, { status: err instanceof Unauthorized ? 401 : 500 }),
}));
vi.mock('@/lib/audience/http', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/audience/http')>()),
  tenantOf: (c: unknown) => c,
}));
vi.mock('@/lib/db/tenant', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/db/tenant')>()),
  withTenant: async (_t: unknown, fn: (tx: unknown) => unknown) => fn({}),
}));
vi.mock('@/lib/flows/versions', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/flows/versions')>()),
  // RLS and the account filter: another workspace's flow reads as missing.
  readNodeStats: async (_tx: unknown, accountId: string, flowId: string) =>
    (accountId === 'account-a' && flowId === FLOW ? { wait: { waiting: 3, passed: 7 } } : null),
}));

import { GET } from './route';

const FLOW = '11111111-1111-4111-8111-111111111111';
const get = (id: string) => GET(new Request('http://localhost/'), { params: Promise.resolve({ id }) });

beforeEach(() => {
  h.account = 'account-a';
  h.roleError = null;
  h.roles = [];
});

it('returns waiting and passed counts per step to any member, uncached', async () => {
  const res = await get(FLOW);
  expect(res.status).toBe(200);
  expect(res.headers.get('Cache-Control')).toBe('private, no-store');
  expect(await res.json()).toEqual({ stats: { wait: { waiting: 3, passed: 7 } } });
  expect(h.roles).toEqual(['viewer']);
});

it('answers 404 for another workspace or a malformed id, and 401 without a session', async () => {
  expect((await get('nope')).status).toBe(404);
  h.account = 'account-b';
  expect((await get(FLOW)).status).toBe(404);
  h.roleError = new Unauthorized();
  expect((await get(FLOW)).status).toBe(401);
});
