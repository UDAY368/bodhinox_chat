import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  requireSession: vi.fn(),
  assertMutation: vi.fn(),
  rateLimit: vi.fn(),
  list: vi.fn(),
  record: vi.fn(),
  revokeOne: vi.fn(),
  revokeOthers: vi.fn(),
}));
vi.mock('@/lib/db/prisma', () => ({ getAuthPrisma: vi.fn() }));
vi.mock('@/lib/auth/session', () => ({
  requireSession: mocks.requireSession,
  assertMutation: mocks.assertMutation,
}));
vi.mock('@/lib/auth/service', () => ({ enforceAuthRateLimit: mocks.rateLimit }));
vi.mock('@/lib/auth/device-sessions', () => ({
  listDeviceSessions: mocks.list,
  recordSessionDevice: mocks.record,
  revokeDeviceSession: mocks.revokeOne,
  revokeOtherDeviceSessions: mocks.revokeOthers,
}));
import { DELETE, GET } from './route';
import { ForbiddenError, UnauthorizedError } from '@/lib/auth/errors';

const context = { userId: 'u1', sessionId: '11111111-1111-4111-8111-111111111111', accountId: 'a1' };
const url = 'https://crm.test/api/auth/sessions';
beforeEach(() => {
  mocks.requireSession.mockResolvedValue(context);
  mocks.assertMutation.mockResolvedValue(undefined);
});
afterEach(() => vi.clearAllMocks());

describe('GET /api/auth/sessions', () => {
  it('requires a session', async () => {
    mocks.requireSession.mockRejectedValue(new UnauthorizedError());
    expect((await GET(new Request(url))).status).toBe(401);
    expect(mocks.list).not.toHaveBeenCalled();
  });
  it('lists the caller’s own sessions and records this device', async () => {
    mocks.list.mockResolvedValue([{ id: context.sessionId, current: true }]);
    const response = await GET(new Request(url, { headers: { 'user-agent': 'UA' } }));
    expect(await response.json()).toEqual({ sessions: [{ id: context.sessionId, current: true }] });
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(mocks.record).toHaveBeenCalledWith(context.sessionId, 'UA');
    expect(mocks.list).toHaveBeenCalledWith(context);
  });
});

describe('DELETE /api/auth/sessions', () => {
  it('requires origin and CSRF checks before revoking', async () => {
    mocks.assertMutation.mockRejectedValue(new ForbiddenError('Invalid CSRF token'));
    expect((await DELETE(new Request(`${url}?scope=others`, { method: 'DELETE' }))).status).toBe(403);
    expect(mocks.revokeOthers).not.toHaveBeenCalled();
  });
  it('revokes one session by id or all others', async () => {
    const id = '22222222-2222-4222-8222-222222222222';
    mocks.revokeOne.mockResolvedValue(true);
    expect(await (await DELETE(new Request(`${url}?id=${id}`, { method: 'DELETE' }))).json()).toEqual({ revoked: 1 });
    expect(mocks.revokeOne).toHaveBeenCalledWith(context, id);
    mocks.revokeOne.mockResolvedValue(false);
    expect((await DELETE(new Request(`${url}?id=${id}`, { method: 'DELETE' }))).status).toBe(404);
    mocks.revokeOthers.mockResolvedValue(3);
    expect(await (await DELETE(new Request(`${url}?scope=others`, { method: 'DELETE' }))).json()).toEqual({ revoked: 3 });
  });
  it('rejects malformed or ambiguous requests', async () => {
    for (const query of ['', '?id=not-a-uuid', '?scope=all', `?scope=others&id=${context.sessionId}`])
      expect((await DELETE(new Request(`${url}${query}`, { method: 'DELETE' }))).status).toBe(400);
  });
});
