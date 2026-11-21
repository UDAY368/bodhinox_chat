import { beforeEach, describe, expect, it, vi } from 'vitest';

const ID = '22222222-2222-4222-8222-22222222222b';
const h = vi.hoisted(() => ({
  roleDenied: false,
  permissionDenied: false,
  permissionChecks: [] as unknown[][],
  cancelled: [] as unknown[][],
  result: { cancelled: 3, heldForReview: 1 } as { cancelled: number; heldForReview: number } | null | Error,
}));

vi.mock('@/lib/auth/account', () => ({
  requireRole: async (minimum: string) => {
    if (h.roleDenied) throw Object.assign(new Error('Insufficient workspace role'), { status: 403 });
    expect(minimum).toBe('agent');
    return { accountId: 'acct', userId: 'u-1', role: 'agent' };
  },
  toErrorResponse: (e: { status?: number }) => new Response(null, { status: e?.status ?? 500 }),
}));
vi.mock('@/lib/auth/permissions', () => ({
  requirePermission: async (...args: unknown[]) => {
    h.permissionChecks.push(args);
    if (h.permissionDenied) throw Object.assign(new Error('This feature is turned off for your role'), { status: 403 });
  },
}));
vi.mock('@/lib/broadcasts/pause', () => ({
  cancelRemainingBroadcast: async (...args: unknown[]) => {
    h.cancelled.push(args);
    if (h.result instanceof Error) throw h.result;
    return h.result;
  },
}));

import { POST } from './route';

const tenant = { accountId: 'acct', userId: 'u-1', role: 'agent' };
const cancel = (id = ID) => POST(new Request(`http://localhost/api/broadcasts/${id}/cancel-remaining`, { method: 'POST' }), { params: Promise.resolve({ id }) });

describe('POST /api/broadcasts/[id]/cancel-remaining', () => {
  beforeEach(() => {
    h.roleDenied = false; h.permissionDenied = false; h.permissionChecks = []; h.cancelled = [];
    h.result = { cancelled: 3, heldForReview: 1 };
  });

  it('refuses a viewer and a member without campaigns.send, cancelling nothing', async () => {
    h.roleDenied = true;
    expect((await cancel()).status).toBe(403);
    h.roleDenied = false; h.permissionDenied = true;
    expect((await cancel()).status).toBe(403);
    expect(h.permissionChecks).toEqual([[tenant, 'campaigns.send']]);
    expect(h.cancelled).toEqual([]);
  });

  it('cancels in the caller tenant and reports what was held for reconciliation', async () => {
    const res = await cancel();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true, status: 'cancelled', cancelled: 3, heldForReview: 1 });
    expect(h.cancelled).toEqual([[tenant, ID]]);
  });

  it('answers 409 when the campaign is not sending or paused', async () => {
    h.result = null;
    const res = await cancel();
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'not_cancellable' });
  });

  it('answers 404 for another workspace campaign and for a malformed id', async () => {
    h.result = Object.assign(new Error('Broadcast unavailable'), { status: 404 });
    expect((await cancel()).status).toBe(404);
    h.cancelled = [];
    expect((await cancel('not-a-uuid')).status).toBe(404);
    expect(h.cancelled).toEqual([]);
  });
});
