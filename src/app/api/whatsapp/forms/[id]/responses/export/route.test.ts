import { beforeEach, expect, it, vi } from 'vitest';

const ACCOUNT = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';
const FORM = '33333333-3333-4333-8333-333333333333';
const h = vi.hoisted(() => ({ role: 'admin', exportResponsesCsv: vi.fn() }));

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
  checkRateLimit: () => ({ success: true }),
  rateLimitResponse: () => Response.json({}, { status: 429 }),
}));
vi.mock('@/lib/whatsapp/forms/service', async (original) => ({
  ...(await original<typeof import('@/lib/whatsapp/forms/service')>()),
  exportResponsesCsv: h.exportResponsesCsv,
}));

import { GET } from './route';

const get = () => GET(new Request('http://localhost/e'), { params: Promise.resolve({ id: FORM }) });

beforeEach(() => {
  vi.clearAllMocks();
  h.role = 'admin';
  h.exportResponsesCsv.mockResolvedValue({ csv: '"a"\r\n', rows: 0, name: '=evil"name' });
});

it('downloads CSV for admins without putting the form name in the filename', async () => {
  const res = await get();
  expect(res.status).toBe(200);
  expect(res.headers.get('content-type')).toContain('text/csv');
  expect(res.headers.get('cache-control')).toBe('no-store');
  expect(res.headers.get('content-disposition')).toMatch(/^attachment; filename="form-responses-\d{4}-\d{2}-\d{2}\.csv"$/);
  expect(await res.text()).toBe('"a"\r\n');
});

it('refuses agents and viewers', async () => {
  for (const role of ['agent', 'viewer']) {
    h.role = role;
    expect((await get()).status).toBe(403);
  }
  expect(h.exportResponsesCsv).not.toHaveBeenCalled();
});
