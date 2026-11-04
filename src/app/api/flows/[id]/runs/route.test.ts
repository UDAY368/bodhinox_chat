import { beforeEach, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  session: vi.fn(async () => ({ accountId: 'account-a', userId: 'u-1', role: 'viewer', sessionId: 's' })),
  role: vi.fn(async () => ({ accountId: 'account-a', userId: 'u-1', role: 'viewer' })),
  mask: vi.fn(async () => true),
  flow: vi.fn(),
  list: vi.fn(),
  run: vi.fn(),
  intents: vi.fn(),
  replayable: vi.fn(),
  can: vi.fn(async () => false),
}));

class Unauthorized extends Error {
  status = 401;
}
vi.mock('@/lib/auth/session', () => ({ requireSession: h.session }));
vi.mock('@/lib/auth/account', () => ({
  requireRole: h.role,
  toErrorResponse: (err: unknown) => Response.json({ error: 'x' }, { status: err instanceof Unauthorized ? 401 : 500 }),
}));
vi.mock('@/lib/auth/permissions', () => ({ can: h.can }));
vi.mock('@/lib/audience/http', () => ({ tenantOf: (c: unknown) => c }));
vi.mock('@/lib/db/tenant', () => ({ withTenant: async (_t: unknown, fn: (tx: unknown) => unknown) => fn({}) }));
vi.mock('@/lib/inbox/masking-apply', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/inbox/masking-apply')>()),
  loadPhoneMask: h.mask,
}));
vi.mock('@/lib/flows/run-inspection', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/flows/run-inspection')>()),
  readFlowSummary: h.flow,
  listRuns: h.list,
  readRunRow: h.run,
  readRunEvents: async () => [],
  readVersionNumbers: async () => [{ id: 'v', version: 2 }],
}));
vi.mock('@/lib/flows/replay', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/flows/replay')>()),
  readRunIntents: h.intents,
  inspectReplayable: h.replayable,
}));

import { GET as list } from './route';
import { GET as detail } from './[runId]/route';

const FLOW = '11111111-1111-4111-8111-111111111111';
const RUN = '44444444-4444-4444-8444-444444444444';
const row = { id: RUN, status: 'failed', cursor_at: '2026-11-04T10:00:00.000000Z', version: 2,
  contact: { id: 'c', name: 'Asha', phone: '+919876543210' } };

beforeEach(() => {
  for (const fn of [h.flow, h.list, h.run, h.intents, h.replayable]) fn.mockReset();
  h.flow.mockResolvedValue({ id: FLOW, name: 'Flow', status: 'active' });
  h.list.mockResolvedValue({ runs: [row], next_cursor: null });
  h.run.mockResolvedValue(row);
  h.intents.mockResolvedValue([{ kind: 'flow', node_key: 'hello', seq: 1, attempt: 0, part: null, status: 'unknown', last_error: 'x', updated_at: 'now' }]);
  h.replayable.mockResolvedValue({ replayable: { ok: false, reason: 'needs_reconciliation' }, failedNode: 'hello' });
});

it('lists a page of runs with filters, masks the number and hides the cursor column', async () => {
  const res = await list(new Request(`http://localhost/api/flows/${FLOW}/runs?status=failed&version=none`), { params: Promise.resolve({ id: FLOW }) });
  expect(res.status).toBe(200);
  const json = await res.json();
  expect(h.list).toHaveBeenCalledWith({}, 'account-a', FLOW, { status: 'failed', version: 'none' });
  expect(json.runs[0].contact.phone).not.toBe('+919876543210');
  expect(json.runs[0]).not.toHaveProperty('cursor_at');
  expect(json.versions).toEqual([{ id: 'v', version: 2 }]);
});

it('requires a session, 400s a bad filter and 404s another workspace', async () => {
  h.session.mockRejectedValueOnce(new Unauthorized());
  expect((await list(new Request('http://localhost/x'), { params: Promise.resolve({ id: FLOW }) })).status).toBe(401);
  expect((await list(new Request('http://localhost/x?status=nope'), { params: Promise.resolve({ id: FLOW }) })).status).toBe(400);
  h.flow.mockResolvedValueOnce(null);
  expect((await list(new Request('http://localhost/x'), { params: Promise.resolve({ id: FLOW }) })).status).toBe(404);
  expect(h.list).not.toHaveBeenCalled();
});

it('shows one run with intent states, replay eligibility and the caller\'s rights', async () => {
  const res = await detail(new Request('http://localhost/x'), { params: Promise.resolve({ id: FLOW, runId: RUN }) });
  expect(res.status).toBe(200);
  const json = await res.json();
  expect(json.intents[0]).toEqual(expect.objectContaining({ status: 'unknown' }));
  expect(json.intents[0]).not.toHaveProperty('result');
  expect(json.replayable).toEqual({ ok: false, reason: 'needs_reconciliation' });
  expect(json.can).toEqual({ replay: false, cancel: false });
  expect(json.run.contact.phone).not.toBe('+919876543210');

  h.run.mockResolvedValueOnce(null);
  expect((await detail(new Request('http://localhost/x'), { params: Promise.resolve({ id: FLOW, runId: RUN }) })).status).toBe(404);
  expect((await detail(new Request('http://localhost/x'), { params: Promise.resolve({ id: FLOW, runId: 'x' }) })).status).toBe(404);
});
