import { beforeEach, describe, expect, it, vi } from 'vitest';

const ACCOUNT = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';
const EXC = '55555555-5555-4555-8555-555555555555';
const h = vi.hoisted(() => ({
  role: 'admin', allowed: true, limited: false,
  list: vi.fn(async () => [] as unknown[]),
  resolve: vi.fn(async () => ({ id: 'e' })),
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
vi.mock('@/lib/auth/permissions', async () => {
  const { ForbiddenError } = await import('@/lib/auth/errors');
  return { requirePermission: async () => { if (!h.allowed) throw new ForbiddenError('This feature is turned off for your role'); } };
});
vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: () => ({ success: !h.limited }),
  rateLimitResponse: () => Response.json({}, { status: 429 }),
}));
vi.mock('@/lib/db/tenant', () => ({ withTenant: async (_ctx: unknown, fn: (tx: unknown) => Promise<unknown>) => fn({}) }));
vi.mock('@/lib/fulfilment/exceptions', () => ({ listShipmentExceptions: h.list, resolveShipmentException: h.resolve }));

import { ShipmentError } from '@/lib/fulfilment/types';
import { GET } from './route';
import { POST } from './[id]/route';

const post = (body: unknown) => POST(new Request('http://localhost/x', { method: 'POST', body: JSON.stringify(body) }), { params: Promise.resolve({ id: EXC }) });

beforeEach(() => {
  vi.clearAllMocks();
  h.role = 'admin';
  h.allowed = true;
  h.limited = false;
});

describe('shipment exception routes', () => {
  it('lists open exceptions for admins with commerce.shipments, uncached', async () => {
    const res = await GET(new Request('http://localhost/x'));
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('private, no-store');
    expect(h.list).toHaveBeenCalledWith({}, ACCOUNT, { status: 'open', limit: 50 });
    expect((await GET(new Request('http://localhost/x?status=weird'))).status).toBe(400);
  });

  it('refuses agents, and admins whose role has commerce.shipments turned off', async () => {
    h.role = 'agent';
    expect((await GET(new Request('http://localhost/x'))).status).toBe(403);
    expect((await post({ resolution: 'dismiss' })).status).toBe(403);
    h.role = 'admin';
    h.allowed = false;
    expect((await GET(new Request('http://localhost/x'))).status).toBe(403);
    expect((await post({ resolution: 'dismiss' })).status).toBe(403);
    expect(h.resolve).not.toHaveBeenCalled();
  });

  it('resolves with a known resolution only, and passes service codes through', async () => {
    expect((await post({ resolution: 'accept_correction' })).status).toBe(200);
    expect(h.resolve).toHaveBeenCalledWith({ accountId: ACCOUNT, userId: USER, role: 'admin' }, EXC, 'accept_correction');
    expect((await post({ resolution: 'delete_everything' })).status).toBe(400);
    h.resolve.mockRejectedValueOnce(new ShipmentError('conflict'));
    const res = await post({ resolution: 'dismiss' });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'conflict' });
    h.limited = true;
    expect((await post({ resolution: 'dismiss' })).status).toBe(429);
  });
});
