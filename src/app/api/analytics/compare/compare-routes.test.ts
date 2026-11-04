import { beforeEach, describe, expect, it, vi } from 'vitest';

const ACCOUNT = '11111111-1111-4111-8111-111111111111';
const A = '33333333-3333-4333-8333-333333333331';
const B = '33333333-3333-4333-8333-333333333332';
const h = vi.hoisted(() => ({
  role: 'viewer' as string,
  signedIn: true,
  limited: false,
  tenants: [] as unknown[],
  calls: [] as { name: string; args: unknown[] }[],
  appointmentError: false,
}));

vi.mock('@/lib/auth/session', () => ({
  requireSession: async () => {
    const { UnauthorizedError } = await import('@/lib/auth/errors');
    if (!h.signedIn) throw new UnauthorizedError();
    return { userId: '22222222-2222-4222-8222-222222222222', accountId: ACCOUNT, role: h.role, sessionId: 's' };
  },
}));
vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: () => (h.limited ? { success: false, reset: Date.now() + 1000 } : { success: true }),
  rateLimitResponse: () => new Response(null, { status: 429 }),
}));
vi.mock('@/lib/analytics/queries', async (original) => {
  const actual = await original<typeof import('@/lib/analytics/queries')>();
  return {
    ...actual,
    runAnalytics: async (context: unknown, operation: (tx: unknown, tz: string) => Promise<unknown>) => {
      h.tenants.push(context);
      // The real campaignFunnel validates ids before it queries; this tx returns one funnel.
      const tx = { $queryRaw: async () => [{ funnel: { totals: {}, broadcasts: [{ id: A, name: 'A', sent: 1 }] } }] };
      return operation(tx, 'Asia/Kolkata');
    },
  };
});
vi.mock('@/lib/analytics/products', () => ({
  productStats: async (...args: unknown[]) => {
    h.calls.push({ name: 'productStats', args: args.slice(1) });
    return [{ key: 'sku', name: 'Oil', currency: 'INR', orders: 1, units: 2, grossMinor: 100, discountsMinor: 0, refundsMinor: 0, netMinor: 100 }];
  },
}));
vi.mock('@/lib/appointments/stats', async (original) => ({
  ...(await original<typeof import('@/lib/appointments/stats')>()),
  appointmentStats: async (...args: unknown[]) => {
    h.calls.push({ name: 'appointmentStats', args: args.slice(1) });
    if (h.appointmentError) {
      const { AppointmentError } = await import('@/lib/appointments/types');
      throw new AppointmentError('invalid');
    }
    const row = (service: string, name: string, day: string, booked: number, completed: number, noShow: number) =>
      ({ service_id: service, service_name: name, day, booked, confirmed: booked, cancelled: 0, completed, no_show: noShow });
    return { rows: [row(A, 'Consult', '2026-11-01', 2, 1, 1), row(A, 'Consult', '2026-11-02', 3, 3, 0), row(B, 'Adjust', '2026-11-01', 1, 0, 0)], totals: {} };
  },
}));

import { GET as campaigns } from './campaigns/route';
import { GET as products } from './products/route';
import { GET as services } from './services/route';

const get = (handler: (r: Request) => Promise<Response>, path: string) => handler(new Request(`http://x/api/analytics/compare/${path}`));

beforeEach(() => {
  h.role = 'viewer';
  h.signedIn = true;
  h.limited = false;
  h.tenants = [];
  h.calls = [];
  h.appointmentError = false;
});

describe('analytics comparison routes', () => {
  it('require a session and respect the rate limit', async () => {
    h.signedIn = false;
    for (const [handler, path] of [[campaigns, `campaigns?ids=${A},${B}`], [products, 'products'], [services, 'services']] as const)
      expect((await get(handler, path)).status).toBe(401);
    h.signedIn = true;
    h.limited = true;
    expect((await get(services, 'services')).status).toBe(429);
    expect(h.calls).toEqual([]);
    expect(h.tenants).toEqual([]);
  });

  it('compares 2-5 campaigns for viewers, in their own workspace, never cached', async () => {
    const res = await get(campaigns, `campaigns?ids=${A},${B}&preset=this_month`);
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    const body = await res.json();
    expect(body.campaigns).toEqual([{ id: A, name: 'A', sent: 1 }]);
    expect(body.range.preset).toBe('this_month');
    expect(h.tenants).toEqual([{ accountId: ACCOUNT, userId: '22222222-2222-4222-8222-222222222222', role: 'viewer' }]);
  });

  it('refuses a malformed, too short or too long campaign list with 400', async () => {
    for (const ids of ['', A, `${A},nope`, `${A},${A}`, Array.from({ length: 6 }, (_, i) => `${A.slice(0, -1)}${i}`).join(','), 'x'.repeat(500)])
      expect((await get(campaigns, `campaigns?ids=${encodeURIComponent(ids)}`)).status).toBe(400);
  });

  it('shows products to agents and above only', async () => {
    expect((await get(products, 'products')).status).toBe(403);
    expect(h.calls).toEqual([]);
    h.role = 'agent';
    const res = await get(products, 'products?preset=last_week');
    expect(res.status).toBe(200);
    expect((await res.json()).products[0].key).toBe('sku');
    const call = h.calls[0];
    expect(call.name).toBe('productStats');
    expect(call.args[0]).toBe(ACCOUNT);
    expect((call.args[1] as { preset: string }).preset).toBe('last_week');
  });

  it('aggregates appointment outcomes per service over the local days of the range', async () => {
    const res = await get(services, 'services?from=2026-10-01&to=2026-10-31');
    expect(res.status).toBe(200);
    expect(h.calls[0].args).toEqual([ACCOUNT, { from: '2026-10-01', to: '2026-10-31' }]);
    expect((await res.json()).services).toEqual([
      { serviceId: A, name: 'Consult', booked: 5, confirmed: 5, cancelled: 0, completed: 4, noShow: 1, noShowRate: 0.2 },
      { serviceId: B, name: 'Adjust', booked: 1, confirmed: 1, cancelled: 0, completed: 0, noShow: 0, noShowRate: null },
    ]);
  });

  it('maps an invalid range to 400', async () => {
    expect((await get(services, 'services?preset=year')).status).toBe(400);
    h.appointmentError = true;
    expect((await get(services, 'services?preset=7d')).status).toBe(400);
  });
});
