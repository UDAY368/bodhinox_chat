import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  enabled: true,
  connection: null as null | Record<string, unknown>,
  queries: [] as { sql: string; values: unknown[] }[],
}));

vi.mock('./config', async (original) => ({
  ...(await original<typeof import('./config')>()),
  metaAdsConfig: () => (h.enabled ? { appId: '1', appSecret: 's', loginConfigId: '2', pageWebhookVerifyToken: null } : null),
}));
const run = (strings: TemplateStringsArray, ...values: unknown[]) => {
  const sql = strings.join('?');
  h.queries.push({ sql, values });
  return Promise.resolve(/FOR UPDATE/.test(sql) ? [{ id: 'c1' }] : []);
};
const tx = { $queryRaw: run, $executeRaw: (s: TemplateStringsArray, ...v: unknown[]) => run(s, ...v).then(() => 1) };
vi.mock('@/lib/db/tenant', () => ({ withTenant: async (_c: unknown, op: (t: typeof tx) => unknown) => op(tx) }));
vi.mock('@/lib/db/prisma', () => ({ getWorkerPrisma: () => tx }));
vi.mock('./connection', () => ({ loadActiveConnectionTx: async () => h.connection }));
vi.mock('./graph', async (original) => ({
  ...(await original<typeof import('./graph')>()),
  listCampaigns: vi.fn(async () => [{ id: '10', name: 'C', status: 'ACTIVE', objective: null }]),
  getInsights: vi.fn(async (_a: string, _t: string, o: { level: 'campaign' | 'adset' | 'ad' }) => [{
    level: o.level, objectId: o.level === 'ad' ? '20' : o.level === 'adset' ? '15' : '10', campaignId: '10', adsetId: o.level === 'campaign' ? null : '15',
    name: 'n', objective: null, day: '2026-11-01', spend: 1.5, currency: 'INR', impressions: 100, clicks: 5, linkClicks: 4,
    conversationsStarted: 2, leads: 1, purchases: 0,
  }]),
  getPlatformInsights: vi.fn(async () => [{ campaignId: '10', day: '2026-11-01', platform: 'instagram', spend: 1.5, impressions: 100, clicks: 5, linkClicks: 4, conversationsStarted: 2, leads: 1 }]),
  getReach: vi.fn(async (account: string, _t: string, level: string) => [{ objectId: level === 'account' ? account : '10', reach: 80, frequency: 1.25 }]),
}));

import { MetaApiError } from '@/lib/whatsapp/meta-api';
import * as graph from './graph';
import { FULL_SYNC_DAYS, handleInsightsSyncJob, HOURLY_SYNC_DAYS, insightsWindow, parseAdsQuery, reachPresetFor } from './insights';

const ACCOUNT = '11111111-1111-4111-8111-111111111111';
const active = { id: 'c1', adAccountId: '555', userToken: 'user-token', scopes: ['ads_read'] };
const ran = (pattern: RegExp) => h.queries.some((q) => pattern.test(q.sql));

beforeEach(() => {
  h.enabled = true;
  h.connection = active;
  h.queries = [];
  vi.clearAllMocks();
});

