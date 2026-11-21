import { beforeEach, describe, expect, it, vi } from 'vitest';

const ID = '22222222-2222-4222-8222-22222222222b';
const h = vi.hoisted(() => ({
  roleDenied: false,
  permissionDenied: false,
  permissionChecks: [] as unknown[][],
  saved: [] as unknown[][],
  loaded: [] as unknown[][],
  deleted: [] as unknown[][],
  draft: { name: 'Draft' } as unknown,
  removed: true,
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
vi.mock('@/lib/broadcasts/drafts', () => ({
  saveCampaignDraft: async (...args: unknown[]) => { h.saved.push(args); return { id: ID }; },
  loadCampaignDraft: async (...args: unknown[]) => { h.loaded.push(args); return h.draft; },
  deleteCampaignDraft: async (...args: unknown[]) => { h.deleted.push(args); return h.removed; },
}));

import { POST } from './route';
import { DELETE, GET, PUT } from './[id]/route';

const tenant = { accountId: 'acct', userId: 'u-1', role: 'agent' };
const body = { name: 'Draft', channel: 'whatsapp', audience: { type: 'all' } };
const json = (method: string, payload?: unknown) => new Request('http://localhost/api/broadcasts/drafts', {
  method, headers: { 'Content-Type': 'application/json' }, ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
});
const params = (id = ID) => ({ params: Promise.resolve({ id }) });

describe('/api/broadcasts/drafts', () => {
  beforeEach(() => {
    Object.assign(h, { roleDenied: false, permissionDenied: false, permissionChecks: [], saved: [], loaded: [], deleted: [], draft: { name: 'Draft' }, removed: true });
  });

  it('POST saves in the caller tenant with campaigns.send', async () => {
    const res = await POST(json('POST', body));
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ id: ID });
    expect(h.permissionChecks).toEqual([[tenant, 'campaigns.send']]);
    expect(h.saved).toEqual([[tenant, body]]);
  });

  it('every write refuses a viewer and a member without campaigns.send', async () => {
    h.roleDenied = true;
    expect((await POST(json('POST', body))).status).toBe(403);
    expect((await PUT(json('PUT', body), params())).status).toBe(403);
    expect((await DELETE(json('DELETE'), params())).status).toBe(403);
    expect((await GET(json('GET'), params())).status).toBe(403);
    h.roleDenied = false; h.permissionDenied = true;
    expect((await POST(json('POST', body))).status).toBe(403);
    expect((await PUT(json('PUT', body), params())).status).toBe(403);
    expect((await DELETE(json('DELETE'), params())).status).toBe(403);
    expect(h.saved).toEqual([]);
    expect(h.deleted).toEqual([]);
  });

  it('refuses an oversized body before saving', async () => {
    const big = new Request('http://localhost/api/broadcasts/drafts', { method: 'POST', headers: { 'content-length': String(6 * 1024 * 1024) }, body: '{}' });
    expect((await POST(big)).status).toBe(413);
    expect(h.saved).toEqual([]);
  });

  it('GET, PUT and DELETE act on that draft in the caller tenant; unknown or malformed ids are 404', async () => {
    const got = await GET(json('GET'), params());
    expect(await got.json()).toEqual({ draft: { name: 'Draft' } });
    expect(h.loaded).toEqual([[tenant, ID]]);
    expect((await PUT(json('PUT', body), params())).status).toBe(200);
    expect(h.saved).toEqual([[tenant, body, ID]]);
    expect((await DELETE(json('DELETE'), params())).status).toBe(200);
    expect(h.deleted).toEqual([[tenant, ID]]);

    h.draft = null; h.removed = false;
    expect((await GET(json('GET'), params())).status).toBe(404);
    expect((await DELETE(json('DELETE'), params())).status).toBe(404);
    h.loaded = []; h.saved = []; h.deleted = [];
    expect((await GET(json('GET'), params('x'))).status).toBe(404);
    expect((await PUT(json('PUT', body), params('x'))).status).toBe(404);
    expect((await DELETE(json('DELETE'), params('x'))).status).toBe(404);
    expect([h.loaded, h.saved, h.deleted]).toEqual([[], [], []]);
  });
});
