import { beforeEach, describe, expect, it, vi } from 'vitest';

const ACCOUNT = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';
const ORDER = '33333333-3333-4333-8333-333333333333';
const h = vi.hoisted(() => ({ role: 'admin', limited: false, create: vi.fn(), labels: vi.fn() }));

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
  RATE_LIMITS: { adminAction: { limit: 30, windowMs: 60_000 }, send: { limit: 60, windowMs: 60_000 } },
  checkRateLimit: () => ({ success: !h.limited }),
  rateLimitResponse: () => Response.json({}, { status: 429 }),
}));
vi.mock('@/lib/fulfilment/bulk-dispatch', async (original) => ({
  ...(await original<typeof import('@/lib/fulfilment/bulk-dispatch')>()),
  bulkCreateShipments: h.create,
  bulkLabelUrls: h.labels,
}));

import { POST } from './route';

const post = (body: unknown) => POST(new Request('http://localhost/api/commerce/shipments/bulk', {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
}));

beforeEach(() => {
  vi.clearAllMocks();
  h.role = 'admin';
  h.limited = false;
  h.create.mockResolvedValue([{ order_id: ORDER, ok: true, shipment_id: 's1' }]);
  h.labels.mockResolvedValue([{ order_id: ORDER, ok: true, url: 'https://labels.example/1.pdf' }]);
});

describe('POST /api/commerce/shipments/bulk', () => {
  it.each(['agent', 'viewer'])('refuses a %s before touching any order', async (role) => {
    h.role = role;
    expect((await post({ action: 'create', order_ids: [ORDER] })).status).toBe(403);
    expect(h.create).not.toHaveBeenCalled();
    expect(h.labels).not.toHaveBeenCalled();
  });

  it('creates shipments per order in the caller’s workspace and answers each', async () => {
    const res = await post({ action: 'create', order_ids: [ORDER, ORDER.toUpperCase()] });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ results: [{ order_id: ORDER, ok: true, shipment_id: 's1' }] });
    const [ctx, ids] = h.create.mock.calls[0];
    expect(ctx).toMatchObject({ accountId: ACCOUNT, userId: USER, role: 'admin' });
    expect(ids).toEqual([ORDER]);
  });

  it('fetches labels', async () => {
    const res = await post({ action: 'labels', order_ids: [ORDER] });
    expect((await res.json()).results[0].url).toBe('https://labels.example/1.pdf');
    expect(h.create).not.toHaveBeenCalled();
  });

  it('says when no default parcel size is set', async () => {
    h.create.mockResolvedValue('no_defaults');
    const res = await post({ action: 'create', order_ids: [ORDER] });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ code: 'no_defaults' });
  });

  it.each([
    { action: 'create', order_ids: [] },
    { action: 'create', order_ids: Array.from({ length: 26 }, (_, i) => `33333333-3333-4333-8333-${String(i).padStart(12, '0')}`) },
    { action: 'create', order_ids: ['not-a-uuid'] },
    { action: 'delete', order_ids: [ORDER] },
    { order_ids: [ORDER] },
  ])('refuses a bad body (%#) and touches nothing', async (body) => {
    expect((await post(body)).status).toBe(400);
    expect(h.create).not.toHaveBeenCalled();
    expect(h.labels).not.toHaveBeenCalled();
  });

  it('honours the write limit', async () => {
    h.limited = true;
    expect((await post({ action: 'create', order_ids: [ORDER] })).status).toBe(429);
    expect(h.create).not.toHaveBeenCalled();
  });
});
