import { beforeEach, describe, expect, it, vi } from 'vitest';

const ACCOUNT = '11111111-1111-4111-8111-111111111111';
const h = vi.hoisted(() => ({
  role: 'viewer' as string, signedIn: true, limited: false, tenants: [] as unknown[], calls: [] as unknown[][],
}));

vi.mock('@/lib/auth/session', () => ({
  requireSession: async () => {
    const { UnauthorizedError } = await import('@/lib/auth/errors');
    if (!h.signedIn) throw new UnauthorizedError();
    return { userId: '22222222-2222-4222-8222-222222222222', accountId: '11111111-1111-4111-8111-111111111111',
      role: h.role, sessionId: 's', user: { id: 'u', email: 'a@b.test', user_metadata: { full_name: 'A' } } };
  },
}));
vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: () => (h.limited ? { success: false, reset: Date.now() + 1000 } : { success: true }),
  rateLimitResponse: () => new Response(JSON.stringify({ error: 'slow down' }), { status: 429 }),
}));
vi.mock('@/lib/analytics/queries', async (original) => {
  const actual = await original<typeof import('@/lib/analytics/queries')>();
  return {
    ...actual,
    runAnalytics: async (context: unknown, operation: (tx: unknown, tz: string) => Promise<unknown>) => {
      h.tenants.push(context);
      return operation({}, 'Asia/Kolkata');
    },
  };
});
vi.mock('@/lib/instagram/funnel', async (original) => {
  const actual = await original<typeof import('@/lib/instagram/funnel')>();
  return {
    ...actual,
    commentFunnel: async (...args: unknown[]) => {
      h.calls.push(args.slice(1));
      return { totals: { comments: 0 }, rows: [] };
    },
  };
});

import { GET } from './route';

const get = (query = '') => GET(new Request(`http://x/api/analytics/instagram?${query}`));

beforeEach(() => { h.role = 'viewer'; h.signedIn = true; h.limited = false; h.tenants = []; h.calls = []; });

describe('GET /api/analytics/instagram', () => {
  it('requires a session', async () => {
    h.signedIn = false;
    expect((await get()).status).toBe(401);
    expect(h.calls).toEqual([]);
  });

  it('lets viewers read their own workspace funnel, uncached, grouped by post by default', async () => {
    const res = await get('preset=7d');
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect(await res.json()).toMatchObject({ by: 'post', range: { preset: '7d' }, funnel: { rows: [] } });
    expect(h.tenants).toEqual([expect.objectContaining({ accountId: ACCOUNT })]);
    expect(h.calls[0][0]).toBe(ACCOUNT);
    expect(h.calls[0][2]).toBe('post');
  });

  it('groups by flow and refuses any other grouping or range', async () => {
    await get('by=flow');
    expect(h.calls[0][2]).toBe('flow');
    expect((await get('by=commenter')).status).toBe(400);
    expect((await get('preset=year')).status).toBe(400);
  });

  it('rate-limits reads', async () => {
    h.limited = true;
    expect((await get()).status).toBe(429);
    expect(h.calls).toEqual([]);
  });
});
