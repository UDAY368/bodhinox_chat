import { beforeEach, describe, expect, it, vi } from 'vitest';

const ACCOUNT = '11111111-1111-4111-8111-111111111111';
const h = vi.hoisted(() => ({
  role: 'viewer' as string,
  signedIn: true,
  tenants: [] as unknown[],
  calls: [] as { name: string; args: unknown[] }[],
  sql: [] as string[],
  limited: false,
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
  const record = (name: string, result: unknown) => async (...args: unknown[]) => {
    h.calls.push({ name, args: args.slice(1) });
    return result;
  };
  return {
    ...actual,
    runAnalytics: async (context: unknown, operation: (tx: unknown, tz: string) => Promise<unknown>) => {
      h.tenants.push(context);
      const tx = { $queryRaw: async (sql: { strings?: string[] }) => { h.sql.push((sql.strings ?? []).join('?')); return []; } };
      return operation(tx, 'Asia/Kolkata');
    },
    conversationStats: async (...args: unknown[]) => {
      const filters = args[3] as { whatsappConfigId?: string | null };
      if (filters?.whatsappConfigId && filters.whatsappConfigId.length !== 36) throw new actual.AnalyticsInputError('Invalid number');
      h.calls.push({ name: 'conversationStats', args: args.slice(1) });
      return { started: { total: 1 } };
    },
    agentLeaderboard: record('agentLeaderboard', [{ userId: 'u', name: 'A', role: 'agent' }]),
    campaignFunnel: record('campaignFunnel', { totals: {}, broadcasts: [] }),
    flowStats: record('flowStats', { started: 0, dropOff: [] }),
    aiStats: record('aiStats', { aiReplies: 0 }),
  };
});

import { GET as overview } from './overview/route';
import { GET as agents } from './agents/route';
import { GET as campaigns } from './campaigns/route';
import { GET as flows } from './flows/route';
import { GET as ai } from './ai/route';

const get = (handler: (r: Request) => Promise<Response>, path: string) => handler(new Request(`http://x/api/analytics/${path}`));

beforeEach(() => {
  h.role = 'viewer';
  h.signedIn = true;
  h.limited = false;
  h.tenants = [];
  h.calls = [];
  h.sql = [];
});

describe('analytics report routes', () => {
  it('requires a session', async () => {
    h.signedIn = false;
    for (const [handler, path] of [[overview, 'overview'], [agents, 'agents'], [campaigns, 'campaigns'], [flows, 'flows'], [ai, 'ai']] as const)
      expect((await get(handler, path)).status).toBe(401);
    expect(h.calls).toEqual([]);
  });

  it('lets viewers read conversation, agent, campaign and flow reports, scoped to their workspace', async () => {
    for (const [handler, path] of [[overview, 'overview'], [agents, 'agents'], [campaigns, 'campaigns'], [flows, 'flows']] as const) {
      const res = await get(handler, `${path}?preset=7d`);
      expect(res.status).toBe(200);
      expect(res.headers.get('Cache-Control')).toBe('no-store');
      const body = await res.json();
      expect(body.range).toMatchObject({ preset: '7d', days: 7, timezone: 'Asia/Kolkata' });
    }
    expect(h.tenants.every((c) => (c as { accountId: string }).accountId === ACCOUNT)).toBe(true);
    expect(h.calls.every((c) => c.args[0] === ACCOUNT)).toBe(true);
  });

  it('keeps the AI report to agents and above', async () => {
    expect((await get(ai, 'ai')).status).toBe(403);
    h.role = 'agent';
    const res = await get(ai, 'ai?preset=30d');
    expect(res.status).toBe(200);
    expect((await res.json()).stats).toEqual({ aiReplies: 0 });
  });

  it('compares the overview with the same-length period before it and filters by number', async () => {
    const number = '33333333-3333-4333-8333-333333333333';
    const res = await get(overview, `overview?from=2026-10-01&to=2026-10-10&number=${number}`);
    const body = await res.json();
    expect(body.range).toMatchObject({ startDay: '2026-10-01', endDay: '2026-10-10', days: 10 });
    expect(body.previousRange).toMatchObject({ startDay: '2026-09-21', endDay: '2026-09-30', days: 10 });
    const stats = h.calls.filter((c) => c.name === 'conversationStats');
    expect(stats).toHaveLength(2);
    expect(stats.every((c) => (c.args[2] as { whatsappConfigId: string }).whatsappConfigId === number)).toBe(true);
    // The number filter lists ids and display names only, never phone numbers or tokens.
    const numberSql = h.sql.find((s) => s.includes('whatsapp_config'))!;
    expect(numberSql).toMatch(/SELECT id, display_name AS label, is_default/);
    expect(numberSql).not.toMatch(/phone|token/);
  });

  it('rejects bad ranges and filters with 400', async () => {
    expect((await get(overview, 'overview?preset=year')).status).toBe(400);
    expect((await get(overview, 'overview?from=2026-10-10&to=2026-10-01')).status).toBe(400);
    expect((await get(overview, 'overview?number=nope')).status).toBe(400);
  });

  it('passes a single campaign or flow filter through', async () => {
    const id = '44444444-4444-4444-8444-444444444444';
    await get(campaigns, `campaigns?broadcast=${id}`);
    await get(flows, `flows?flow=${id}`);
    expect(h.calls.find((c) => c.name === 'campaignFunnel')!.args[1]).toEqual({ broadcastId: id });
    expect(h.calls.find((c) => c.name === 'flowStats')!.args[2]).toBe(id);
  });

  it('rate-limits report reads', async () => {
    h.limited = true;
    expect((await get(agents, 'agents')).status).toBe(429);
    expect(h.calls).toEqual([]);
  });
});
