import { beforeEach, expect, it, vi } from 'vitest';

const ctx = { accountId: '11111111-1111-4111-8111-111111111111', userId: '22222222-2222-4222-8222-222222222222', role: 'admin' };
const h = vi.hoisted(() => ({
  getCurrentAccount: vi.fn(),
  requireRole: vi.fn(),
  assertMutation: vi.fn(),
  overview: vi.fn(),
  cancel: vi.fn(),
  change: vi.fn(),
  pay: vi.fn(),
  requirePermission: vi.fn(),
  can: vi.fn(),
  configured: true,
}));

vi.mock('@/lib/auth/account', () => ({
  getCurrentAccount: h.getCurrentAccount,
  requireRole: h.requireRole,
  toErrorResponse: (e: { status?: number }) => Response.json({ error: 'denied' }, { status: e?.status ?? 500 }),
}));
vi.mock('@/lib/auth/session', () => ({ requireSession: async () => ({ userId: ctx.userId }), assertMutation: h.assertMutation }));
vi.mock('@/lib/db/tenant', () => ({ withTenant: (_c: unknown, op: (tx: unknown) => unknown) => op({}) }));
vi.mock('@/lib/auth/permissions', () => ({ requirePermission: h.requirePermission, can: h.can }));
vi.mock('@/lib/rate-limit', () => ({
  RATE_LIMITS: { adminAction: { limit: 30, windowMs: 60_000 } },
  checkRateLimit: () => ({ success: true }),
  rateLimitResponse: () => Response.json({}, { status: 429 }),
}));
vi.mock('@/lib/billing/razorpay-billing', () => ({ billingConfigured: () => h.configured }));
vi.mock('@/lib/billing/subscriptions', async () => {
  const { AuthError } = await import('@/lib/auth/errors');
  class BillingError extends AuthError {
    constructor(public billingCode: string, status: number) { super(billingCode, status, billingCode); }
  }
  return { BillingError, getBillingOverview: h.overview, requestCancel: h.cancel, requestPlanChange: h.change, paymentLink: h.pay };
});

import { BillingError } from '@/lib/billing/subscriptions';
import { GET, POST } from './route';

const post = (body: unknown) => POST(new Request('http://localhost/api/billing/subscription', { method: 'POST', body: JSON.stringify(body) }));

beforeEach(() => {
  vi.clearAllMocks();
  h.configured = true;
  h.getCurrentAccount.mockResolvedValue({ ...ctx, role: 'agent' });
  h.requireRole.mockResolvedValue(ctx);
  h.assertMutation.mockResolvedValue(undefined);
  h.overview.mockResolvedValue({ subscription: null, pending: [] });
  h.requirePermission.mockResolvedValue(undefined);
  h.can.mockResolvedValue(true);
});

it('shows any member the subscription; only admins see pending provider calls', async () => {
  const res = await GET();
  expect(await res.json()).toEqual({ configured: true, can_manage: false, subscription: null, pending: [] });
  expect(h.overview).toHaveBeenCalledWith({}, ctx.accountId, false);
  h.getCurrentAccount.mockResolvedValue(ctx);
  h.configured = false;
  expect(await (await GET()).json()).toMatchObject({ configured: false, can_manage: true });
  expect(h.overview).toHaveBeenLastCalledWith({}, ctx.accountId, true);
});

it('cancels, changes plan and returns the pay link for admins', async () => {
  h.cancel.mockResolvedValue({ state: 'scheduled' });
  expect(await (await post({ action: 'cancel' })).json()).toEqual({ state: 'scheduled' });
  expect(h.cancel).toHaveBeenCalledWith({ accountId: ctx.accountId, userId: ctx.userId });

  h.change.mockResolvedValue({ state: 'pending' });
  const changed = await post({ action: 'change_plan', plan: 'basic', interval: 'month' });
  expect(changed.status).toBe(202);
  expect(h.change).toHaveBeenCalledWith({ accountId: ctx.accountId, userId: ctx.userId, plan: 'basic', interval: 'month' });

  h.pay.mockResolvedValue({ shortUrl: 'https://rzp.io/i/pay' });
  expect(await (await post({ action: 'resume' })).json()).toEqual({ state: 'pay', short_url: 'https://rzp.io/i/pay' });
});

it("does not offer or allow billing to an admin restricted from 'settings.billing'", async () => {
  h.getCurrentAccount.mockResolvedValue(ctx);
  h.can.mockResolvedValue(false);
  expect(await (await GET()).json()).toMatchObject({ can_manage: false });
  expect(h.can).toHaveBeenCalledWith({}, { accountId: ctx.accountId, role: 'admin' }, 'settings.billing');
  // Restricted admins still see pending provider calls (read-only).
  expect(h.overview).toHaveBeenLastCalledWith({}, ctx.accountId, true);
  h.requirePermission.mockRejectedValue(Object.assign(new Error('restricted'), { status: 403 }));
  expect((await post({ action: 'cancel' })).status).toBe(403);
  expect((await post({ action: 'change_plan', plan: 'basic', interval: 'month' })).status).toBe(403);
  expect(h.cancel).not.toHaveBeenCalled();
  expect(h.change).not.toHaveBeenCalled();
});

it('refuses non-admins, bad input and maps refusals', async () => {
  h.requireRole.mockRejectedValue(Object.assign(new Error('role'), { status: 403 }));
  expect((await post({ action: 'cancel' })).status).toBe(403);
  h.requireRole.mockResolvedValue(ctx);
  expect((await post({ action: 'delete_everything' })).status).toBe(400);
  expect((await post({ action: 'change_plan', plan: 'basic' })).status).toBe(400);
  h.cancel.mockRejectedValue(new BillingError('no_subscription', 409));
  const res = await post({ action: 'cancel' });
  expect(res.status).toBe(409);
  expect((await res.json()).code).toBe('no_subscription');
  expect(h.change).not.toHaveBeenCalled();
});
