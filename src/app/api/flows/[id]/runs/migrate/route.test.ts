import { beforeEach, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  mutation: vi.fn(async () => {}),
  permission: vi.fn<(...args: unknown[]) => Promise<void>>(async () => {}),
  migrate: vi.fn(),
  cancel: vi.fn(),
  user: 'u-1',
}));

class Forbidden extends Error {
  status = 403;
}
vi.mock('@/lib/auth/session', () => ({
  requireSession: async () => ({ accountId: 'account-a', userId: h.user, role: 'agent', sessionId: 's' }),
  assertMutation: h.mutation,
}));
vi.mock('@/lib/auth/account', () => ({
  requireRole: async () => ({ accountId: 'account-a', userId: h.user, role: 'agent' }),
  toErrorResponse: (err: unknown) => Response.json({ error: 'x' }, { status: err instanceof Forbidden ? 403 : 500 }),
}));
vi.mock('@/lib/auth/permissions', () => ({ requirePermission: h.permission }));
vi.mock('@/lib/audience/http', () => ({ tenantOf: (c: unknown) => c }));
vi.mock('@/lib/db/tenant', () => ({ withTenant: async (_t: unknown, fn: (tx: unknown) => unknown) => fn({}) }));
vi.mock('@/lib/flows/versions', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/flows/versions')>()),
  migrateRuns: h.migrate,
  cancelRuns: h.cancel,
}));

import { FlowVersionError } from '@/lib/flows/versions';
import { POST as migrate } from './route';
import { POST as cancel } from '../cancel/route';

const FLOW = '11111111-1111-4111-8111-111111111111';
const V1 = '33333333-3333-4333-8333-333333333333';
const RUN = '44444444-4444-4444-8444-444444444444';
const ctx = { params: Promise.resolve({ id: FLOW }) };
const req = (body: unknown) => new Request('http://localhost/', { method: 'POST', body: JSON.stringify(body) });

let n = 0;
beforeEach(() => {
  h.user = `u-${++n}`;
  for (const fn of [h.mutation, h.permission, h.migrate, h.cancel]) fn.mockReset();
  h.permission.mockResolvedValue(undefined);
  h.migrate.mockResolvedValue({ migrated: 2, left: [{ node_key: 'ask', count: 1 }], to_version: 2 });
  h.cancel.mockResolvedValue({ cancelled: 3 });
});

it('migrates the runs of one version, behind CSRF and flows.publish', async () => {
  const res = await migrate(req({ from_version_id: V1 }), ctx);
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ migrated: 2, left: [{ node_key: 'ask', count: 1 }], to_version: 2 });
  expect(h.migrate).toHaveBeenCalledWith({}, { accountId: 'account-a', flowId: FLOW, userId: h.user, fromVersionId: V1 });
  expect(h.permission).toHaveBeenCalledWith(expect.anything(), 'flows.publish');

  h.mutation.mockRejectedValueOnce(new Forbidden());
  expect((await migrate(req({ from_version_id: V1 }), ctx)).status).toBe(403);
  h.permission.mockRejectedValueOnce(new Forbidden());
  expect((await migrate(req({ from_version_id: V1 }), ctx)).status).toBe(403);
  expect(h.migrate).toHaveBeenCalledTimes(1);
});

it('validates the body and maps a missing version or nothing to migrate', async () => {
  expect((await migrate(req({ from_version_id: 'v1' }), ctx)).status).toBe(400);
  h.migrate.mockRejectedValueOnce(new FlowVersionError('not_found', 404));
  expect((await migrate(req({ from_version_id: V1 }), ctx)).status).toBe(404);
  h.migrate.mockRejectedValueOnce(new FlowVersionError('nothing_to_migrate', 409));
  expect((await migrate(req({ from_version_id: V1 }), ctx)).status).toBe(409);
});

it('rate-limits migration per member', async () => {
  const codes: number[] = [];
  for (let i = 0; i < 11; i += 1) codes.push((await migrate(req({ from_version_id: V1 }), ctx)).status);
  expect(codes.slice(0, 10).every((c) => c === 200)).toBe(true);
  expect(codes[10]).toBe(429);
});

it('cancels exactly one version or one run, never the whole flow', async () => {
  expect((await cancel(req({ version_id: V1 }), ctx)).status).toBe(200);
  expect(h.cancel).toHaveBeenLastCalledWith({}, expect.objectContaining({ versionId: V1, runId: undefined }));
  expect((await cancel(req({ run_id: RUN }), ctx)).status).toBe(200);
  expect(h.cancel).toHaveBeenLastCalledWith({}, expect.objectContaining({ runId: RUN, versionId: undefined }));
  for (const body of [{}, { version_id: V1, run_id: RUN }, { run_id: 'x' }]) {
    expect((await cancel(req(body), ctx)).status).toBe(400);
  }
  expect(h.cancel).toHaveBeenCalledTimes(2);
  h.permission.mockRejectedValueOnce(new Forbidden());
  expect((await cancel(req({ version_id: V1 }), ctx)).status).toBe(403);
});
