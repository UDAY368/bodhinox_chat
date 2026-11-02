import { beforeEach, expect, it, vi } from 'vitest';

const NUMBER = '22222222-2222-4222-8222-222222222222';
const h = vi.hoisted(() => ({
  requireRole: vi.fn(),
  getCurrentAccount: vi.fn(),
  getNumberConfig: vi.fn(),
  sync: vi.fn(),
  health: vi.fn(),
  NoNumberError: class NoNumberError extends Error {
    constructor(public reason: string) { super(reason); }
  },
}));
const { NoNumberError } = h;
const ctx = { db: {}, accountId: 'acct-1', userId: 'u-1', role: 'admin' };
vi.mock('@/lib/auth/account', () => ({
  requireRole: h.requireRole,
  getCurrentAccount: h.getCurrentAccount,
  toErrorResponse: (e: Error) => Response.json({ error: e.message }, { status: e.message.includes('role') ? 403 : 500 }),
}));
vi.mock('@/lib/db/tenant', () => ({ withTenant: async (_c: unknown, op: (tx: unknown) => unknown) => op({}) }));
vi.mock('@/lib/db/prisma', () => ({ getPrisma: () => 'app-prisma' }));
vi.mock('@/lib/i18n/translate', () => ({ getT: () => (key: string) => key }));
vi.mock('@/lib/whatsapp/numbers', () => ({ getNumberConfig: h.getNumberConfig, NoNumberError: h.NoNumberError }));
vi.mock('@/lib/whatsapp/health-sync', () => ({ syncNumberHealth: h.sync }));
vi.mock('@/lib/whatsapp/meta-api', () => ({ getPhoneNumberHealth: h.health }));
vi.mock('@/lib/whatsapp/encryption', () => ({ decrypt: () => 'plain-token' }));
vi.mock('@/lib/rate-limit', () => ({
  RATE_LIMITS: { adminAction: { limit: 30, windowMs: 60_000 } },
  checkRateLimit: () => ({ success: true }),
  rateLimitResponse: () => Response.json({}, { status: 429 }),
}));

import { GET, POST } from './route';

const url = (q = '') => `http://localhost/api/whatsapp/health${q}`;
const config = { id: NUMBER, phone_number_id: '1555', access_token: 'enc', status: 'connected' };

beforeEach(() => {
  vi.clearAllMocks();
  h.requireRole.mockResolvedValue(ctx);
  h.getCurrentAccount.mockResolvedValue({ ...ctx, role: 'agent' });
  h.getNumberConfig.mockResolvedValue(config);
  h.health.mockResolvedValue({ display_phone_number: '+1 555', quality_rating: 'GREEN', whatsapp_business_manager_messaging_limit: 'TIER_1K' });
  h.sync.mockResolvedValue({ status: 'synced', snapshot: { quality_rating: 'RED', messaging_limit_tier: 'TIER_1K', name_status: null, code_verification_status: null }, changes: [{ kind: 'quality_drop' }], notified: 2 });
});

it('GET reports the requested number to any member, never the token', async () => {
  const res = await GET(new Request(url(`?number=${NUMBER}`)));
  expect(res.status).toBe(200);
  expect(h.getNumberConfig).toHaveBeenCalledWith({}, 'acct-1', NUMBER);
  expect(h.health).toHaveBeenCalledWith({ phoneNumberId: '1555', accessToken: 'plain-token' });
  const body = await res.json();
  expect(body).toEqual({ state: 'connected', numberId: NUMBER, displayPhoneNumber: '+1 555', quality: 'GREEN', limit: { kind: 'tier', perDay: 1000 } });
  expect(JSON.stringify(body)).not.toMatch(/enc|plain-token/);
});

it('GET without ?number uses the default and keeps the single-number contract', async () => {
  h.getNumberConfig.mockRejectedValueOnce(new NoNumberError('none'));
  expect(await (await GET(new Request(url()))).json()).toMatchObject({ state: 'disconnected', numberId: null });
  expect(h.getNumberConfig).toHaveBeenCalledWith({}, 'acct-1', undefined);
  h.health.mockRejectedValueOnce(new Error('Meta down'));
  expect(await (await GET(new Request(url()))).json()).toMatchObject({ state: 'unavailable', numberId: NUMBER });
});

it('GET answers 404 for another workspace\'s number and 409 when no default is set', async () => {
  h.getNumberConfig.mockRejectedValueOnce(new NoNumberError('not_found'));
  expect((await GET(new Request(url('?number=x')))).status).toBe(404);
  h.getNumberConfig.mockRejectedValueOnce(new NoNumberError('no_default'));
  expect((await GET(new Request(url()))).status).toBe(409);
  expect(h.health).not.toHaveBeenCalled();
});

it('POST syncs on demand as the admin under tenant scope', async () => {
  const res = await POST(new Request(url(`?number=${NUMBER}`), { method: 'POST' }));
  expect(res.status).toBe(200);
  expect(h.requireRole).toHaveBeenCalledWith('admin');
  expect(h.sync).toHaveBeenCalledWith({
    accountId: 'acct-1', configId: NUMBER, db: 'app-prisma',
    tenant: { accountId: 'acct-1', userId: 'u-1', role: 'admin' },
  });
  expect(await res.json()).toMatchObject({ numberId: NUMBER, status: 'synced', health: { quality_rating: 'RED' }, changes: ['quality_drop'] });
});

it('POST refuses non-admins before reading the number or calling Meta', async () => {
  h.requireRole.mockRejectedValueOnce(new Error('Insufficient workspace role'));
  expect((await POST(new Request(url(), { method: 'POST' }))).status).toBe(403);
  expect(h.getNumberConfig).not.toHaveBeenCalled();
  expect(h.sync).not.toHaveBeenCalled();
});

it('POST maps Meta failures and missing numbers to safe responses', async () => {
  h.sync.mockResolvedValueOnce({ status: 'error', error: 'token' });
  const failed = await POST(new Request(url(), { method: 'POST' }));
  expect(failed.status).toBe(502);
  expect(await failed.json()).toEqual({ numberId: NUMBER, status: 'error', error: 'token', message: 'whatsappHealth.error.token' });
  h.sync.mockResolvedValueOnce({ status: 'disconnected' });
  expect((await POST(new Request(url(), { method: 'POST' }))).status).toBe(409);
  h.getNumberConfig.mockRejectedValueOnce(new NoNumberError('none'));
  expect((await POST(new Request(url(), { method: 'POST' }))).status).toBe(409);
  h.getNumberConfig.mockRejectedValueOnce(new NoNumberError('not_found'));
  expect((await POST(new Request(url('?number=bad'), { method: 'POST' }))).status).toBe(404);
});
