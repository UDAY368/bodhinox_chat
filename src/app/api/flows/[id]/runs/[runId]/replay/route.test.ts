import { beforeEach, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  mutation: vi.fn(async () => {}),
  permission: vi.fn<(...args: unknown[]) => Promise<void>>(async () => {}),
  replay: vi.fn(),
  user: 'u-1',
}));

class Forbidden extends Error {
  status = 403;
}
vi.mock('@/lib/auth/session', () => ({
  requireSession: async () => ({ accountId: 'account-a', userId: h.user, role: 'admin', sessionId: 's' }),
  assertMutation: h.mutation,
}));
vi.mock('@/lib/auth/account', () => ({
  requireRole: async () => ({ accountId: 'account-a', userId: h.user, role: 'admin' }),
  toErrorResponse: (err: unknown) => Response.json({ error: 'x' }, { status: err instanceof Forbidden ? 403 : 500 }),
}));
vi.mock('@/lib/auth/permissions', () => ({ requirePermission: h.permission }));
vi.mock('@/lib/audience/http', () => ({ tenantOf: (c: unknown) => c }));
vi.mock('@/lib/db/tenant', () => ({ withTenant: async (_t: unknown, fn: (tx: unknown) => unknown) => fn({}) }));
vi.mock('@/lib/flows/replay', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/flows/replay')>()),
  replayFlowRun: h.replay,
}));

import { ReplayError } from '@/lib/flows/replay';
import { POST } from './route';

const FLOW = '11111111-1111-4111-8111-111111111111';
const RUN = '44444444-4444-4444-8444-444444444444';
const ctx = (id = FLOW, runId = RUN) => ({ params: Promise.resolve({ id, runId }) });
const req = () => new Request('http://localhost/', { method: 'POST', body: '{}' });

let n = 0;
beforeEach(() => {
  h.user = `u-${++n}`;
  for (const fn of [h.mutation, h.permission, h.replay]) fn.mockReset();
  h.permission.mockResolvedValue(undefined);
  h.replay.mockResolvedValue({ run_id: RUN, node_key: 'hello', seq: 4 });
});

it('queues the replay (202) behind CSRF and the flows.replay permission', async () => {
  const res = await POST(req(), ctx());
  expect(res.status).toBe(202);
  expect(await res.json()).toEqual({ replay: { run_id: RUN, node_key: 'hello', seq: 4 } });
  expect(h.permission).toHaveBeenCalledWith(expect.anything(), 'flows.replay');
  expect(h.replay).toHaveBeenCalledWith({}, { accountId: 'account-a', flowId: FLOW, runId: RUN, userId: h.user });

  h.mutation.mockRejectedValueOnce(new Forbidden());
  expect((await POST(req(), ctx())).status).toBe(403);
  h.permission.mockRejectedValueOnce(new Forbidden());
  expect((await POST(req(), ctx())).status).toBe(403);
  expect(h.replay).toHaveBeenCalledTimes(1);
});

it('maps every refusal to 409 with its reason, and a missing run to 404', async () => {
  expect((await POST(req(), ctx(FLOW, 'nope'))).status).toBe(404);
  h.replay.mockRejectedValueOnce(new ReplayError('not_found'));
  expect((await POST(req(), ctx())).status).toBe(404);
  for (const reason of ['needs_reconciliation', 'already_sent', 'not_replayable_reason', 'conversation_busy', 'too_old'] as const) {
    h.replay.mockRejectedValueOnce(new ReplayError(reason));
    const res = await POST(req(), ctx());
    expect(res.status).toBe(409);
    expect((await res.json()).reason).toBe(reason);
  }
});

it('maps a concurrent active run (23505) to conversation_busy', async () => {
  h.replay.mockRejectedValueOnce(Object.assign(new Error('unique'), { code: 'P2010', meta: { code: '23505' } }));
  const res = await POST(req(), ctx());
  expect(res.status).toBe(409);
  expect((await res.json()).reason).toBe('conversation_busy');
});

it('rate-limits replays per member', async () => {
  const codes: number[] = [];
  for (let i = 0; i < 11; i += 1) codes.push((await POST(req(), ctx())).status);
  expect(codes.slice(0, 10).every((c) => c === 202)).toBe(true);
  expect(codes[10]).toBe(429);
});
