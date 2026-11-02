import { beforeEach, describe, expect, it, vi } from 'vitest';

const ACCOUNT = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';
const ORDER = '33333333-3333-4333-8333-333333333333';
const h = vi.hoisted(() => ({ role: 'agent', getOrder: vi.fn(), updateOrder: vi.fn(), limited: false }));

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
vi.mock('@/lib/rate-limit', () => ({
  RATE_LIMITS: { send: { limit: 60, windowMs: 60_000 } },
  checkRateLimit: () => ({ success: !h.limited }),
  rateLimitResponse: () => Response.json({}, { status: 429 }),
}));
vi.mock('@/lib/commerce/orders', async (original) => ({
  ...(await original<typeof import('@/lib/commerce/orders')>()),
  getOrder: h.getOrder,
  updateOrder: h.updateOrder,
}));

import { OrderError } from '@/lib/commerce/orders';
import { GET, PATCH } from './route';

const params = () => ({ params: Promise.resolve({ id: ORDER }) });
const patch = (body: unknown) => PATCH(new Request('http://localhost/o', { method: 'PATCH', body: JSON.stringify(body) }), params());

beforeEach(() => {
  vi.clearAllMocks();
  h.role = 'agent';
  h.limited = false;
  h.getOrder.mockResolvedValue({ id: ORDER, status: 'new' });
  h.updateOrder.mockImplementation(async (_ctx, id, p) => ({ id, ...p }));
});

describe('GET /api/commerce/orders/[id]', () => {
  it('returns the order to agents', async () => {
    const res = await GET(new Request('http://localhost/o'), params());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ order: { id: ORDER, status: 'new' } });
  });

  it('refuses viewers and hides other accounts as 404', async () => {
    h.role = 'viewer';
    expect((await GET(new Request('http://localhost/o'), params())).status).toBe(403);
    h.role = 'agent';
    h.getOrder.mockRejectedValueOnce(new OrderError(404, 'not_found', 'Order not found'));
    expect((await GET(new Request('http://localhost/o'), params())).status).toBe(404);
  });
});

describe('PATCH /api/commerce/orders/[id]', () => {
  it('changes status and note for agents', async () => {
    const res = await patch({ status: 'confirmed', note: '  call before delivery ' });
    expect(res.status).toBe(200);
    expect(h.updateOrder).toHaveBeenCalledWith({ accountId: ACCOUNT, userId: USER, role: 'agent' }, ORDER, { status: 'confirmed', note: 'call before delivery' });
  });

  it('clears the note with a blank string', async () => {
    await patch({ note: '   ' });
    expect(h.updateOrder.mock.calls[0][2]).toEqual({ note: null });
  });

  it.each([
    [{ status: 'shipped' }],
    [{ subtotal_minor: 1 }],
    [{ status: 'paid', currency: 'USD' }],
    [{ note: 'x'.repeat(2001) }],
    [{ note: 5 }],
    [{}],
    [[]],
  ])('rejects %j without touching the order', async (body) => {
    expect((await patch(body)).status).toBe(400);
    expect(h.updateOrder).not.toHaveBeenCalled();
  });

  it('reports a refused transition or a concurrent change as 409', async () => {
    h.updateOrder.mockRejectedValueOnce(new OrderError(409, 'bad_transition', 'no'));
    const res = await patch({ status: 'new' });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'bad_transition' });
  });

  it('refuses viewers and rate-limited callers', async () => {
    h.role = 'viewer';
    expect((await patch({ status: 'paid' })).status).toBe(403);
    h.role = 'agent';
    h.limited = true;
    expect((await patch({ status: 'paid' })).status).toBe(429);
    expect(h.updateOrder).not.toHaveBeenCalled();
  });
});
