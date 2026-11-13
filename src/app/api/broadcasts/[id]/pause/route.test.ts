import { beforeEach, describe, expect, it, vi } from 'vitest';

const ID = '22222222-2222-4222-8222-22222222222b';
const h = vi.hoisted(() => ({
  permissionDenied: false,
  permissionChecks: [] as unknown[][],
  paused: [] as unknown[][],
  result: true as boolean | Error,
}));

vi.mock('@/lib/auth/account', () => ({
  requireRole: async () => ({ accountId: 'acct', userId: 'u-1', role: 'agent' }),
  toErrorResponse: (e: { status?: number }) => new Response(null, { status: e?.status ?? 500 }),
}));
vi.mock('@/lib/auth/permissions', () => ({
  requirePermission: async (...args: unknown[]) => {
    h.permissionChecks.push(args);
    if (h.permissionDenied) throw Object.assign(new Error('This feature is turned off for your role'), { status: 403 });
  },
}));
vi.mock('@/lib/broadcasts/pause', () => ({
  pauseBroadcast: async (...args: unknown[]) => {
    h.paused.push(args);
    if (h.result instanceof Error) throw h.result;
    return h.result;
  },
}));

import { POST } from './route';

const tenant = { accountId: 'acct', userId: 'u-1', role: 'agent' };
const pause = (id = ID) => POST(new Request(`http://localhost/api/broadcasts/${id}/pause`, { method: 'POST' }), { params: Promise.resolve({ id }) });

describe('POST /api/broadcasts/[id]/pause', () => {
  beforeEach(() => { h.permissionDenied = false; h.permissionChecks = []; h.paused = []; h.result = true; });

  it('requires campaigns.send and pauses nothing when it is turned off', async () => {
    h.permissionDenied = true;
    expect((await pause()).status).toBe(403);
    expect(h.permissionChecks).toEqual([[tenant, 'campaigns.send']]);
    expect(h.paused).toEqual([]);
  });

  it('pauses a sending campaign in the caller tenant', async () => {
    const res = await pause();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true, status: 'paused' });
    expect(h.paused).toEqual([[tenant, ID]]);
  });

  it('answers 409 when the campaign is not sending', async () => {
    h.result = false;
    expect((await pause()).status).toBe(409);
  });

  it('answers 404 for another workspace campaign and for a malformed id', async () => {
    h.result = Object.assign(new Error('Broadcast unavailable'), { status: 404 });
    expect((await pause()).status).toBe(404);
    h.paused = [];
    expect((await pause('not-a-uuid')).status).toBe(404);
    expect(h.paused).toEqual([]);
  });
});
