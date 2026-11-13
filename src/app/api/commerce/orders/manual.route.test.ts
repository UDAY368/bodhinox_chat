import { beforeEach, describe, expect, it, vi } from 'vitest';

// POST /api/commerce/orders (manual order): agents and above only, ids and quantities only (a price in the
// body is a 400 before anything is written), the member's own tenant context, and refusal codes mapped.
const ACCOUNT = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';
const CONTACT = '33333333-3333-4333-8333-333333333333';
const VARIANT = '44444444-4444-4444-8444-444444444444';
const ORDER = '77777777-7777-4777-8777-777777777777';
const h = vi.hoisted(() => ({ role: 'agent', create: vi.fn(), getOrder: vi.fn() }));

vi.mock('@/lib/inbox/masking-apply', async (original) => ({
  ...(await original<typeof import('@/lib/inbox/masking-apply')>()),
  resolvePhoneMask: async () => false,
}));
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
vi.mock('@/lib/commerce/manual-orders', async (original) => ({
  ...(await original<typeof import('@/lib/commerce/manual-orders')>()),
  createManualOrder: h.create,
}));
vi.mock('@/lib/commerce/orders', async (original) => ({
  ...(await original<typeof import('@/lib/commerce/orders')>()),
  getOrder: h.getOrder,
}));

import { ManualOrderError } from '@/lib/commerce/manual-orders';
import { StockError } from '@/lib/commerce/stock';
import { POST } from './route';

const post = (body: unknown) => POST(new Request('http://localhost/api/commerce/orders', {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
}));
const valid = (extra: Record<string, unknown> = {}) => ({
  contact_id: CONTACT, client_request_id: crypto.randomUUID(), lines: [{ variant_id: VARIANT, qty: 1 }], ...extra,
});

beforeEach(() => {
  vi.clearAllMocks();
  h.role = 'agent';
  h.create.mockResolvedValue({ orderId: ORDER, created: true });
  h.getOrder.mockResolvedValue({ id: ORDER, contact: null });
});

describe('POST /api/commerce/orders (manual order)', () => {
  it('creates the order as the signed-in member and answers 201', async () => {
    const res = await post(valid());
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ order: { id: ORDER, contact: null }, created: true });
    const [ctx, input] = h.create.mock.calls[0];
    expect(ctx).toEqual({ accountId: ACCOUNT, userId: USER, role: 'agent' });
    expect(input.lines).toEqual([{ variantId: VARIANT, qty: 1 }]);
  });

  it('answers 200 for a replayed click', async () => {
    h.create.mockResolvedValue({ orderId: ORDER, created: false });
    expect((await post(valid())).status).toBe(200);
  });

  it('refuses viewers before anything is written', async () => {
    h.role = 'viewer';
    expect((await post(valid())).status).toBe(403);
    expect(h.create).not.toHaveBeenCalled();
  });

  it('refuses a price from the browser', async () => {
    expect((await post(valid({ total_minor: 1 }))).status).toBe(400);
    expect((await post(valid({ lines: [{ variant_id: VARIANT, qty: 1, unit_price_minor: 1 }] }))).status).toBe(400);
    expect(h.create).not.toHaveBeenCalled();
  });

  it('maps refusals to their codes', async () => {
    h.create.mockRejectedValueOnce(new ManualOrderError('variant_unavailable', 409, VARIANT));
    let res = await post(valid());
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'variant_unavailable', variant_id: VARIANT });
    h.create.mockRejectedValueOnce(new ManualOrderError('contact_not_found', 404));
    expect((await post(valid())).status).toBe(404);
    h.create.mockRejectedValueOnce(new StockError('out_of_stock', 'out_of_stock', VARIANT));
    res = await post(valid());
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'out_of_stock' });
  });
});
