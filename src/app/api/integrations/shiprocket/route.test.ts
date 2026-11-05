import { beforeEach, describe, expect, it, vi } from 'vitest';

const ACCOUNT = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';
const ORDER = '33333333-3333-4333-8333-333333333333';
const h = vi.hoisted(() => ({
  role: 'admin', limited: false, disabled: false,
  save: vi.fn(), disconnect: vi.fn(), get: vi.fn(), rotate: vi.fn(), list: vi.fn(),
  request: vi.fn(), cancel: vi.fn(), reassign: vi.fn(), label: vi.fn(), shipment: vi.fn(),
  orderFound: true,
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
vi.mock('@/lib/rate-limit', () => ({
  RATE_LIMITS: { adminAction: { limit: 30, windowMs: 60_000 } },
  checkRateLimit: () => ({ success: !h.limited }),
  rateLimitResponse: () => Response.json({}, { status: 429 }),
}));
vi.mock('@/lib/db/tenant', () => ({ withTenant: async (_ctx: unknown, fn: (tx: unknown) => unknown) =>
  fn({ $queryRaw: async () => (h.orderFound ? [{ id: ORDER }] : []) }) }));
vi.mock('@/lib/fulfilment/shiprocket-client', () => ({ shiprocketDisabled: () => h.disabled }));
vi.mock('@/lib/fulfilment/connection', () => ({
  getCourierConnection: h.get, saveCourierConnection: h.save, disconnectCourier: h.disconnect,
  rotateWebhookToken: h.rotate, listPickupLocations: h.list,
}));
vi.mock('@/lib/fulfilment/shipments', () => ({
  requestShipment: h.request, cancelShipment: h.cancel, reassignAwb: h.reassign, labelUrl: h.label, getOrderShipment: h.shipment,
}));

import { ShipmentError } from '@/lib/fulfilment/types';
import { DELETE, GET, PUT } from './route';
import { POST as rotate } from './webhook-token/route';
import { POST as test } from './test/route';
import { DELETE as cancelRoute, GET as shipmentGet, POST as createRoute } from '@/app/api/commerce/orders/[id]/shipment/route';
import { POST as awbRoute } from '@/app/api/commerce/orders/[id]/shipment/awb/route';
import { GET as labelRoute } from '@/app/api/commerce/orders/[id]/shipment/label/route';

const NOT_CONNECTED = { connected: false, status: null, api_email: null, pickup_location: null, default_length_cm: null,
  default_breadth_cm: null, default_height_cm: null, default_weight_grams: null, last_error_code: null, connected_at: null,
  webhook_token_set: false, webhook_url: null };
const req = (body: unknown, method = 'PUT') => new Request('http://localhost/x', { method, body: typeof body === 'string' ? body : JSON.stringify(body) });
const params = (id = ORDER) => ({ params: Promise.resolve({ id }) });
const actor = { accountId: ACCOUNT, userId: USER, role: 'admin' };

beforeEach(() => {
  vi.clearAllMocks();
  h.role = 'admin';
  h.limited = false;
  h.disabled = false;
  h.get.mockResolvedValue(NOT_CONNECTED);
  h.save.mockResolvedValue({ ...NOT_CONNECTED, connected: true, status: 'active' });
  h.shipment.mockResolvedValue(null);
});

describe('/api/integrations/shiprocket', () => {
  it('reports the connection to any member, never cached', async () => {
    h.role = 'viewer';
    const res = await GET();
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('private, no-store');
    expect(await res.json()).toMatchObject({ connected: false, available: true });
    h.disabled = true;
    expect(await (await GET()).json()).toMatchObject({ available: false });
  });

  it('saves only for admins, with a valid body, before the rate limit lets anything through', async () => {
    h.role = 'agent';
    expect((await PUT(req({ email: 'a@b.co', pickup_location: 'P' }))).status).toBe(403);
    h.role = 'admin';
    expect((await PUT(req('{bad'))).status).toBe(400);
    expect((await PUT(req({ email: 5, pickup_location: 'P' }))).status).toBe(400);
    expect((await PUT(req({ email: 'a@b.co', pickup_location: 'P', defaults: { length_cm: '10' } }))).status).toBe(400);
    h.limited = true;
    expect((await PUT(req({ email: 'a@b.co', pickup_location: 'P' }))).status).toBe(429);
    expect(h.save).not.toHaveBeenCalled();
    h.limited = false;
    const res = await PUT(req({ email: 'a@b.co', password: 'pw', pickup_location: 'P', defaults: { length_cm: 10, weight_grams: '' } }));
    expect(res.status).toBe(200);
    expect(h.save).toHaveBeenCalledWith(actor, { email: 'a@b.co', password: 'pw', pickup_location: 'P', defaults: { length_cm: 10 } });
  });

  it('translates service refusals into codes, never provider detail', async () => {
    for (const [code, status] of [['auth', 400], ['provider_unreachable', 502], ['not_configured', 503], ['invalid', 400]] as const) {
      h.save.mockRejectedValueOnce(new ShipmentError(code));
      const res = await PUT(req({ email: 'a@b.co', pickup_location: 'P' }));
      expect(res.status).toBe(status);
      const body = await res.json();
      expect(body.code).toBe(code);
      expect(typeof body.error).toBe('string');
    }
    h.save.mockRejectedValueOnce(new Error('Shiprocket said: password hunter2'));
    const res = await PUT(req({ email: 'a@b.co', pickup_location: 'P' }));
    expect(res.status).toBe(500);
    expect(JSON.stringify(await res.json())).not.toContain('hunter2');
  });

  it('disconnects, rotates the token and tests details for admins only', async () => {
    h.rotate.mockResolvedValue({ token: 'tok' });
    h.list.mockResolvedValue(['Primary']);
    expect((await DELETE()).status).toBe(200);
    expect(h.disconnect).toHaveBeenCalledWith(actor);
    const rotated = await rotate();
    expect(rotated.headers.get('Cache-Control')).toBe('private, no-store');
    expect(await rotated.json()).toEqual({ token: 'tok' });
    expect(await (await test(req({ email: 'a@b.co', password: 'pw' }, 'POST'))).json()).toEqual({ pickup_locations: ['Primary'] });
    expect((await test(req({ email: 5 }, 'POST'))).status).toBe(400);
    h.role = 'agent';
    expect((await DELETE()).status).toBe(403);
    expect((await rotate()).status).toBe(403);
    expect((await test(req({}, 'POST'))).status).toBe(403);
  });
});

describe('/api/commerce/orders/[id]/shipment', () => {
  it('reports the shipment to agents; viewers are refused', async () => {
    h.role = 'agent';
    const res = await shipmentGet(new Request('http://localhost/x'), params());
    expect(await res.json()).toEqual({ connected: false, shipment: null,
      defaults: { length_cm: null, breadth_cm: null, height_cm: null, weight_grams: null } });
    h.get.mockResolvedValueOnce({ ...NOT_CONNECTED, connected: true, status: 'active' });
    h.disabled = true;
    expect((await (await shipmentGet(new Request('http://localhost/x'), params())).json()).connected).toBe(false);
    h.role = 'viewer';
    expect((await shipmentGet(new Request('http://localhost/x'), params())).status).toBe(403);
    expect((await shipmentGet(new Request('http://localhost/x'), params('nope'))).status).toBe(404);
  });

  it("answers 404 for an order that is not in the caller's workspace, before reading any shipment", async () => {
    h.role = 'agent';
    h.orderFound = false;
    h.shipment.mockClear();
    const res = await shipmentGet(new Request('http://localhost/x'), params());
    h.orderFound = true;
    expect(res.status).toBe(404);
    expect(h.shipment).not.toHaveBeenCalled();
  });

  it('creates with numeric dimensions only and maps refusals', async () => {
    h.request.mockResolvedValueOnce({ shipmentId: 's1' });
    const ok = await createRoute(req({ length_cm: 10, breadth_cm: 10, height_cm: 10, weight_grams: 500 }, 'POST'), params());
    expect(ok.status).toBe(202);
    expect(h.request).toHaveBeenCalledWith(actor, ORDER, { length_cm: 10, breadth_cm: 10, height_cm: 10, weight_grams: 500 });
    expect((await createRoute(req({ length_cm: '10', breadth_cm: 10, height_cm: 10, weight_grams: 500 }, 'POST'), params())).status).toBe(400);
    for (const [code, status] of [['not_connected', 503], ['shipment_exists', 409], ['order_not_paid', 409], ['address_incomplete', 409]] as const) {
      h.request.mockRejectedValueOnce(new ShipmentError(code));
      const res = await createRoute(req({ length_cm: 10, breadth_cm: 10, height_cm: 10, weight_grams: 500 }, 'POST'), params());
      expect([res.status, (await res.json()).code]).toEqual([status, code]);
    }
    h.role = 'viewer';
    expect((await createRoute(req({}, 'POST'), params())).status).toBe(403);
  });

  it('cancels, assigns again and fetches a label through the services', async () => {
    h.label.mockResolvedValueOnce('https://label.example/x.pdf');
    expect((await cancelRoute(new Request('http://localhost/x', { method: 'DELETE' }), params())).status).toBe(200);
    expect(h.cancel).toHaveBeenCalledWith(actor, ORDER);
    expect((await awbRoute(new Request('http://localhost/x', { method: 'POST' }), params())).status).toBe(202);
    expect(h.reassign).toHaveBeenCalledWith(actor, ORDER);
    expect(await (await labelRoute(new Request('http://localhost/x'), params())).json()).toEqual({ url: 'https://label.example/x.pdf' });
    h.limited = true;
    expect((await labelRoute(new Request('http://localhost/x'), params())).status).toBe(429);
    expect((await cancelRoute(new Request('http://localhost/x', { method: 'DELETE' }), params())).status).toBe(429);
  });
});
