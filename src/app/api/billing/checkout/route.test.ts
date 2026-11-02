import { beforeEach, expect, it, vi } from 'vitest';

const ctx = { accountId: '11111111-1111-4111-8111-111111111111', userId: '22222222-2222-4222-8222-222222222222', role: 'admin' };
const h = vi.hoisted(() => ({
  requireRole: vi.fn(),
  assertMutation: vi.fn(),
  startCheckout: vi.fn(),
  requirePermission: vi.fn(),
  limited: false,
}));

vi.mock('@/lib/auth/account', () => ({
  requireRole: h.requireRole,
  toErrorResponse: (e: { status?: number }) => Response.json({ error: 'denied' }, { status: e?.status ?? 500 }),
}));
vi.mock('@/lib/auth/session', () => ({ requireSession: async () => ({ userId: ctx.userId }), assertMutation: h.assertMutation }));
vi.mock('@/lib/auth/permissions', () => ({ requirePermission: h.requirePermission }));
vi.mock('@/lib/rate-limit', () => ({
  RATE_LIMITS: { adminAction: { limit: 30, windowMs: 60_000 } },
  checkRateLimit: () => ({ success: !h.limited }),
  rateLimitResponse: () => Response.json({}, { status: 429 }),
}));
vi.mock('@/lib/billing/subscriptions', async () => {
  const { AuthError } = await import('@/lib/auth/errors');
  class BillingError extends AuthError {
    constructor(public billingCode: string, status: number) { super(billingCode, status, billingCode); }
  }
  return { BillingError, startCheckout: h.startCheckout };
});

import { BillingError } from '@/lib/billing/subscriptions';
import { POST } from './route';

const post = (body: unknown) => POST(new Request('http://localhost/api/billing/checkout', { method: 'POST', body: JSON.stringify(body) }));

beforeEach(() => {
  vi.clearAllMocks();
  h.limited = false;
  h.requireRole.mockResolvedValue(ctx);
  h.assertMutation.mockResolvedValue(undefined);
  h.requirePermission.mockResolvedValue(undefined);
});

it('returns what Razorpay Checkout needs and nothing secret', async () => {
  h.startCheckout.mockResolvedValue({ state: 'ready', subscriptionId: 'sub_1', shortUrl: 'https://rzp.io/i/x', keyId: 'rzp_test_pub', prefill: { name: 'Acme', email: 'a@acme.example' } });
  const res = await post({ plan: 'pro', interval: 'year' });
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ state: 'ready', subscription_id: 'sub_1', short_url: 'https://rzp.io/i/x', key_id: 'rzp_test_pub', prefill: { name: 'Acme', email: 'a@acme.example' } });
  expect(h.startCheckout).toHaveBeenCalledWith({ accountId: ctx.accountId, userId: ctx.userId, plan: 'pro', interval: 'year' });
  expect(h.requireRole).toHaveBeenCalledWith('admin');
});

it('answers 202 while a lost provider answer is reconciled', async () => {
  h.startCheckout.mockResolvedValue({ state: 'pending' });
  const res = await post({ plan: 'pro', interval: 'month' });
  expect(res.status).toBe(202);
  expect(await res.json()).toEqual({ state: 'pending' });
});

it('checks origin/CSRF and the admin role before any provider call', async () => {
  h.assertMutation.mockRejectedValue(Object.assign(new Error('csrf'), { status: 403 }));
  expect((await post({ plan: 'pro', interval: 'month' })).status).toBe(403);
  h.assertMutation.mockResolvedValue(undefined);
  h.requireRole.mockRejectedValue(Object.assign(new Error('role'), { status: 403 }));
  expect((await post({ plan: 'pro', interval: 'month' })).status).toBe(403);
  expect(h.startCheckout).not.toHaveBeenCalled();
});

it("refuses an admin whose role was restricted from 'settings.billing'", async () => {
  h.requirePermission.mockRejectedValue(Object.assign(new Error('restricted'), { status: 403 }));
  expect((await post({ plan: 'pro', interval: 'month' })).status).toBe(403);
  expect(h.requirePermission).toHaveBeenCalledWith(expect.objectContaining({ accountId: ctx.accountId, role: 'admin' }), 'settings.billing');
  expect(h.startCheckout).not.toHaveBeenCalled();
});

it('validates the body, rate limits and maps billing refusals to codes', async () => {
  expect((await post({ plan: 'PRO; drop', interval: 'month' })).status).toBe(400);
  expect((await post({ plan: 'pro', interval: 'week' })).status).toBe(400);
  h.startCheckout.mockRejectedValue(new BillingError('profile_required', 409));
  const res = await post({ plan: 'pro', interval: 'month' });
  expect(res.status).toBe(409);
  expect((await res.json()).code).toBe('profile_required');
  h.limited = true;
  expect((await post({ plan: 'pro', interval: 'month' })).status).toBe(429);
});
