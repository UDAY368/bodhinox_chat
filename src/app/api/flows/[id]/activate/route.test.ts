import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  role: 'agent',
  mutation: vi.fn(async () => {}),
  permission: vi.fn<(...args: unknown[]) => Promise<void>>(async () => {}),
  caps: vi.fn(async () => ({ payments: false })),
  publish: vi.fn(),
  pause: vi.fn(),
  archive: vi.fn(),
  draft: vi.fn(),
}));

class Forbidden extends Error {
  status = 403;
}
vi.mock('@/lib/auth/session', () => ({
  requireSession: async () => ({ accountId: 'account-a', userId: 'author', role: h.role, sessionId: 's' }),
  assertMutation: h.mutation,
}));
vi.mock('@/lib/auth/account', () => ({
  requireRole: async () => ({ accountId: 'account-a', userId: 'author', role: h.role }),
  toErrorResponse: (err: unknown) => err instanceof Forbidden
    ? Response.json({ error: 'Forbidden' }, { status: 403 })
    : Response.json({ error: 'Internal server error' }, { status: 500 }),
}));
vi.mock('@/lib/auth/permissions', () => ({ requirePermission: h.permission }));
vi.mock('@/lib/audience/http', () => ({ tenantOf: (c: { accountId: string; userId: string; role: string }) => c }));
vi.mock('@/lib/db/tenant', () => ({ withTenant: async (_t: unknown, fn: (tx: unknown) => unknown) => fn({}) }));
vi.mock('@/lib/flows/capabilities', () => ({ loadWorkspaceCapabilities: h.caps }));
vi.mock('@/lib/flows/versions', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/flows/versions')>()),
  publishFlow: h.publish,
  pauseFlow: h.pause,
  archiveFlow: h.archive,
  moveToDraft: h.draft,
}));

import { FlowVersionError } from '@/lib/flows/versions';
import { POST } from './route';

const FLOW = '11111111-1111-4111-8111-111111111111';
const HASH = 'b'.repeat(64);
const call = (body: unknown, id = FLOW) =>
  POST(new Request('http://localhost/', { method: 'POST', body: JSON.stringify(body) }), { params: Promise.resolve({ id }) });

beforeEach(() => {
  h.role = 'agent';
  for (const fn of [h.mutation, h.permission, h.caps, h.publish, h.pause, h.archive, h.draft]) fn.mockReset();
  h.permission.mockResolvedValue(undefined);
  h.caps.mockResolvedValue({ payments: false });
  h.publish.mockResolvedValue({ flow: { id: FLOW, status: 'active' }, version: { id: 'v', version: 2 }, reused: false });
  h.pause.mockResolvedValue({ flow: { id: FLOW, status: 'paused' }, cancelled: 0 });
  h.archive.mockResolvedValue({ flow: { id: FLOW, status: 'archived' }, cancelled: 0 });
  h.draft.mockResolvedValue({ flow: { id: FLOW, status: 'draft' }, paused: false });
});

describe('POST /api/flows/[id]/activate', () => {
  it('refuses a request that fails the Origin/CSRF check before anything else', async () => {
    h.mutation.mockRejectedValueOnce(new Forbidden());
    expect((await call({ status: 'active' })).status).toBe(403);
    expect(h.publish).not.toHaveBeenCalled();
  });

  it('rejects malformed bodies and ids', async () => {
    for (const body of [{}, { status: 'live' }, { status: 'paused', cancel_active: 'yes' }, { status: 'active', draft_hash: 'short' }]) {
      expect((await call(body)).status).toBe(400);
    }
    expect((await call({ status: 'active' }, 'flow-a')).status).toBe(404);
    expect(h.publish).not.toHaveBeenCalled();
  });

  it('publishes with the draft hash and the workspace capabilities, behind flows.publish', async () => {
    const res = await call({ status: 'active', draft_hash: HASH });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ version: { version: 2 } });
    expect(h.permission).toHaveBeenCalledWith(expect.objectContaining({ accountId: 'account-a' }), 'flows.publish');
    expect(h.publish).toHaveBeenCalledWith({}, expect.objectContaining({
      accountId: 'account-a', flowId: FLOW, userId: 'author', expectedDraftHash: HASH, caps: { payments: false },
    }));
  });

  it('refuses publishing when the role lost flows.publish', async () => {
    h.permission.mockRejectedValueOnce(new Forbidden());
    expect((await call({ status: 'active' })).status).toBe(403);
    expect(h.publish).not.toHaveBeenCalled();
  });

  it('answers the publish refusals with their own status and payload', async () => {
    h.publish.mockRejectedValueOnce(new FlowVersionError('draft_changed', 409, { draft_hash: HASH }));
    const changed = await call({ status: 'active', draft_hash: 'c'.repeat(64) });
    expect(changed.status).toBe(409);
    expect(await changed.json()).toMatchObject({ draft_hash: HASH });

    const issues = [{ severity: 'error', scope: 'flow', code: 'crossFlowLoop', message: 'loop' }];
    h.publish.mockRejectedValueOnce(new FlowVersionError('invalid', 422, { issues }));
    const invalid = await call({ status: 'active' });
    expect(invalid.status).toBe(422);
    expect(await invalid.json()).toMatchObject({ issues });
  });

  it('pauses without cancelling for any agent, and needs flows.publish to cancel runs', async () => {
    expect((await call({ status: 'paused' })).status).toBe(200);
    expect(h.pause).toHaveBeenCalledWith({}, expect.objectContaining({ cancelActive: false }));
    expect(h.permission).not.toHaveBeenCalled();

    h.permission.mockRejectedValueOnce(new Forbidden());
    expect((await call({ status: 'paused', cancel_active: true })).status).toBe(403);
    expect(h.pause).toHaveBeenCalledTimes(1);

    expect((await call({ status: 'paused', cancel_active: true })).status).toBe(200);
    expect(h.pause).toHaveBeenLastCalledWith({}, expect.objectContaining({ cancelActive: true }));

    h.pause.mockRejectedValueOnce(new FlowVersionError('not_published', 409));
    expect((await call({ status: 'paused' })).status).toBe(409);
  });

  it('refuses to archive over runs in progress unless they are cancelled', async () => {
    h.archive.mockRejectedValueOnce(new FlowVersionError('active_runs', 409, { active_runs: 3 }));
    const busy = await call({ status: 'archived' });
    expect(busy.status).toBe(409);
    expect(await busy.json()).toMatchObject({ active_runs: 3 });
    expect((await call({ status: 'archived', cancel_active: true })).status).toBe(200);
    expect(h.archive).toHaveBeenLastCalledWith({}, expect.objectContaining({ cancelActive: true }));
  });

  it('sends the old "draft" request through moveToDraft (a published flow is paused there)', async () => {
    h.draft.mockResolvedValueOnce({ flow: { id: FLOW, status: 'paused' }, paused: true });
    const res = await call({ status: 'draft' });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ flow: { status: 'paused' }, paused: true });
  });

  it('never leaks an unexpected error message', async () => {
    h.publish.mockRejectedValueOnce(new Error('relation "flow_versions" secret detail'));
    const res = await call({ status: 'active' });
    expect(res.status).toBe(500);
    expect(JSON.stringify(await res.json())).not.toContain('secret detail');
  });
});
