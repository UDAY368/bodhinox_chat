import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/db/prisma', () => ({
  getPrisma: vi.fn(), getPlatformPrisma: vi.fn(), platformDatabaseConfigured: vi.fn(() => false),
}));

import { deepHealthAuthorized, evaluateOpsHealth, healthThresholds, readOpsHealth, type OpsHealthRow } from './health';

const token = 'a'.repeat(40);
const healthy: OpsHealthRow = { lastBeatAgeS: 5, pendingDue: 0, oldestDueAgeS: null, expiredRunningLeases: 0, failedJobs1h: 0,
  unknownIntents: 0, unprocessedWebhooks15m: 0, latestMigration: '20261113090100_ops_health_fn' };
const thresholds = { workerDownS: 90, oldestDueDegradedS: 300, unknownIntentsDegraded: 0 };

describe('[OPS-01] deep health token', () => {
  it('accepts only the exact bearer token', () => {
    expect(deepHealthAuthorized(`Bearer ${token}`, token)).toBe(true);
    expect(deepHealthAuthorized(`bearer ${token}`, token)).toBe(true);
    expect(deepHealthAuthorized(`Bearer ${token}x`, token)).toBe(false);
    expect(deepHealthAuthorized(`Bearer ${token.slice(1)}`, token)).toBe(false);
    expect(deepHealthAuthorized(token, token)).toBe(false);
    expect(deepHealthAuthorized(`Basic ${token}`, token)).toBe(false);
    expect(deepHealthAuthorized(null, token)).toBe(false);
  });
  it('is off when HEALTH_TOKEN is unset, blank or shorter than 32 characters', () => {
    expect(deepHealthAuthorized('Bearer ', '')).toBe(false);
    expect(deepHealthAuthorized('Bearer undefined', undefined)).toBe(false);
    expect(deepHealthAuthorized(`Bearer ${'s'.repeat(31)}`, 's'.repeat(31))).toBe(false);
  });
});

describe('[OPS-01] deep health evaluation', () => {
  it('reads thresholds from env with safe defaults', () => {
    expect(healthThresholds({})).toEqual(thresholds);
    expect(healthThresholds({ HEALTH_WORKER_DOWN_S: '120', HEALTH_OLDEST_DUE_DEGRADED_S: '60', HEALTH_UNKNOWN_INTENTS_DEGRADED: '3' }))
      .toEqual({ workerDownS: 120, oldestDueDegradedS: 60, unknownIntentsDegraded: 3 });
    expect(healthThresholds({ HEALTH_WORKER_DOWN_S: '-5', HEALTH_OLDEST_DUE_DEGRADED_S: 'x' })).toEqual(thresholds);
  });

  it('ok when every signal is inside its threshold', () => {
    const result = evaluateOpsHealth(true, healthy, thresholds);
    expect(result.status).toBe('ok');
    expect(result.checks).toEqual({ appDb: true, ops: 'ok', worker: { ageS: 5, ok: true },
      queue: { pendingDue: 0, oldestDueS: null, expiredLeases: 0, failed1h: 0 }, intents: { unknown: 0 },
      webhooks: { unprocessed15m: 0 }, migrations: { latest: '20261113090100_ops_health_fn' } });
  });

  it('down for a stale or missing heartbeat or an unreachable app database', () => {
    expect(evaluateOpsHealth(true, { ...healthy, lastBeatAgeS: 91 }, thresholds).status).toBe('down');
    expect(evaluateOpsHealth(true, { ...healthy, lastBeatAgeS: null }, thresholds).status).toBe('down');
    expect(evaluateOpsHealth(false, healthy, thresholds).status).toBe('down');
    expect(evaluateOpsHealth(false, 'unavailable', thresholds).status).toBe('down');
  });

  it('degraded for a due backlog, unknown intents, or an unreadable ops query', () => {
    expect(evaluateOpsHealth(true, { ...healthy, pendingDue: 40, oldestDueAgeS: 301 }, thresholds).status).toBe('degraded');
    expect(evaluateOpsHealth(true, { ...healthy, unknownIntents: 1 }, thresholds).status).toBe('degraded');
    expect(evaluateOpsHealth(true, { ...healthy, unprocessedWebhooks15m: 1 }, thresholds).status).toBe('degraded');
    expect(evaluateOpsHealth(true, { ...healthy, unknownIntents: 1 }, { ...thresholds, unknownIntentsDegraded: 1 }).status).toBe('ok');
    const unconfigured = evaluateOpsHealth(true, 'unconfigured', thresholds);
    expect(unconfigured).toEqual({ status: 'degraded', checks: { appDb: true, ops: 'unconfigured', worker: null, queue: null,
      intents: null, webhooks: null, migrations: null } });
  });

  it('maps the SQL row (bigint counts, fractional ages) with a 2 s statement timeout', async () => {
    const statements: string[] = [];
    const tx = { $queryRaw: vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
      statements.push(strings.join('?') + JSON.stringify(values));
      if (strings.join('').includes('crm_ops_health')) return [{ last_beat_age_s: 12.6, pending_due: BigInt(3), oldest_due_age_s: 40.2,
        expired_running_leases: BigInt(1), failed_jobs_1h: BigInt(2), unknown_intents: BigInt(0), unprocessed_webhooks_15m: BigInt(4),
        latest_migration: '20261113090100_ops_health_fn' }];
      return [];
    }) };
    const db = { $transaction: vi.fn(async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx)) };
    const row = await readOpsHealth(db as never);
    expect(row).toEqual({ lastBeatAgeS: 13, pendingDue: 3, oldestDueAgeS: 40, expiredRunningLeases: 1, failedJobs1h: 2,
      unknownIntents: 0, unprocessedWebhooks15m: 4, latestMigration: '20261113090100_ops_health_fn' });
    expect(statements[0]).toContain('statement_timeout');
    expect(statements[0]).toContain('"2000"');
  });
});
