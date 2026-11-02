import { beforeEach, describe, expect, it, vi } from 'vitest';

const ACCOUNT = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';
const ADDON = '33333333-3333-4333-8333-333333333333';
const h = vi.hoisted(() => ({
  role: 'admin', mutationOk: true, limited: false, provider: {} as object | null, restricted: false, permissionChecks: [] as unknown[],
  listAddons: vi.fn(), purchaseAddon: vi.fn(), cancelAddon: vi.fn(),
}));

vi.mock('@/lib/auth/session', () => ({
  requireSession: async () => ({ userId: USER, accountId: ACCOUNT, role: h.role, sessionId: 's' }),
  assertMutation: async () => {
    if (!h.mutationOk) {
      const { UnauthorizedError } = await import('@/lib/auth/errors');
      throw new UnauthorizedError();
    }
  },
}));
vi.mock('@/lib/auth/permissions', () => ({
  requirePermission: async (tenant: unknown, permission: string) => {
    h.permissionChecks.push({ tenant, permission });
    if (h.restricted) {
      const { ForbiddenError } = await import('@/lib/auth/errors');
      throw new ForbiddenError('This feature is turned off for your role');
    }
  },
}));
vi.mock('@/lib/data/server', () => ({ createClient: async () => ({}) }));
vi.mock('@/lib/i18n/translate', () => ({ getT: () => (key: string) => `t:${key}` }));
vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: () => ({ success: !h.limited }),
  rateLimitResponse: () => Response.json({}, { status: 429 }),
}));
vi.mock('@/lib/db/tenant', () => ({ withTenant: async (_ctx: unknown, fn: (tx: unknown) => unknown) => fn({ tx: true }) }));
vi.mock('@/lib/billing/razorpay-billing', () => ({ getBillingProvider: () => h.provider }));
vi.mock('@/lib/billing/addons', async (original) => ({
  ...(await original<typeof import('@/lib/billing/addons')>()),
  addonPacks: () => [{ kind: 'ai_messages', quantity: 1000, amountMinor: 49900, currency: 'INR' }],
  listAddons: h.listAddons, purchaseAddon: h.purchaseAddon, cancelAddon: h.cancelAddon,
}));

import { AddonInputError } from '@/lib/billing/addons';
import { DELETE, GET, POST } from './route';

const post = (body: unknown) => POST(new Request('http://localhost/api/billing/add-ons', { method: 'POST', body: JSON.stringify(body) }));
const del = (id = ADDON) => DELETE(new Request(`http://localhost/api/billing/add-ons?id=${id}`, { method: 'DELETE' }));

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('BILLING_SELLER_STATE_CODE', '29');
  Object.assign(h, { role: 'admin', mutationOk: true, limited: false, provider: {}, restricted: false, permissionChecks: [] });
  h.listAddons.mockResolvedValue([{ id: ADDON, kind: 'ai_messages', quantity: 1000, status: 'active' }]);
  h.purchaseAddon.mockResolvedValue({ id: ADDON, status: 'active' });
  h.cancelAddon.mockResolvedValue(undefined);
});

describe('/api/billing/add-ons', () => {
  it('lists packs and add-ons for admins only', async () => {
    const res = await GET(new Request('http://localhost/api/billing/add-ons'));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ configured: true, packs: [{ kind: 'ai_messages' }], addOns: [{ id: ADDON }] });
    h.role = 'agent';
    expect((await GET(new Request('http://localhost/api/billing/add-ons'))).status).toBe(403);
  });

  it('requires an admin and the mutation proof to buy or cancel', async () => {
    h.role = 'agent';
    expect((await post({ kind: 'ai_messages' })).status).toBe(403);
    expect((await del()).status).toBe(403);
    h.role = 'admin';
    h.mutationOk = false;
    expect((await post({ kind: 'ai_messages' })).status).toBe(401);
    expect((await del()).status).toBe(401);
    expect(h.purchaseAddon).not.toHaveBeenCalled();
    expect(h.cancelAddon).not.toHaveBeenCalled();
  });

  it("needs the 'settings.billing' permission to buy or cancel, not to list", async () => {
    h.restricted = true;
    expect((await post({ kind: 'ai_messages' })).status).toBe(403);
    expect((await del()).status).toBe(403);
    expect(h.permissionChecks).toContainEqual({ tenant: { accountId: ACCOUNT, userId: USER, role: 'admin' }, permission: 'settings.billing' });
    expect(h.purchaseAddon).not.toHaveBeenCalled();
    expect(h.cancelAddon).not.toHaveBeenCalled();
    expect((await GET(new Request('http://localhost/api/billing/add-ons'))).status).toBe(200);
  });

  it('buys packs through the provider', async () => {
    const res = await post({ kind: 'ai_messages', packs: 2 });
    expect(res.status).toBe(201);
    expect(h.purchaseAddon).toHaveBeenCalledWith(h.provider, expect.objectContaining({ accountId: ACCOUNT, userId: USER, packs: 2,
      pack: expect.objectContaining({ kind: 'ai_messages' }) }));
  });

  it('reports an unknown provider outcome as pending (202) and a rejection as failed', async () => {
    h.purchaseAddon.mockResolvedValueOnce({ id: ADDON, status: 'pending' });
    expect((await post({ kind: 'ai_messages' })).status).toBe(202);
    h.purchaseAddon.mockResolvedValueOnce({ id: ADDON, status: 'failed' });
    const failed = await post({ kind: 'ai_messages' });
    expect(failed.status).toBe(422);
    expect(await failed.json()).toMatchObject({ code: 'rejected' });
  });

  it('refuses unknown packs, a missing subscription, an unconfigured provider and bursts', async () => {
    expect((await post({ kind: 'extra_seats' })).status).toBe(400);
    h.purchaseAddon.mockRejectedValueOnce(new AddonInputError('needs_subscription', 409));
    const res = await post({ kind: 'ai_messages' });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 't:needs_subscription', code: 'needs_subscription' });
    h.provider = null;
    expect((await post({ kind: 'ai_messages' })).status).toBe(503);
    h.provider = {};
    // GST is added to and invoiced for every pack: no seller state, no purchase.
    vi.stubEnv('BILLING_SELLER_STATE_CODE', '');
    expect((await post({ kind: 'ai_messages' })).status).toBe(503);
    expect(await (await GET(new Request('http://localhost/api/billing/add-ons'))).json()).toMatchObject({ configured: false });
    expect(h.purchaseAddon).toHaveBeenCalledTimes(1);
    vi.stubEnv('BILLING_SELLER_STATE_CODE', '29');
    h.limited = true;
    expect((await post({ kind: 'ai_messages' })).status).toBe(429);
  });

  it('cancels an active add-on and explains when it cannot', async () => {
    expect((await del()).status).toBe(200);
    expect(h.cancelAddon).toHaveBeenCalledWith(ACCOUNT, USER, ADDON);
    h.cancelAddon.mockRejectedValueOnce(new AddonInputError('not_cancellable', 409));
    expect((await del()).status).toBe(409);
  });
});
