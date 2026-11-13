import { beforeEach, describe, expect, it, vi } from 'vitest';

const ID = '22222222-2222-4222-8222-22222222222b';
const h = vi.hoisted(() => ({
  permissionDenied: false,
  permissionChecks: [] as unknown[][],
  cancelled: [] as unknown[][],
  rescheduled: [] as unknown[][],
  startedNow: [] as unknown[][],
  cancelResult: true,
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
vi.mock('@/lib/broadcasts/schedule', () => ({
  cancelScheduledBroadcast: async (...args: unknown[]) => { h.cancelled.push(args); return h.cancelResult; },
  rescheduleBroadcast: async (...args: unknown[]) => { h.rescheduled.push(args); },
  startScheduledNow: async (...args: unknown[]) => { h.startedNow.push(args); },
}));

import { DELETE, PATCH } from './route';

const params = { params: Promise.resolve({ id: ID }) };
const del = () => DELETE(new Request(`http://localhost/api/broadcasts/${ID}/schedule`, { method: 'DELETE' }), params);
const patch = () => PATCH(new Request(`http://localhost/api/broadcasts/${ID}/schedule`, {
  method: 'PATCH', body: JSON.stringify({ scheduledAt: new Date(Date.now() + 3_600_000).toISOString() }),
}), params);
const tenant = { accountId: 'acct', userId: 'u-1', role: 'agent' };

describe('/api/broadcasts/[id]/schedule', () => {
  beforeEach(() => {
    h.permissionDenied = false; h.permissionChecks = []; h.cancelled = []; h.rescheduled = []; h.startedNow = []; h.cancelResult = true;
  });

  it('DELETE requires campaigns.send and cancels nothing when it is turned off', async () => {
    h.permissionDenied = true;
    expect((await del()).status).toBe(403);
    expect(h.permissionChecks).toEqual([[tenant, 'campaigns.send']]);
    expect(h.cancelled).toEqual([]);
  });

  it('DELETE cancels a scheduled campaign in the caller tenant when permitted', async () => {
    expect((await del()).status).toBe(200);
    expect(h.cancelled).toEqual([[tenant, ID]]);
  });

  it('DELETE answers 409 when the campaign is not cancellable', async () => {
    h.cancelResult = false;
    expect((await del()).status).toBe(409);
  });

  it('DELETE answers 404 for a malformed id without touching the store', async () => {
    const res = await DELETE(new Request('http://localhost/api/broadcasts/x/schedule', { method: 'DELETE' }), { params: Promise.resolve({ id: 'not-a-uuid' }) });
    expect(res.status).toBe(404);
    expect(h.cancelled).toEqual([]);
  });

  it('PATCH requires campaigns.send and reschedules nothing when it is turned off', async () => {
    h.permissionDenied = true;
    expect((await patch()).status).toBe(403);
    expect(h.permissionChecks).toEqual([[tenant, 'campaigns.send']]);
    expect(h.rescheduled).toEqual([]);
  });

  it('PATCH { sendNow: true } starts the campaign now in the caller tenant and reschedules nothing', async () => {
    const res = await PATCH(new Request(`http://localhost/api/broadcasts/${ID}/schedule`, { method: 'PATCH', body: JSON.stringify({ sendNow: true }) }), params);
    expect(res.status).toBe(200);
    expect(h.startedNow).toEqual([[tenant, ID]]);
    expect(h.rescheduled).toEqual([]);
  });

  it('PATCH { sendNow: true } starts nothing without campaigns.send', async () => {
    h.permissionDenied = true;
    const res = await PATCH(new Request(`http://localhost/api/broadcasts/${ID}/schedule`, { method: 'PATCH', body: JSON.stringify({ sendNow: true }) }), params);
    expect(res.status).toBe(403);
    expect(h.startedNow).toEqual([]);
  });
});
