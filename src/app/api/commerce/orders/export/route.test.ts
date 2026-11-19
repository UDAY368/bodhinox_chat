import { beforeEach, describe, expect, it, vi } from 'vitest';

const ACCOUNT = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';
const h = vi.hoisted(() => ({ role: 'admin', exportOrdersCsv: vi.fn(), limited: false }));

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
vi.mock('@/lib/commerce/order-export', () => ({ exportOrdersCsv: h.exportOrdersCsv }));

import { GET } from './route';

const get = (query = '') => GET(new Request(`http://localhost/api/commerce/orders/export${query}`));

beforeEach(() => {
  vi.clearAllMocks();
  h.role = 'admin';
  h.limited = false;
  h.exportOrdersCsv.mockResolvedValue({ csv: '"order"\r\n', rows: 0, truncated: false });
});

describe('GET /api/commerce/orders/export', () => {
  it.each(['agent', 'viewer'])('refuses a %s and exports nothing', async (role) => {
    h.role = role;
    expect((await get()).status).toBe(403);
    expect(h.exportOrdersCsv).not.toHaveBeenCalled();
  });

  it.each(['admin', 'owner'])('gives a %s a private CSV download for their workspace and the filters', async (role) => {
    h.role = role;
    const res = await get('?status=paid&source=storefront&tag=vip&q=3F2A9C1B&cod_confirmation=pending&from=2026-11-01&to=2026-11-30');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/csv');
    expect(res.headers.get('content-disposition')).toContain('attachment');
    expect(res.headers.get('cache-control')).toBe('private, no-store');
    expect(await res.text()).toBe('"order"\r\n');
    const [ctx, filters] = h.exportOrdersCsv.mock.calls[0];
    expect(ctx).toMatchObject({ accountId: ACCOUNT, userId: USER, role });
    expect(filters).toMatchObject({ status: 'paid', source: 'storefront', tag: 'vip', q: '3F2A9C1B', codConfirmation: 'pending' });
    expect(filters.from).toBeInstanceOf(Date);
  });

  it('says when the cap cut the file, refuses a bad filter and honours the rate limit', async () => {
    h.exportOrdersCsv.mockResolvedValue({ csv: '"order"\r\n', rows: 5000, truncated: true });
    expect((await get()).headers.get('x-truncated')).toBe('1');
    expect((await get('?status=nope')).status).toBe(400);
    h.limited = true;
    expect((await get()).status).toBe(429);
  });
});
