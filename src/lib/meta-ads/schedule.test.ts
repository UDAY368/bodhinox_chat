import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const db = vi.hoisted(() => ({ queryRaw: vi.fn(), executeRaw: vi.fn() }));
vi.mock('@/lib/db/prisma', () => ({
  getWorkerPrisma: () => ({
    $queryRaw: (strings: TemplateStringsArray, ...values: unknown[]) => db.queryRaw(strings.join('?'), values),
    $executeRaw: (strings: TemplateStringsArray, ...values: unknown[]) => db.executeRaw(strings.join('?'), values),
  }),
}));
import { adObjectsSyncDedupeKey, insightsSyncDedupeKey, fullInsightsSyncDedupeKey, leadsSyncDedupeKey, resetMetaAdsScheduleForTests, scheduleMetaAds } from './schedule';

const ACCOUNT = '6f1c2d3e-0000-4000-8000-0000000000aa';
const env = { META_ADS_ENABLED: 'true', META_APP_ID: '1', META_APP_SECRET: 's', META_ADS_LOGIN_CONFIG_ID: '2' };

beforeEach(() => {
  vi.clearAllMocks();
  resetMetaAdsScheduleForTests();
  db.queryRaw.mockResolvedValue([{ account_id: ACCOUNT }]);
  db.executeRaw.mockResolvedValue(1);
});
afterEach(() => vi.unstubAllEnvs());

describe('scheduleMetaAds', () => {
  it('does nothing, not even a query, while the feature is off or unconfigured', async () => {
    vi.stubEnv('META_ADS_ENABLED', '');
    await expect(scheduleMetaAds(0, true)).resolves.toBe(0);
    for (const [key, value] of Object.entries({ ...env, META_ADS_LOGIN_CONFIG_ID: '' })) vi.stubEnv(key, value);
    await expect(scheduleMetaAds(0, true)).resolves.toBe(0);
    expect(db.queryRaw).not.toHaveBeenCalled();
  });

  it('queues bucketed insights (hourly and a daily full refresh), ad object and lead syncs per active connection', async () => {
    for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
    const now = Date.parse('2026-11-03T10:20:00Z');
    await expect(scheduleMetaAds(now)).resolves.toBe(1);
    expect(db.queryRaw.mock.calls[0][0]).toContain('crm_meta_ad_connections_due()');
    const inserts = db.executeRaw.mock.calls.map(([sql, values]) => ({ sql: sql as string, values: values as unknown[] }));
    expect(inserts).toHaveLength(4);
    for (const insert of inserts) expect(insert.sql).toContain('ON CONFLICT(dedupe_key) DO NOTHING');
    expect(inserts[0].values).toEqual(['meta.insights_sync', ACCOUNT, insightsSyncDedupeKey(ACCOUNT, now)]);
    expect(inserts[1].values).toEqual(['meta.insights_sync', ACCOUNT, fullInsightsSyncDedupeKey(ACCOUNT, now)]);
    expect(inserts[1].sql).toContain('{"full":true}');
    expect(inserts[2].values).toEqual(['meta.ad_objects_sync', ACCOUNT, adObjectsSyncDedupeKey(ACCOUNT, now)]);
    expect(inserts[3].values).toEqual(['meta.leads_sync', ACCOUNT, leadsSyncDedupeKey(ACCOUNT, now)]);
    // Within the minute nothing is read again.
    await expect(scheduleMetaAds(now + 30_000)).resolves.toBe(0);
    expect(db.queryRaw).toHaveBeenCalledTimes(1);
  });

  it('keeps one full insights refresh per UTC day', () => {
    const t = Date.parse('2026-11-03T00:05:00Z');
    expect(fullInsightsSyncDedupeKey(ACCOUNT, t)).toBe(fullInsightsSyncDedupeKey(ACCOUNT, t + 23 * 3_600_000));
    expect(fullInsightsSyncDedupeKey(ACCOUNT, t)).not.toBe(fullInsightsSyncDedupeKey(ACCOUNT, t + 24 * 3_600_000));
  });

  it('buckets insights hourly and leads every 15 minutes', () => {
    const t = Date.parse('2026-11-03T10:00:00Z');
    expect(insightsSyncDedupeKey(ACCOUNT, t)).toBe(insightsSyncDedupeKey(ACCOUNT, t + 59 * 60_000));
    expect(insightsSyncDedupeKey(ACCOUNT, t)).not.toBe(insightsSyncDedupeKey(ACCOUNT, t + 60 * 60_000));
    expect(leadsSyncDedupeKey(ACCOUNT, t)).toBe(leadsSyncDedupeKey(ACCOUNT, t + 14 * 60_000));
    expect(leadsSyncDedupeKey(ACCOUNT, t)).not.toBe(leadsSyncDedupeKey(ACCOUNT, t + 15 * 60_000));
  });
});
