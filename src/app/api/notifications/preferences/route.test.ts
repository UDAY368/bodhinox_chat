import { beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getCurrentAccount: vi.fn(),
  get: vi.fn(),
  save: vi.fn(),
  rate: vi.fn(() => ({ success: true })),
}));
vi.mock('@/lib/auth/account', () => ({
  getCurrentAccount: mocks.getCurrentAccount,
  toErrorResponse: (error: { status?: number }) => Response.json({ error: 'Denied' }, { status: error.status ?? 500 }),
}));
vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: mocks.rate,
  rateLimitResponse: () => Response.json({ error: 'Slow down' }, { status: 429 }),
  RATE_LIMITS: { adminAction: { limit: 30, windowMs: 60_000 } },
}));
vi.mock('@/lib/notifications/preferences', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/notifications/preferences')>()),
  getNotificationPreferences: mocks.get,
  saveNotificationPreferences: mocks.save,
  emailDigestAvailable: () => false,
}));

import { GET, PUT } from './route';

const ctx = { accountId: 'tenant-a', userId: 'user-a', role: 'viewer', db: {}, account: { id: 'tenant-a', name: 'A' } };
const prefs = [{ event: 'mention', in_app: true, email: false }];
beforeEach(() => {
  vi.clearAllMocks();
  mocks.getCurrentAccount.mockResolvedValue(ctx);
  mocks.get.mockResolvedValue(prefs);
  mocks.save.mockResolvedValue(prefs);
  mocks.rate.mockReturnValue({ success: true });
});
const put = (body: unknown) => new Request('http://local.test/api/notifications/preferences', { method: 'PUT', body: JSON.stringify(body) });

it('returns the caller’s own preferences, privately, with email availability', async () => {
  const response = await GET();
  expect(await response.json()).toEqual({ preferences: prefs, email_available: false });
  expect(response.headers.get('Cache-Control')).toContain('private');
  expect(mocks.get).toHaveBeenCalledWith({ accountId: 'tenant-a', userId: 'user-a', role: 'viewer' });
});

it('lets any member save their own preferences, scoped to the session identity', async () => {
  const response = await PUT(put({ preferences: [{ event: 'mention', in_app: false, email: true }] }));
  expect(response.status).toBe(200);
  expect(mocks.save).toHaveBeenCalledWith(
    { accountId: 'tenant-a', userId: 'user-a', role: 'viewer' },
    [{ event: 'mention', in_app: false, email: true }],
  );
});

it('rejects an invalid body without writing', async () => {
  const response = await PUT(put({ preferences: [{ event: 'mention', in_app: true, email: true, user_id: 'other' }] }));
  expect(response.status).toBe(400);
  expect(mocks.save).not.toHaveBeenCalled();
});

it('does not read or write without a session', async () => {
  mocks.getCurrentAccount.mockRejectedValue({ status: 401 });
  expect((await GET()).status).toBe(401);
  expect((await PUT(put({ preferences: prefs }))).status).toBe(401);
  expect(mocks.get).not.toHaveBeenCalled();
  expect(mocks.save).not.toHaveBeenCalled();
});

it('rate-limits saves', async () => {
  mocks.rate.mockReturnValue({ success: false });
  expect((await PUT(put({ preferences: prefs }))).status).toBe(429);
  expect(mocks.save).not.toHaveBeenCalled();
});
