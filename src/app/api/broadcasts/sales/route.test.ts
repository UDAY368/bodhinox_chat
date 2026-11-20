import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ sales: vi.fn(), tenant: vi.fn() }));
vi.mock('@/lib/auth/account', () => ({
  getCurrentAccount: async () => ({ accountId: '11111111-1111-4111-8111-111111111111', userId: 'u', role: 'viewer' }),
  toErrorResponse: () => new Response(null, { status: 500 }),
}));
vi.mock('@/lib/audience/http', () => ({ tenantOf: (ctx: { accountId: string }) => ({ accountId: ctx.accountId }) }));
vi.mock('@/lib/db/tenant', () => ({ withTenant: (ctx: unknown, fn: (tx: unknown) => unknown) => { h.tenant(ctx); return fn({}); } }));
vi.mock('@/lib/broadcasts/attribution', () => ({ MAX_SALES_CAMPAIGNS: 50, campaignSales: h.sales }));

import { GET } from './route';

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const get = (ids: string) => GET(new Request(`https://app.example.test/api/broadcasts/sales?ids=${ids}`));

describe('GET /api/broadcasts/sales', () => {
  beforeEach(() => { h.sales.mockReset().mockResolvedValue({ [A]: { orders: 1, revenue: [] } }); h.tenant.mockReset(); });

  it("reads the asked campaigns in the member's own workspace", async () => {
    const res = await get(A.toUpperCase());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ sales: { [A]: { orders: 1, revenue: [] } } });
    expect(h.tenant).toHaveBeenCalledWith({ accountId: '11111111-1111-4111-8111-111111111111' });
    expect(h.sales).toHaveBeenCalledWith({}, '11111111-1111-4111-8111-111111111111', [A]);
  });

  it('refuses missing, malformed or too many ids before any query', async () => {
    for (const ids of ['', 'not-a-uuid', `${A},x`, Array(51).fill(A).join(',')]) expect((await get(ids)).status).toBe(400);
    expect(h.sales).not.toHaveBeenCalled();
  });
});
