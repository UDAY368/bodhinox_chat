import { beforeEach, describe, expect, it, vi } from 'vitest';

const ACCOUNT = '11111111-1111-4111-8111-111111111111';
const h = vi.hoisted(() => ({ role: 'viewer' as string, signedIn: true, calls: [] as unknown[][] }));

vi.mock('@/lib/auth/session', () => ({
  requireSession: async () => {
    const { UnauthorizedError } = await import('@/lib/auth/errors');
    if (!h.signedIn) throw new UnauthorizedError();
    return { userId: '22222222-2222-4222-8222-222222222222', accountId: ACCOUNT, role: h.role, sessionId: 's' };
  },
}));
vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: () => ({ success: true }),
  rateLimitResponse: () => new Response(null, { status: 429 }),
}));
vi.mock('@/lib/analytics/queries', async (original) => ({
  ...(await original<typeof import('@/lib/analytics/queries')>()),
  runAnalytics: async (_context: unknown, operation: (tx: unknown, tz: string) => Promise<unknown>) => operation({}, 'Asia/Kolkata'),
}));
vi.mock('@/lib/analytics/commerce', () => ({
  commerceStats: async (...args: unknown[]) => {
    h.calls.push(args.slice(1));
    return { currencies: [], daily: [] };
  },
}));

import { GET } from './route';

const get = (query = '') => GET(new Request(`http://x/api/analytics/commerce${query}`));

beforeEach(() => {
  h.role = 'viewer';
  h.signedIn = true;
  h.calls = [];
});

describe('GET /api/analytics/commerce', () => {
  it('needs a session and the agent role (payments are hidden from viewers)', async () => {
    h.signedIn = false;
    expect((await get()).status).toBe(401);
    h.signedIn = true;
    expect((await get()).status).toBe(403);
    expect(h.calls).toEqual([]);
  });

  it('reports the caller workspace only, never cached', async () => {
    h.role = 'agent';
    const res = await get('?preset=30d');
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    const body = await res.json();
    expect(body).toMatchObject({ stats: { currencies: [], daily: [] }, range: { preset: '30d', timezone: 'Asia/Kolkata' } });
    expect(h.calls[0][0]).toBe(ACCOUNT);
  });
});
