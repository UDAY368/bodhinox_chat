import { beforeEach, describe, expect, it, vi } from 'vitest';

const APPT = '33333333-3333-4333-8333-333333333333';

const h = vi.hoisted(() => ({
  role: 'agent' as string,
  mutationOk: true,
  permissionOk: true,
  exists: true,
  serviceError: null as unknown,
  calls: [] as { fn: string; ctx: unknown; id: string }[],
  audits: [] as unknown[][],
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
vi.mock('@/lib/auth/permissions', () => ({
  requirePermission: async () => {
    if (!h.permissionOk) {
      const { ForbiddenError } = await import('@/lib/auth/errors');
      throw new ForbiddenError('This feature is turned off for your role');
    }
  },
}));
vi.mock('@/lib/billing/entitlements', async (original) => ({
  ...(await original<typeof import('@/lib/billing/entitlements')>()),
  requireFeature: async () => undefined,
}));
vi.mock('@/lib/db/tenant', () => ({
  withTenant: async (_ctx: unknown, work: (tx: unknown) => Promise<unknown>) => work({
    $queryRaw: async () => (h.exists ? [{ id: '33333333-3333-4333-8333-333333333333' }] : []),
    $executeRaw: async (_s: TemplateStringsArray, ...values: unknown[]) => { h.audits.push(values); return 1; },
  }),
}));
vi.mock('@/lib/meetings/sync', () => ({
  recreateMeeting: async (ctx: unknown, id: string) => {
    if (h.serviceError) throw h.serviceError;
    h.calls.push({ fn: 'recreate', ctx, id });
  },
  useSuppliedLink: async (ctx: unknown, id: string) => {
    if (h.serviceError) throw h.serviceError;
    h.calls.push({ fn: 'use_link', ctx, id });
  },
}));

import { MeetingError } from '@/lib/meetings/types';
import { POST } from './route';

const post = (body: unknown, id = APPT) =>
  POST(new Request(`http://x/api/appointments/${id}/meeting`, { method: 'POST', body: JSON.stringify(body) }), { params: Promise.resolve({ id }) });

beforeEach(() => {
  h.role = 'agent'; h.mutationOk = true; h.permissionOk = true; h.exists = true; h.serviceError = null; h.calls = []; h.audits = [];
});

describe('POST /api/appointments/[id]/meeting', () => {
  it('runs Create again and Use supplied link for agents with appointments.manage, and audits each', async () => {
    expect((await post({ action: 'recreate' })).status).toBe(200);
    expect((await post({ action: 'use_link' })).status).toBe(200);
    expect(h.calls.map((c) => [c.fn, c.id])).toEqual([['recreate', APPT], ['use_link', APPT]]);
    expect(h.calls[0].ctx).toMatchObject({ accountId: '11111111-1111-4111-8111-111111111111', userId: '22222222-2222-4222-8222-222222222222' });
    expect(h.audits.map((v) => v[2])).toEqual(['appointments.meeting.recreate', 'appointments.meeting.use_link']);
  });

  it('refuses viewers, a missing CSRF proof and a turned-off permission before any meeting work', async () => {
    h.role = 'viewer';
    expect((await post({ action: 'recreate' })).status).toBe(403);
    h.role = 'agent'; h.mutationOk = false;
    expect((await post({ action: 'recreate' })).status).toBe(401);
    h.mutationOk = true; h.permissionOk = false;
    expect((await post({ action: 'recreate' })).status).toBe(403);
    expect(h.calls).toEqual([]);
  });

  it('answers 404 for another workspace\'s or a malformed id, 400 for an unknown action', async () => {
    h.exists = false;
    expect((await post({ action: 'recreate' })).status).toBe(404);
    h.exists = true;
    expect((await post({ action: 'recreate' }, 'nope')).status).toBe(404);
    expect((await post({ action: 'delete' })).status).toBe(400);
    expect(h.calls).toEqual([]);
  });

  it('returns meeting refusals as codes and writes no audit row', async () => {
    h.serviceError = new MeetingError('not_connected');
    const res = await post({ action: 'recreate' });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'not_connected' });
    expect(h.audits).toEqual([]);
  });
});
