import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ForbiddenError } from '@/lib/auth/errors';

const h = vi.hoisted(() => ({
  requireRole: vi.fn(),
  list: vi.fn(async () => []),
  decide: vi.fn(async () => ({ id: 'g1', status: 'approved' })),
  create: vi.fn(async () => ({ id: 'g2', status: 'approved' })),
  limited: false,
}));
vi.mock('@/lib/auth/account', () => ({ requireRole: h.requireRole }));
vi.mock('@/lib/db/tenant', () => ({ withTenant: async (_c: unknown, fn: (tx: unknown) => unknown) => fn({}) }));
vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: () => ({ success: !h.limited }), rateLimitResponse: () => new Response(null, { status: 429 }), RATE_LIMITS: { adminAction: {} },
}));
vi.mock('@/lib/platform/support', async (original) => ({
  ...(await original<typeof import('@/lib/platform/support')>()),
  listSupportGrants: h.list, decideSupportGrant: h.decide, createProactiveGrant: h.create,
}));

import { GET, POST } from './route';
import { PATCH } from './[id]/route';

const ctx = { accountId: '11111111-1111-4111-8111-111111111111', userId: '22222222-2222-4222-8222-222222222222', role: 'admin' };
const GRANT = '33333333-3333-4333-8333-333333333333';
const send = (method: string, body: unknown) => new Request('https://crm.test/api/account/support-grants', { method, body: JSON.stringify(body) });

beforeEach(() => {
  h.requireRole.mockResolvedValue(ctx);
  h.limited = false;
});
afterEach(() => vi.clearAllMocks());

describe('/api/account/support-grants', () => {
  it('needs an owner or admin of the session workspace', async () => {
    h.requireRole.mockRejectedValue(new ForbiddenError('Insufficient workspace role'));
    expect((await GET()).status).toBe(403);
    expect((await POST(send('POST', { email: 'ops@bodhinox.test', reason: 'Please check webhooks', minutes: 60 }))).status).toBe(403);
    expect((await PATCH(send('PATCH', { action: 'deny' }), { params: Promise.resolve({ id: GRANT }) })).status).toBe(403);
    expect(h.requireRole).toHaveBeenCalledWith('admin');
    expect(h.list).not.toHaveBeenCalled();
    expect(h.decide).not.toHaveBeenCalled();
    expect(h.create).not.toHaveBeenCalled();
  });

  it('lists, grants and decides for the session workspace and user only', async () => {
    expect((await GET()).status).toBe(200);
    expect(h.list).toHaveBeenCalledWith({}, ctx.accountId);
    expect((await POST(send('POST', { email: 'ops@bodhinox.test', reason: 'Please check webhooks', minutes: 60 }))).status).toBe(201);
    expect(h.create).toHaveBeenCalledWith({}, { accountId: ctx.accountId, userId: ctx.userId },
      { email: 'ops@bodhinox.test', reason: 'Please check webhooks', minutes: 60 });
    expect((await PATCH(send('PATCH', { action: 'approve', minutes: 30 }), { params: Promise.resolve({ id: GRANT }) })).status).toBe(200);
    expect(h.decide).toHaveBeenCalledWith({}, { accountId: ctx.accountId, userId: ctx.userId }, GRANT, { action: 'approve', minutes: 30 });
  });

  it('refuses malformed bodies and rate-limited callers before the database', async () => {
    expect((await POST(send('POST', { email: 'ops@bodhinox.test', reason: 'short', minutes: 60 }))).status).toBe(400);
    expect((await POST(send('POST', { email: 'ops@bodhinox.test', reason: 'Please check webhooks', minutes: 60, accountId: GRANT }))).status).toBe(400);
    expect((await PATCH(send('PATCH', { action: 'extend' }), { params: Promise.resolve({ id: GRANT }) })).status).toBe(400);
    h.limited = true;
    expect((await PATCH(send('PATCH', { action: 'deny' }), { params: Promise.resolve({ id: GRANT }) })).status).toBe(429);
    expect(h.create).not.toHaveBeenCalled();
    expect(h.decide).not.toHaveBeenCalled();
  });
});
