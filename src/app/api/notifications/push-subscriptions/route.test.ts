import { beforeEach, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  ctx: { accountId: 'tenant-a', userId: 'user-a', role: 'viewer' },
  available: true,
  save: vi.fn(async () => {}),
  remove: vi.fn(async () => true),
  count: vi.fn(async () => 1),
}));
vi.mock('@/lib/auth/account', () => ({
  getCurrentAccount: async () => h.ctx,
  toErrorResponse: () => Response.json({ error: 'Denied' }, { status: 500 }),
}));
vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: () => ({ success: true }),
  rateLimitResponse: () => Response.json({ error: 'Slow down' }, { status: 429 }),
  RATE_LIMITS: { adminAction: { limit: 30, windowMs: 60_000 } },
}));
vi.mock('@/lib/notifications/push-subscriptions', () => ({ savePushSubscription: h.save, deletePushSubscription: h.remove, countPushDevices: h.count }));
vi.mock('@/lib/notifications/web-push', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/notifications/web-push')>()),
  vapidConfig: () => (h.available ? { publicKey: 'BPUBLIC', privateKey: 'x', subject: 'mailto:a@b.c' } : null),
}));

import { DELETE, GET, POST } from './route';

const FCM = 'https://fcm.googleapis.com/fcm/send/abc';
const subscription = { endpoint: FCM, keys: { p256dh: Buffer.alloc(65, 4).toString('base64url'), auth: Buffer.alloc(16, 1).toString('base64url') } };
const req = (method: string, body: unknown) => new Request('http://x/api/notifications/push-subscriptions', { method, body: JSON.stringify(body) });

beforeEach(() => {
  vi.clearAllMocks();
  h.available = true;
});

it('reports a graceful off state while VAPID keys are missing', async () => {
  h.available = false;
  expect(await (await GET()).json()).toEqual({ available: false, public_key: null, devices: 0 });
  expect((await POST(req('POST', subscription))).status).toBe(503);
  expect(h.save).not.toHaveBeenCalled();
});

it('stores this browser for the session member only', async () => {
  const res = await POST(req('POST', subscription));
  expect(res.status).toBe(200);
  expect(h.save).toHaveBeenCalledWith({ accountId: 'tenant-a', userId: 'user-a', role: 'viewer' }, { endpoint: FCM, p256dh: subscription.keys.p256dh, auth: subscription.keys.auth });
});

it('refuses an endpoint the server should never call', async () => {
  for (const endpoint of ['https://169.254.169.254/latest/meta-data', 'http://fcm.googleapis.com/x', 'https://evil.example/push'])
    expect((await POST(req('POST', { ...subscription, endpoint }))).status, endpoint).toBe(400);
  expect((await DELETE(req('DELETE', { endpoint: 'https://evil.example/push' }))).status).toBe(400);
  expect(h.save).not.toHaveBeenCalled();
  expect(h.remove).not.toHaveBeenCalled();
});

it('removes this browser', async () => {
  const res = await DELETE(req('DELETE', { endpoint: FCM }));
  expect(await res.json()).toEqual({ removed: true });
  expect(h.remove).toHaveBeenCalledWith({ accountId: 'tenant-a', userId: 'user-a', role: 'viewer' }, FCM);
});
