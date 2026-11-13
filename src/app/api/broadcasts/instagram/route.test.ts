import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  permissionDenied: false,
  permissionChecks: [] as unknown[][],
  created: [] as unknown[][],
  counted: [] as unknown[][],
  error: null as unknown,
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
vi.mock('@/lib/broadcasts/instagram', () => ({
  createInstagramBroadcast: async (...args: unknown[]) => { h.created.push(args); if (h.error) throw h.error; return { id: 'b-1', recipients: 3 }; },
  countInstagramAudience: async (...args: unknown[]) => { h.counted.push(args); return { onInstagram: 5, eligible: 3 }; },
}));

import { POST } from './route';
import { POST as ESTIMATE } from './estimate/route';
import { InstagramError } from '@/lib/instagram/errors';

const tenant = { accountId: 'acct', userId: 'u-1', role: 'agent' };
const body = { name: 'Flash sale', text: 'Hi {first name}', audience: { type: 'all' } };
const post = (fn: typeof POST) => fn(new Request('http://localhost/api/broadcasts/instagram', { method: 'POST', body: JSON.stringify(body) }));

describe('POST /api/broadcasts/instagram', () => {
  beforeEach(() => { h.permissionDenied = false; h.permissionChecks = []; h.created = []; h.counted = []; h.error = null; });

  it('requires campaigns.send and creates nothing when it is turned off', async () => {
    h.permissionDenied = true;
    expect((await post(POST)).status).toBe(403);
    expect(h.permissionChecks).toEqual([[tenant, 'campaigns.send']]);
    expect(h.created).toEqual([]);
  });

  it('creates the campaign in the caller tenant and acknowledges once queued', async () => {
    const res = await post(POST);
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ id: 'b-1', recipients: 3 });
    expect(h.created).toEqual([[tenant, body]]);
  });

  it('answers Instagram refusals with their fixed code, never a server error', async () => {
    h.error = new InstagramError('instagram_not_enabled');
    const res = await post(POST);
    expect(res.status).toBe(503);
    expect((await res.json()).code).toBe('instagram_not_enabled');
  });

  it('estimates in the caller tenant without a send permission check', async () => {
    const res = await post(ESTIMATE);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ onInstagram: 5, eligible: 3 });
    expect(h.counted).toEqual([[tenant, body]]);
  });

  it('refuses an oversized body before creating anything', async () => {
    const big = JSON.stringify({ ...body, text: 'x'.repeat(6_000_000) });
    const res = await POST(new Request('http://localhost/api/broadcasts/instagram', { method: 'POST', body: big }));
    expect(res.status).toBe(413);
    expect(h.created).toEqual([]);
  });
});
