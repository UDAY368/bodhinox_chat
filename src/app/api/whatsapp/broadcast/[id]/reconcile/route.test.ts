// Guards of the campaign reconcile action (audit 2026-11-10, finding 12): an admin with
// campaigns.send, a CSRF-checked live session, a bounded batch, and a 404 for a
// campaign outside the workspace. The SQL is covered in lib/broadcasts/reconcile.integration.test.ts.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const ACCT = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';
const BID = '33333333-3333-4333-8333-333333333333';
const R1 = '44444444-4444-4444-8444-444444444444';

const h = vi.hoisted(() => ({
  role: 'admin' as string,
  mutationOk: true,
  permissionDenied: false,
  calls: [] as unknown[],
  notFound: false,
  rateLimited: false,
}));

vi.mock('@/lib/auth/session', () => ({
  requireSession: async () => ({ userId: USER, accountId: ACCT, role: h.role }),
  assertMutation: async () => { if (!h.mutationOk) throw Object.assign(new Error('Bad origin'), { status: 403 }); },
}));
vi.mock('@/lib/auth/account', () => ({
  requireRole: async (minimum: string) => {
    const order = ['viewer', 'agent', 'admin', 'owner'];
    if (order.indexOf(h.role) < order.indexOf(minimum)) throw Object.assign(new Error('Forbidden'), { status: 403 });
    return { accountId: ACCT, userId: USER, role: h.role };
  },
  toErrorResponse: (e: { status?: number }) => new Response(null, { status: e?.status ?? 500 }),
}));
vi.mock('@/lib/auth/permissions', () => ({
  requirePermission: async (_ctx: unknown, permission: string) => {
    if (permission !== 'campaigns.send') throw new Error('wrong permission');
    if (h.permissionDenied) throw Object.assign(new Error('off'), { status: 403 });
  },
}));
vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: () => ({ success: !h.rateLimited, reset: Date.now() + 1000 }),
  rateLimitResponse: () => new Response(null, { status: 429 }),
}));
vi.mock('@/lib/db/tenant', () => ({ withTenant: async (ctx: unknown, op: (tx: unknown) => unknown) => op({ ctx }) }));
vi.mock('@/lib/broadcasts/reconcile', async (original) => {
  const real = await original<typeof import('@/lib/broadcasts/reconcile')>();
  return {
    ...real,
    listUncertainRecipients: async (_tx: unknown, accountId: string, broadcastId: string) => {
      h.calls.push(['list', accountId, broadcastId]);
      if (h.notFound) throw new real.ReconcileError('not_found');
      return { total: 1, recipients: [{ id: R1, contact_name: 'A', contact_phone: '1', error_message: 'x', flagged_at: null }] };
    },
    reconcileBroadcastRecipients: async (_tx: unknown, args: unknown) => {
      h.calls.push(['reconcile', args]);
      if (h.notFound) throw new real.ReconcileError('not_found');
      return { resolved: 1 };
    },
  };
});

import { GET, POST } from './route';

const params = (id = BID) => ({ params: Promise.resolve({ id }) });
const post = (body: unknown, id = BID) =>
  POST(new Request(`http://x/api/whatsapp/broadcast/${id}/reconcile`, { method: 'POST', body: JSON.stringify(body) }), params(id));

beforeEach(() => {
  h.role = 'admin'; h.mutationOk = true; h.permissionDenied = false; h.calls = []; h.notFound = false; h.rateLimited = false;
});

describe('GET /api/whatsapp/broadcast/[id]/reconcile', () => {
  it('lists uncertain recipients for a member who can send campaigns', async () => {
    h.role = 'agent';
    const res = await GET(new Request('http://x'), params());
    expect(res.status).toBe(200);
    expect((await res.json()).total).toBe(1);
    expect(h.calls).toEqual([['list', ACCT, BID]]);
  });

  it('404s a malformed id or a campaign outside the workspace', async () => {
    expect((await GET(new Request('http://x'), params('nope'))).status).toBe(404);
    h.notFound = true;
    expect((await GET(new Request('http://x'), params())).status).toBe(404);
  });
});

describe('POST /api/whatsapp/broadcast/[id]/reconcile', () => {
  it('records the resolution for the caller in their workspace', async () => {
    const res = await post({ resolution: 'not_sent', recipientIds: [R1] });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ resolved: 1 });
    expect(h.calls).toEqual([['reconcile', { accountId: ACCT, userId: USER, broadcastId: BID, recipientIds: [R1], resolution: 'not_sent' }]]);
  });

  it('refuses an agent, a member without campaigns.send, and a cross-site request', async () => {
    h.role = 'agent';
    expect((await post({ resolution: 'sent', recipientIds: [R1] })).status).toBe(403);
    h.role = 'admin'; h.permissionDenied = true;
    expect((await post({ resolution: 'sent', recipientIds: [R1] })).status).toBe(403);
    h.permissionDenied = false; h.mutationOk = false;
    expect((await post({ resolution: 'sent', recipientIds: [R1] })).status).toBe(403);
    expect(h.calls).toEqual([]);
  });

  it('rejects an unknown resolution, an empty or oversized batch, and ids that are not uuids', async () => {
    for (const body of [
      { resolution: 'retry', recipientIds: [R1] },
      { resolution: 'sent', recipientIds: [] },
      { resolution: 'sent', recipientIds: Array.from({ length: 201 }, () => R1) },
      { resolution: 'sent', recipientIds: ['1 OR 1=1'] },
    ]) expect((await post(body)).status).toBe(400);
    expect(h.calls).toEqual([]);
  });

  it('is rate limited and 404s a campaign outside the workspace', async () => {
    h.rateLimited = true;
    expect((await post({ resolution: 'sent', recipientIds: [R1] })).status).toBe(429);
    h.rateLimited = false; h.notFound = true;
    expect((await post({ resolution: 'sent', recipientIds: [R1] })).status).toBe(404);
  });
});
