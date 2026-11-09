import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  statements: [] as { sql: string; values: unknown[] }[],
  results: new Map<string, number[]>(),
  accounts: [] as { account_id: string }[],
  contexts: [] as unknown[],
}));

const kind = (sql: string) => sql.includes('outbox_events') ? 'outbox' : sql.includes('webhook_receipts') ? 'receipts'
  : sql.includes("status='failed'") ? 'failed' : sql.includes("status='done'") ? 'done' : 'schedule';
const exec = async (s: TemplateStringsArray, ...values: unknown[]) => {
  const sql = s.join('?');
  h.statements.push({ sql, values });
  return h.results.get(kind(sql))?.shift() ?? (kind(sql) === 'schedule' ? 1 : 0);
};
vi.mock('@/lib/db/prisma', () => ({
  getWorkerPrisma: () => ({ $executeRaw: exec, $queryRaw: async () => h.accounts }),
}));
vi.mock('@/lib/db/tenant', () => ({
  withTenant: async (ctx: unknown, fn: (tx: unknown) => unknown) => {
    h.contexts.push(ctx);
    return fn({ $executeRaw: exec });
  },
}));

import { DATA_RETENTION, resetDataRetentionScheduleForTests, runDataRetentionSweep, scheduleDataRetention } from './data-retention';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';

beforeEach(() => {
  resetDataRetentionScheduleForTests();
  h.statements = [];
  h.results = new Map();
  h.accounts = [];
  h.contexts = [];
  vi.spyOn(console, 'info').mockImplementation(() => undefined);
});

describe('[SEC-01] data retention sweep', () => {
  it('queues one tenantless sweep per hour', async () => {
    const now = Date.parse('2026-11-20T06:42:00Z');
    expect(await scheduleDataRetention(now)).toBe(1);
    expect(h.statements[0].sql).not.toContain('tenant_id');
    expect(h.statements[0].values).toEqual(['data.retention_sweep', 'data-retention:2026-11-20T06:00:00.000Z']);
    expect(await scheduleDataRetention(now + 10 * 60_000)).toBe(0);
  });

  it('deletes only finished jobs, processed receipts and old events, in bounded batches', async () => {
    h.results.set('done', [DATA_RETENTION.batchSize, 7]);
    h.results.set('failed', [3]);
    h.results.set('receipts', [DATA_RETENTION.batchSize, DATA_RETENTION.batchSize, 0]);
    h.results.set('outbox', [5, 9]);
    h.accounts = [{ account_id: A }, { account_id: 'bad' }, { account_id: B }];
    const result = await runDataRetentionSweep();
    expect(result).toEqual({ doneJobs: DATA_RETENTION.batchSize + 7, failedJobs: 3, webhookReceipts: 2 * DATA_RETENTION.batchSize, outboxEvents: 14 });
    const sql = h.statements.map((s) => s.sql);
    expect(sql.filter((q) => q.includes('FROM jobs')).every((q) => /status='(done|failed)'/.test(q))).toBe(true);
    expect(sql.filter((q) => q.includes('webhook_receipts')).every((q) => q.includes("status='processed'"))).toBe(true);
    // Each workspace's events are deleted inside its own tenant scope, with its id in the filter.
    expect(h.contexts).toEqual([{ accountId: A, role: 'owner' }, { accountId: B, role: 'owner' }]);
    const outbox = h.statements.filter((s) => s.sql.includes('outbox_events'));
    expect(outbox.map((s) => s.values[0])).toEqual([A, B]);
  });

  it('stops after the per-run batch cap', async () => {
    h.results.set('done', Array(DATA_RETENTION.maxBatches + 5).fill(DATA_RETENTION.batchSize));
    const result = await runDataRetentionSweep();
    expect(result.doneJobs).toBe(DATA_RETENTION.maxBatches * DATA_RETENTION.batchSize);
  });
});
