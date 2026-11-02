import { beforeEach, describe, expect, it, vi } from 'vitest';

const ACCOUNT = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';
const CONTACT = '33333333-3333-4333-8333-333333333333';
const h = vi.hoisted(() => ({ role: 'agent', listOrders: vi.fn() }));

vi.mock('@/lib/auth/session', () => ({ requireSession: async () => ({ userId: USER, accountId: ACCOUNT, role: h.role, sessionId: 's' }) }));
vi.mock('@/lib/data/server', () => ({
  createClient: async () => ({
    from: () => {
      const b: Record<string, unknown> = {};
      b.select = () => b;
      b.eq = () => b;
      b.maybeSingle = async () => ({ data: { id: ACCOUNT, name: 'Acme' }, error: null });
      return b;
    },
  }),
}));
vi.mock('@/lib/commerce/orders', async (original) => ({
  ...(await original<typeof import('@/lib/commerce/orders')>()),
  listOrders: h.listOrders,
}));

import { GET } from './route';

const get = (query = '') => GET(new Request(`http://localhost/api/commerce/orders${query}`));

beforeEach(() => {
  vi.clearAllMocks();
  h.role = 'agent';
  h.listOrders.mockResolvedValue({ orders: [{ id: 'o1' }], next_cursor: null });
});

describe('GET /api/commerce/orders', () => {
  it('lists orders for agents with validated filters', async () => {
    const res = await get(`?status=paid&source=whatsapp&contact_id=${CONTACT}&q=%20Asha%20&limit=500&from=2026-11-01`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ orders: [{ id: 'o1' }], next_cursor: null });
    const [ctx, filters] = h.listOrders.mock.calls[0];
    expect(ctx).toEqual({ accountId: ACCOUNT, userId: USER, role: 'agent' });
    expect(filters).toMatchObject({ status: 'paid', source: 'whatsapp', contactId: CONTACT, q: 'Asha', limit: 100 });
    expect(filters.from).toEqual(new Date('2026-11-01'));
  });

  it('refuses viewers', async () => {
    h.role = 'viewer';
    expect((await get()).status).toBe(403);
    expect(h.listOrders).not.toHaveBeenCalled();
  });

  it.each(['?status=shipped', '?source=amazon', '?contact_id=nope', '?limit=-1', '?from=yesterday'])('rejects %s', async (query) => {
    expect((await get(query)).status).toBe(400);
    expect(h.listOrders).not.toHaveBeenCalled();
  });
});
