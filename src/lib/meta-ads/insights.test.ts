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
  getInsights: vi.fn(async (_a: string, _t: string, o: { level: 'campaign' | 'ad' }) => [{
    level: o.level, objectId: o.level === 'ad' ? '20' : '10', campaignId: '10', name: 'n', objective: null, day: '2026-11-01',
    spend: 1.5, currency: 'INR', impressions: 100, clicks: 5, conversationsStarted: 2,
  }]),
}));

import { MetaApiError } from '@/lib/whatsapp/meta-api';
import * as graph from './graph';
import { handleInsightsSyncJob, insightsWindow, parseAdsQuery } from './insights';

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

  it('upserts the 30-day window at campaign and ad level and stamps the sync', async () => {
    await handleInsightsSyncJob(ACCOUNT, {});
    const window = insightsWindow();
    expect(graph.getInsights).toHaveBeenCalledWith('555', 'user-token', { level: 'campaign', ...window });
    expect(graph.getInsights).toHaveBeenCalledWith('555', 'user-token', { level: 'ad', ...window });
    const upsert = h.queries.find((q) => /INSERT INTO meta_ad_insights/.test(q.sql))!;
    expect(upsert.sql).toMatch(/ON CONFLICT \(account_id, level, object_id, day\) DO UPDATE/);
    expect(upsert.values).toContainEqual(['campaign', 'ad']);
    expect(upsert.values).toContainEqual(['ACTIVE', null]);
    expect(ran(/insights_synced_at=now\(\)/)).toBe(true);
  });

  it('marks an expired token and finishes; rethrows a throttle for retry', async () => {
    vi.mocked(graph.getInsights).mockRejectedValueOnce(new MetaApiError('x', { code: 190, httpStatus: 400 }));
    await expect(handleInsightsSyncJob(ACCOUNT, {})).resolves.toBeUndefined();
    expect(h.queries.find((q) => /token_invalid/.test(q.sql))!.values).toContain(true);
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

  it('defaults to the last 30 days at campaign level', () => {
    expect(parse('')).toEqual({ level: 'campaign', from: '2026-10-05', to: '2026-11-03' });
  });

  it('rejects bad levels, impossible days, reversed and over-long ranges', () => {
    expect(parse('level=adset')).toBeNull();
    expect(parse('from=2026-02-30&to=2026-03-01')).toBeNull();
    expect(parse('from=2026-11-03&to=2026-11-01')).toBeNull();
    expect(parse('from=2026-01-01&to=2026-11-01')).toBeNull();
    expect(parse('level=ad&from=2026-10-01&to=2026-10-31')).toEqual({ level: 'ad', from: '2026-10-01', to: '2026-10-31' });
  });
});
