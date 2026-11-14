import { beforeEach, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ enabled: true, mutationOk: true, sessions: 0, calls: [] as unknown[][] }));

vi.mock('@/lib/auth/session', () => ({
  requireSession: async () => {
    h.sessions++;
    return { userId: '22222222-2222-4222-8222-222222222222', accountId: '11111111-1111-4111-8111-111111111111', role: 'admin', sessionId: 's' };
  },
  assertMutation: async () => {
    if (!h.mutationOk) throw new (await import('@/lib/auth/errors')).UnauthorizedError();
  },
}));
vi.mock('@/lib/meta-ads/config', () => ({ metaAdsConfig: () => (h.enabled ? { appId: '1' } : null), metaAdsManageEnabled: () => true }));
vi.mock('@/lib/meta-ads/rules', async (original) => ({
  ...(await original<typeof import('@/lib/meta-ads/rules')>()),
  listAdRules: async () => ({ rules: [{ id: 'r1' }], actions: [] }),
  createAdRule: async (...args: unknown[]) => { h.calls.push(['create', args[1]]); return { id: 'r2' }; },
  setAdRuleEnabled: async (...args: unknown[]) => { h.calls.push(['enable', args[1], args[2]]); return { id: args[1] }; },
  deleteAdRule: async (...args: unknown[]) => { h.calls.push(['delete', args[1]]); },
}));
vi.mock('@/lib/meta-ads/create', async (original) => ({
  ...(await original<typeof import('@/lib/meta-ads/create')>()),
  searchAdTargeting: async (...args: unknown[]) => { h.calls.push(['search', args[1], args[2]]); return [{ id: '600' }]; },
}));

import { __resetRateLimitForTests } from '@/lib/rate-limit';
import { GET, POST } from './route';
import { GET as SEARCH } from '../targeting/route';

const post = (body: unknown) => POST(new Request('http://x/api/meta-ads/rules', { method: 'POST', body: JSON.stringify(body) }));
const ID = '33333333-3333-4333-8333-333333333333';
const rule = { action: 'create', name: 'Stop', level: 'adset', metric: 'cost_per_result', operator: 'gt', threshold: 200, windowDays: 3, ruleAction: 'pause' };

beforeEach(() => {
  Object.assign(h, { enabled: true, mutationOk: true, sessions: 0, calls: [] });
  __resetRateLimitForTests();
});

it('answers 503 before any session work while disabled', async () => {
  h.enabled = false;
  expect((await GET(new Request('http://x/api/meta-ads/rules'))).status).toBe(503);
  expect((await post(rule)).status).toBe(503);
  expect((await SEARCH(new Request('http://x/api/meta-ads/targeting?type=interest&q=yoga'))).status).toBe(503);
  expect(h.sessions).toBe(0);
});

it('lists rules for any member; mutations need the origin check first', async () => {
  expect(await (await GET(new Request('http://x/api/meta-ads/rules'))).json()).toEqual({ rules: [{ id: 'r1' }], actions: [] });
  h.mutationOk = false;
  expect((await post(rule)).status).toBe(401);
  expect(h.calls).toEqual([]);
});

it('creates a rule from ruleAction (201) and validates the rest', async () => {
  expect((await post({ ...rule, ruleAction: 'delete' })).status).toBe(400);
  expect((await post({ ...rule, windowDays: 30 })).status).toBe(400);
  expect((await post(rule)).status).toBe(201);
  expect(h.calls[0]).toEqual(['create', { name: 'Stop', level: 'adset', metric: 'cost_per_result', operator: 'gt', threshold: 200, windowDays: 3, minSpend: 0, action: 'pause' }]);
});

it('switches and deletes by a well-formed id', async () => {
  expect((await post({ action: 'enable', id: 'x', enabled: true })).status).toBe(400);
  expect((await post({ action: 'enable', id: ID, enabled: 'yes' })).status).toBe(400);
  expect((await post({ action: 'enable', id: ID, enabled: false })).status).toBe(200);
  expect((await post({ action: 'delete', id: ID })).status).toBe(200);
  expect(h.calls).toEqual([['enable', ID, false], ['delete', ID]]);
});

it('targeting search takes a known type and a short query', async () => {
  expect((await SEARCH(new Request('http://x/api/meta-ads/targeting?type=behaviour&q=yoga'))).status).toBe(400);
  expect((await SEARCH(new Request(`http://x/api/meta-ads/targeting?type=interest&q=${'y'.repeat(101)}`))).status).toBe(400);
  const res = await SEARCH(new Request('http://x/api/meta-ads/targeting?type=place&q=Mumbai'));
  expect(await res.json()).toEqual({ options: [{ id: '600' }] });
  expect(h.calls).toEqual([['search', 'place', 'Mumbai']]);
});
