import { beforeEach, describe, expect, it, vi } from 'vitest';

const ACCOUNT = '11111111-1111-4111-8111-111111111111';
const h = vi.hoisted(() => ({ used: 0, limit: 5 as number | null, increments: 0, failIncrement: false, queries: [] as string[] }));

vi.mock('@/lib/db/tenant', () => ({
  withTenant: async (_ctx: unknown, fn: (tx: unknown) => unknown) => fn({
    $queryRaw: async (strings: TemplateStringsArray) => {
      const sql = strings.join('?');
      h.queries.push(sql);
      if (sql.includes('usage_counters')) return [{ value: BigInt(h.used) }];
      if (sql.includes('media_objects')) return [{ bytes: BigInt(h.used) }];
      return [];
    },
    $executeRaw: async () => 1,
  }),
}));
vi.mock('./usage', () => ({
  usagePeriod: () => '2026-11',
  incrementUsage: async () => {
    if (h.failIncrement) throw new Error('db down: secret content');
    h.increments += 1;
    return h.increments;
  },
}));
vi.mock('./entitlements', async () => {
  const { PlanLimitError } = await vi.importActual<typeof import('./entitlements')>('./entitlements');
  return {
    PlanLimitError,
    requireWithinLimit: async (_tx: unknown, _id: string, key: string, wanted: number) => {
      if (h.limit !== null && wanted > h.limit) throw new PlanLimitError(`over ${key}`);
    },
  };
});

import { PlanLimitError } from './entitlements';
import { recordAiMessage, requireAiMessageRoom, requireStorageRoom } from './limits';

beforeEach(() => {
  Object.assign(h, { used: 0, limit: 5, increments: 0, failIncrement: false, queries: [] });
});

describe('AI messages', () => {
  it('allows a generation while one more fits', async () => {
    h.used = 4;
    await expect(requireAiMessageRoom(ACCOUNT)).resolves.toBeUndefined();
  });

  it('refuses at the limit with a plan error', async () => {
    h.used = 5;
    await expect(requireAiMessageRoom(ACCOUNT)).rejects.toBeInstanceOf(PlanLimitError);
  });

  it('allows any amount without a limit', async () => {
    h.used = 10_000;
    h.limit = null;
    await expect(requireAiMessageRoom(ACCOUNT)).resolves.toBeUndefined();
  });

  it('counts a generation and never throws on accounting errors, logging only the error class', async () => {
    await recordAiMessage(ACCOUNT);
    expect(h.increments).toBe(1);
    h.failIncrement = true;
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(recordAiMessage(ACCOUNT)).resolves.toBeUndefined();
    expect(JSON.stringify(log.mock.calls)).not.toMatch(/secret/);
    log.mockRestore();
  });
});

describe('storage', () => {
  const tx = () => ({
    $queryRaw: async () => [{ bytes: BigInt(h.used) }],
    $executeRaw: async () => 1,
  }) as never;

  it('skips the check when nothing is added', async () => {
    h.used = 999;
    await expect(requireStorageRoom(tx(), ACCOUNT, 0)).resolves.toBeUndefined();
    await expect(requireStorageRoom(tx(), ACCOUNT, -10)).resolves.toBeUndefined();
  });

  it('refuses an upload past the limit', async () => {
    h.used = 3;
    await expect(requireStorageRoom(tx(), ACCOUNT, 2)).resolves.toBeUndefined();
    await expect(requireStorageRoom(tx(), ACCOUNT, 3)).rejects.toBeInstanceOf(PlanLimitError);
  });
});
