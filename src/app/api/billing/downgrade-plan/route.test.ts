import { beforeEach, describe, expect, it, vi } from 'vitest';

const ACCOUNT = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';
const SEG = '33333333-3333-4333-8333-333333333333';
const h = vi.hoisted(() => ({
  role: 'admin', mutationOk: true, contexts: [] as unknown[], restricted: false, permissionChecks: [] as unknown[],
  downgradeOverview: vi.fn(), saveDowngradeSelection: vi.fn(),
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
vi.mock('@/lib/rate-limit', () => ({ checkRateLimit: () => ({ success: true }), rateLimitResponse: () => Response.json({}, { status: 429 }) }));
vi.mock('@/lib/db/tenant', () => ({
  withTenant: async (ctx: unknown, fn: (tx: unknown) => unknown) => { h.contexts.push(ctx); return fn({ tx: true }); },
}));
vi.mock('@/lib/billing/downgrade', async (original) => ({
  ...(await original<typeof import('@/lib/billing/downgrade')>()),
  downgradeOverview: h.downgradeOverview, saveDowngradeSelection: h.saveDowngradeSelection,
}));

import { DowngradeInputError } from '@/lib/billing/downgrade';
import { GET, POST } from './route';

const overview = { plan: { id: 'basic', name: 'Basic' }, effectiveAt: null, pending: false, kinds: [], selection: null, archived: [] };
const post = (body: unknown) => POST(new Request('http://localhost/api/billing/downgrade-plan', { method: 'POST', body: JSON.stringify(body) }));

beforeEach(() => {
  vi.clearAllMocks();
  Object.assign(h, { role: 'admin', mutationOk: true, contexts: [], restricted: false, permissionChecks: [] });
  h.downgradeOverview.mockResolvedValue(overview);
  h.saveDowngradeSelection.mockResolvedValue({ applied: true });
});

describe('/api/billing/downgrade-plan', () => {
  it('shows the overview to admins in their own workspace scope', async () => {
    const res = await GET(new Request('http://localhost/api/billing/downgrade-plan'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(overview);
    expect(h.contexts).toEqual([{ accountId: ACCOUNT, userId: USER, role: 'admin' }]);
    h.role = 'agent';
    expect((await GET(new Request('http://localhost/api/billing/downgrade-plan'))).status).toBe(403);
  });

  it('saves a selection and returns the refreshed overview', async () => {
    const res = await post({ plan: 'basic', keep: { segments: [SEG] } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ applied: true, ...overview });
    expect(h.saveDowngradeSelection).toHaveBeenCalledWith({ tx: true }, ACCOUNT, USER, 'basic', { segments: [SEG] });
  });

  it('requires an admin and the mutation proof', async () => {
    h.role = 'agent';
    expect((await post({ plan: 'basic', keep: {} })).status).toBe(403);
    h.role = 'owner';
    h.mutationOk = false;
    expect((await post({ plan: 'basic', keep: {} })).status).toBe(401);
    expect(h.saveDowngradeSelection).not.toHaveBeenCalled();
  });

  it("needs the 'settings.billing' permission to save a choice", async () => {
    h.restricted = true;
    expect((await post({ plan: 'basic', keep: {} })).status).toBe(403);
    expect(h.permissionChecks).toEqual([{ tenant: { accountId: ACCOUNT, userId: USER, role: 'admin' }, permission: 'settings.billing' }]);
    expect(h.saveDowngradeSelection).not.toHaveBeenCalled();
  });

  it('rejects malformed bodies and explains refusals', async () => {
    expect((await post({ keep: {} })).status).toBe(400);
    expect((await post({ plan: 'basic', keep: { tags: [SEG] } })).status).toBe(400);
    h.saveDowngradeSelection.mockRejectedValueOnce(new DowngradeInputError('stale_plan', 409));
    const res = await post({ plan: 'pro', keep: {} });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 't:stale_plan', code: 'stale_plan' });
  });
});
