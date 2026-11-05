import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  due: [] as { account_id: string }[],
  queued: [] as unknown[][],
  deletes: [] as number[],
  contexts: [] as unknown[],
}));
vi.mock('@/lib/db/prisma', () => ({
  getWorkerPrisma: () => ({
    $queryRaw: async () => h.due,
    $executeRaw: async (_s: TemplateStringsArray, ...values: unknown[]) => { h.queued.push(values); return 1; },
  }),
}));
vi.mock('@/lib/db/tenant', () => ({
  withTenant: async (ctx: unknown, fn: (tx: unknown) => unknown) => {
    h.contexts.push(ctx);
    return fn({ $executeRaw: async (sql: TemplateStringsArray) => {
      expect(sql.join('?')).toContain("state IN ('settled','released')");
      expect(sql.join('?')).toContain("interval '13 months'");
      return h.deletes.shift() ?? 0;
    } });
  },
}));

import { resetUsageHousekeepingScheduleForTests, runUsageHousekeeping, scheduleUsageHousekeeping, USAGE_HOUSEKEEPING } from './usage-housekeeping';

const A = '11111111-1111-4111-8111-111111111111';

beforeEach(() => {
  resetUsageHousekeepingScheduleForTests();
  h.due = [];
  h.queued = [];
  h.deletes = [];
  h.contexts = [];
});

describe('usage housekeeping', () => {
  it('queues one job per due workspace per IST day, deduped', async () => {
    h.due = [{ account_id: A }, { account_id: 'not-a-uuid' }];
    const now = Date.parse('2026-11-05T10:00:00Z');
    expect(await scheduleUsageHousekeeping(now)).toBe(1);
    expect(h.queued[0]).toEqual(['usage.housekeeping', A, `usage-housekeeping:${A}:2026-11-05`]);
    expect(await scheduleUsageHousekeeping(now + 2 * 60 * 60_000)).toBe(0);
  });

  it('deletes old settled and released rows in bounded batches inside the workspace scope', async () => {
    h.deletes = [USAGE_HOUSEKEEPING.batchSize, 12];
    expect(await runUsageHousekeeping(A)).toBe(USAGE_HOUSEKEEPING.batchSize + 12);
    expect(h.contexts).toEqual([{ accountId: A, role: 'owner' }, { accountId: A, role: 'owner' }]);
    await expect(runUsageHousekeeping('x')).rejects.toThrow(/Invalid/);
  });
});
