import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ role: 'agent', permitted: true, create: vi.fn() }));

vi.mock('@/lib/auth/account', async (original) => ({
  ...(await original<typeof import('@/lib/auth/account')>()),
  requireRole: async (minimum: string) => {
    const order = ['viewer', 'agent', 'admin', 'owner'];
    if (order.indexOf(h.role) < order.indexOf(minimum)) { const { ForbiddenError } = await import('@/lib/auth/errors'); throw new ForbiddenError('Insufficient workspace role'); }
    return { userId: 'u', accountId: 'a', role: h.role };
  },
}));
vi.mock('@/lib/auth/permissions', () => ({
  requirePermission: async () => {
    if (!h.permitted) { const { ForbiddenError } = await import('@/lib/auth/errors'); throw new ForbiddenError('restricted'); }
  },
}));
vi.mock('@/lib/rate-limit', async (original) => ({ ...(await original<typeof import('@/lib/rate-limit')>()), checkRateLimit: () => ({ success: true }) }));
vi.mock('@/lib/commerce/new-arrivals', () => ({ createNewArrivalsCampaign: h.create }));

import { POST } from './route';

const post = (body: unknown = { name: 'x' }) => POST(new Request('https://app.test/api/commerce/new-arrivals', {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
}));

describe('POST /api/commerce/new-arrivals', () => {
  beforeEach(() => { h.role = 'agent'; h.permitted = true; h.create.mockReset().mockResolvedValue({ id: 'b1' }); });

  it('starts the campaign for an agent with the campaigns.send permission (the wizard rule)', async () => {
    const res = await post();
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ id: 'b1' });
  });

  it('refuses a viewer and an agent whose campaigns.send permission was withdrawn, without creating anything', async () => {
    h.role = 'viewer';
    expect((await post()).status).toBe(403);
    h.role = 'agent'; h.permitted = false;
    expect((await post()).status).toBe(403);
    expect(h.create).not.toHaveBeenCalled();
  });

  it('requires a JSON body', async () => {
    const res = await POST(new Request('https://app.test/x', { method: 'POST', headers: { 'content-type': 'text/plain' }, body: 'x' }));
    expect(res.status).toBe(400);
    expect(h.create).not.toHaveBeenCalled();
  });
});
