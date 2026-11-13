// The analytics redesign's read routes: trends, attention, team and automations.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ role: 'viewer', calls: [] as { fn: string; args: unknown[] }[], member: true as boolean }));

vi.mock('@/lib/auth/session', () => ({
  requireSession: async () => ({ userId: '22222222-2222-4222-8222-222222222222', accountId: '11111111-1111-4111-8111-111111111111', role: h.role, sessionId: 's' }),
}));
vi.mock('@/lib/analytics/queries', async (original) => ({
  ...(await original<typeof import('@/lib/analytics/queries')>()),
  runAnalytics: async (_ctx: unknown, op: (tx: unknown, tz: string) => unknown) => op({}, 'UTC'),
}));
vi.mock('@/lib/analytics/insights', async (original) => {
  const actual = await original<typeof import('@/lib/analytics/insights')>();
  const fake = (fn: string, result: unknown) => async (...args: unknown[]) => {
    h.calls.push({ fn, args: args.slice(1) });
    return typeof result === 'function' ? (result as () => unknown)() : result;
  };
  return {
    ...actual,
    trendReport: fake('trend', { bucket: 'day' }),
    messageTotals: fake('messages', { msgs: 1, failed: 0 }),
    attentionCounts: fake('attention', { unowned: 1 }),
    teamStats: fake('team', []),
    memberDetail: fake('member', () => (h.member ? { bucket: 'day' } : null)),
    automationStats: fake('automations', { top: [], byKind: { flow: 0, rule: 0, sequence: 0 }, total: 3 }),
  };
});

import { __resetRateLimitForTests } from '@/lib/rate-limit';
import { GET as TRENDS } from './trends/route';
import { GET as ATTENTION } from './attention/route';
import { GET as TEAM } from './team/route';
import { GET as AUTOMATIONS } from './automations/route';

const A = '11111111-1111-4111-8111-111111111111';
const M = '33333333-3333-4333-8333-333333333333';
const get = (route: (r: Request) => Promise<Response>, query: string) => route(new Request(`http://x/api/analytics/x?${query}`));

beforeEach(() => {
  Object.assign(h, { role: 'viewer', calls: [], member: true });
  __resetRateLimitForTests();
});

describe('analytics insight routes', () => {
  it('answer viewers with the workspace\'s figures and the range, never cached', async () => {
    const trends = await get(TRENDS, 'preset=7d&channel=whatsapp');
    expect(trends.status).toBe(200);
    expect(trends.headers.get('Cache-Control')).toBe('no-store');
    const body = await trends.json();
    expect(body.range.days).toBe(7);
    expect(body.previousRange.days).toBe(7);
    expect(h.calls.find((c) => c.fn === 'trend')?.args[0]).toBe(A);
    expect(h.calls.find((c) => c.fn === 'trend')?.args[2]).toEqual({ channel: 'whatsapp', whatsappConfigId: null });
    expect((await get(ATTENTION, '')).status).toBe(200);
    expect((await get(TEAM, 'preset=30d')).status).toBe(200);
    const automations = await get(AUTOMATIONS, 'preset=30d');
    expect(await automations.json()).toMatchObject({ automations: { total: 3 }, previousTotal: 3 });
  });

  it('refuse invalid filters with 400 before running a query', async () => {
    for (const route of [TRENDS, ATTENTION, TEAM, AUTOMATIONS]) {
      expect((await get(route, 'channel=sms')).status).toBe(400);
      expect((await get(route, "number=1' OR '1")).status).toBe(400);
    }
    expect((await get(TRENDS, 'preset=forever')).status).toBe(400);
    expect(h.calls).toEqual([]);
  });

  it('drops the number filter for Instagram, and 404s a member detail outside the workspace', async () => {
    await get(TRENDS, `channel=instagram&number=${M}`);
    expect(h.calls.find((c) => c.fn === 'trend')?.args[2]).toEqual({ channel: 'instagram', whatsappConfigId: null });
    expect((await get(TEAM, `member=${M}`)).status).toBe(200);
    h.member = false;
    expect((await get(TEAM, `member=${M}`)).status).toBe(404);
  });
});
