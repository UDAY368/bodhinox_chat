import { beforeEach, describe, expect, it, vi } from 'vitest';

const ACCOUNT = '11111111-1111-4111-8111-111111111111';
const h = vi.hoisted(() => ({
  role: 'viewer' as string, signedIn: true, limited: false, tenants: [] as unknown[], calls: [] as unknown[][],
  revenue: [] as unknown[], conversions: [] as unknown[][], flowRows: [] as Array<{ id: string | null }>,
  ctrWindows: [] as unknown[][],
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
      return { totals: { comments: 0 }, rows: h.flowRows };
    },
  };
});

vi.mock('@/lib/instagram/contact-series', async (original) => ({
  ...(await original<typeof import('@/lib/instagram/contact-series')>()),
  instagramContactSeries: async () => [{ day: '2026-11-01', active: 1, inactive: 2, total: 3 }],
}));
vi.mock('@/lib/instagram/revenue', async (original) => ({
  ...(await original<typeof import('@/lib/instagram/revenue')>()),
  instagramRevenue: async (...args: unknown[]) => { h.revenue.push(args[3]); return { visible: false, currencies: [] }; },
}));
vi.mock('@/lib/analytics/conversion-log', async (original) => ({
  ...(await original<typeof import('@/lib/analytics/conversion-log')>()),
  conversionCounts: async (...args: unknown[]) => { h.conversions.push(args.slice(1)); return []; },
}));
vi.mock('@/lib/flows/link-tracking', async (original) => ({
  ...(await original<typeof import('@/lib/flows/link-tracking')>()),
  flowLinkStats: async (_tx: unknown, _account: string, ids: string[], since?: Date, until?: Date) => {
    h.ctrWindows.push([since, until]);
    return new Map(ids.map((id) => [id, { sent: 4, clicked: 1 }]));
  },
}));

import { GET } from './route';

const get = (query = '') => GET(new Request(`http://x/api/analytics/instagram?${query}`));

beforeEach(() => {
  h.role = 'viewer'; h.signedIn = true; h.limited = false; h.tenants = []; h.calls = [];
  h.revenue = []; h.conversions = []; h.flowRows = []; h.ctrWindows = [];
});

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

  it('adds the contact series, revenue (with the contact total), Instagram conversions and per-flow CTR', async () => {
    h.flowRows = [{ id: 'f1' }, { id: null }];
    const body = await (await get('by=flow')).json();
    expect(body.contacts).toEqual([{ day: '2026-11-01', active: 1, inactive: 2, total: 3 }]);
    expect(body.revenue).toEqual({ visible: false, currencies: [] });
    expect(h.revenue).toEqual([3]);
    expect(h.conversions[0][0]).toBe(ACCOUNT);
    expect(h.conversions[0][2]).toBe('instagram');
    expect(body.ctr).toEqual({ f1: 25 });
    // CTR counts only links sent inside the chosen range.
    const [since, until] = h.ctrWindows[0] as [Date, Date];
    expect(since).toBeInstanceOf(Date);
    expect(until).toBeInstanceOf(Date);
    expect(until.getTime()).toBeGreaterThan(since.getTime());
    // By post there is no per-flow CTR.
    expect((await (await get()).json()).ctr).toEqual({});
  });

  it('rate-limits reads', async () => {
    h.limited = true;
    expect((await get()).status).toBe(429);
    expect(h.calls).toEqual([]);
  });
});