describe('handleInsightsSyncJob', () => {
  it('finishes without SQL or a Graph call while disabled', async () => {
    h.enabled = false;
    await handleInsightsSyncJob(ACCOUNT, {});
    expect(h.queries).toEqual([]);
    expect(graph.getInsights).not.toHaveBeenCalled();
  });

  it('skips without ads_read or an active connection', async () => {
    h.connection = { ...active, scopes: ['leads_retrieval'] };
    await handleInsightsSyncJob(ACCOUNT, {});
    h.connection = null;
    await handleInsightsSyncJob(ACCOUNT, {});
    expect(graph.getInsights).not.toHaveBeenCalled();
  });

  it('hourly: upserts 7 days at campaign, ad set and ad level, the platform split and campaign reach', async () => {
    await handleInsightsSyncJob(ACCOUNT, {});
    const window = insightsWindow(Date.now(), HOURLY_SYNC_DAYS);
    for (const level of ['campaign', 'adset', 'ad'] as const)
      expect(graph.getInsights).toHaveBeenCalledWith('555', 'user-token', { level, ...window });
    expect(graph.getPlatformInsights).toHaveBeenCalledWith('555', 'user-token', window);
    // Hourly reach covers the account and campaigns, for each fixed range.
    expect(vi.mocked(graph.getReach).mock.calls.map((c) => `${c[2]}:${c[3]}`)).toEqual([
      'account:last_7d', 'account:last_30d', 'account:last_90d', 'campaign:last_7d', 'campaign:last_30d', 'campaign:last_90d']);
    const upsert = h.queries.find((q) => /INSERT INTO meta_ad_insights/.test(q.sql))!;
    expect(upsert.sql).toMatch(/ON CONFLICT \(account_id, level, object_id, day\) DO UPDATE/);
    expect(upsert.values).toContain('555');
    expect(upsert.values).toContainEqual(['campaign', 'adset', 'ad']);
    expect(upsert.values).toContainEqual(['ACTIVE', null, null]);
    expect(ran(/INSERT INTO meta_ad_insight_platforms/)).toBe(true);
    expect(ran(/INSERT INTO meta_ad_reach/)).toBe(true);
    expect(ran(/UPDATE meta_ad_accounts SET insights_synced_at=now\(\)/)).toBe(true);
    expect(ran(/insights_synced_at=CASE WHEN/)).toBe(true);
  });

  it('a full run covers 90 days and reach at every level', async () => {
    await handleInsightsSyncJob(ACCOUNT, { full: true });
    expect(graph.getInsights).toHaveBeenCalledWith('555', 'user-token', { level: 'campaign', ...insightsWindow(Date.now(), FULL_SYNC_DAYS) });
    expect(new Set(vi.mocked(graph.getReach).mock.calls.map((c) => c[2]))).toEqual(new Set(['account', 'campaign', 'adset', 'ad']));
  });

  it('marks an expired token and finishes; rethrows a throttle for retry', async () => {
    vi.mocked(graph.getInsights).mockRejectedValueOnce(new MetaApiError('x', { code: 190, httpStatus: 400 }));
    await expect(handleInsightsSyncJob(ACCOUNT, {})).resolves.toBeUndefined();
    expect(h.queries.find((q) => /status='token_invalid'/.test(q.sql))!.values).toContain('190');
    expect(ran(/INSERT INTO meta_ad_insights/)).toBe(false);

    h.queries = [];
    vi.mocked(graph.getInsights).mockRejectedValueOnce(new MetaApiError('x', { code: 17, httpStatus: 400 }));
    await expect(handleInsightsSyncJob(ACCOUNT, {})).rejects.toBeInstanceOf(MetaApiError);
    expect(h.queries.find((q) => /last_error_code/.test(q.sql))!.values).toContain('17');
  });
});

describe('parseAdsQuery', () => {
  const now = Date.parse('2026-11-03T10:00:00Z');
  const parse = (q: string) => parseAdsQuery(new URLSearchParams(q), now);

  it('defaults to the last 30 days at campaign level, every ad account', () => {
    expect(parse('')).toEqual({ level: 'campaign', from: '2026-10-05', to: '2026-11-03', adAccountId: null });
    expect(parse('level=adset&adAccountId=777')).toMatchObject({ level: 'adset', adAccountId: '777' });
    expect(parse('adAccountId=all')).toMatchObject({ adAccountId: null });
  });

  it('rejects bad levels, ad accounts, impossible days, reversed and over-long ranges', () => {
    expect(parse('level=account')).toBeNull();
    expect(parse('adAccountId=act_1')).toBeNull();
    expect(parse('from=2026-02-30&to=2026-03-01')).toBeNull();
    expect(parse('from=2026-11-03&to=2026-11-01')).toBeNull();
    expect(parse('from=2026-01-01&to=2026-11-01')).toBeNull();
    expect(parse('level=ad&from=2026-10-01&to=2026-10-31')).toEqual({ level: 'ad', from: '2026-10-01', to: '2026-10-31', adAccountId: null });
  });
});

describe('reachPresetFor', () => {
  const now = Date.parse('2026-11-03T10:00:00Z');
  it("matches Meta's fixed ranges, which end yesterday, and nothing else", () => {
    expect(reachPresetFor('2026-10-27', '2026-11-02', now)).toBe('last_7d');
    expect(reachPresetFor('2026-10-04', '2026-11-02', now)).toBe('last_30d');
    expect(reachPresetFor('2026-08-05', '2026-11-02', now)).toBe('last_90d');
    expect(reachPresetFor('2026-10-27', '2026-11-03', now)).toBeNull();
    expect(reachPresetFor('2026-10-28', '2026-11-02', now)).toBeNull();
  });
});
