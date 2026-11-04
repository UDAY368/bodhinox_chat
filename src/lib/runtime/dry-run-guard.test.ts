import { beforeEach, describe, expect, it, vi } from 'vitest';

const worker = vi.hoisted(() => ({ queryRaw: vi.fn(), transaction: vi.fn() }));
vi.mock('@/lib/db/prisma', () => ({
  getPrisma: () => ({ $transaction: worker.transaction }),
  getWorkerPrisma: () => ({ $queryRaw: worker.queryRaw, $transaction: worker.transaction }),
}));

import { withTenant } from '@/lib/db/tenant';
import { dispatchOnce } from '@/lib/jobs/dispatch';
import { enqueueJob } from '@/lib/jobs/queue';
import { safeFetch } from '@/lib/webhooks/safe-fetch';
import { assertLiveEffects, DryRunSideEffectError, isDryRun, withDryRun } from './dry-run-guard';

const A = '11111111-1111-4111-8111-111111111111';

function fakeTx() {
  const statements: string[] = [];
  const record = (strings: TemplateStringsArray | { strings?: readonly string[]; sql?: string }) => {
    const text = 'sql' in strings && typeof strings.sql === 'string' ? strings.sql : Array.from((strings as { strings: readonly string[] }).strings ?? (strings as TemplateStringsArray)).join('?');
    statements.push(text.replace(/\s+/g, ' ').trim());
    return Promise.resolve([]);
  };
  return { statements, tx: { $executeRaw: vi.fn(record), $queryRaw: vi.fn(record) } };
}

beforeEach(() => {
  vi.clearAllMocks();
  worker.queryRaw.mockResolvedValue([{ id: 'job-1' }]);
});

describe('dry-run scope', () => {
  it('is active only inside withDryRun, across awaits', async () => {
    expect(isDryRun()).toBe(false);
    await withDryRun(async () => {
      await Promise.resolve();
      expect(isDryRun()).toBe(true);
      expect(() => assertLiveEffects('job')).toThrow(DryRunSideEffectError);
    });
    expect(isDryRun()).toBe(false);
    expect(() => assertLiveEffects('job')).not.toThrow();
  });

  it('does not leak into work started concurrently outside the scope', async () => {
    let inside = false, outside = true;
    await Promise.all([
      withDryRun(async () => { await new Promise((r) => setTimeout(r, 5)); inside = isDryRun(); }),
      (async () => { await new Promise((r) => setTimeout(r, 1)); outside = isDryRun(); })(),
    ]);
    expect(inside).toBe(true);
    expect(outside).toBe(false);
  });
});

describe('withTenant', () => {
  it('starts every transaction READ ONLY inside a dry run, before the tenant settings', async () => {
    const { tx, statements } = fakeTx();
    const db = { $transaction: vi.fn(async (fn: (t: unknown) => unknown) => fn(tx)) };
    await withDryRun(() => withTenant({ accountId: A }, async () => 'ok', db as never));
    expect(statements[0]).toBe('SET TRANSACTION READ ONLY');
    expect(statements[1]).toContain('set_config');
  });

  it('leaves live transactions unchanged', async () => {
    const { tx, statements } = fakeTx();
    const db = { $transaction: vi.fn(async (fn: (t: unknown) => unknown) => fn(tx)) };
    await withTenant({ accountId: A }, async () => 'ok', db as never);
    expect(statements).toHaveLength(1);
    expect(statements[0]).toContain('set_config');
    expect(tx.$executeRaw).not.toHaveBeenCalled();
  });
});

describe('side-effect entry points', () => {
  it('enqueueJob throws inside a dry run before any query, and works outside', async () => {
    await withDryRun(async () => {
      await expect(enqueueJob('flow.sweep', {}, { tenantId: A })).rejects.toBeInstanceOf(DryRunSideEffectError);
    });
    expect(worker.queryRaw).not.toHaveBeenCalled();
    await expect(enqueueJob('flow.sweep', {}, { tenantId: A })).resolves.toBe('job-1');
  });

  it('accepts the Phase 12 job types', async () => {
    await expect(enqueueJob('flow.replay', { accountId: A, runId: A }, { tenantId: A })).resolves.toBe('job-1');
    await expect(enqueueJob('analytics.report_schedules', { accountId: A }, { tenantId: A })).resolves.toBe('job-1');
  });

  it('dispatchOnce throws before claiming an intent or sending', async () => {
    const send = vi.fn();
    await withDryRun(async () => {
      await expect(dispatchOnce(A, 'flow:x', send)).rejects.toBeInstanceOf(DryRunSideEffectError);
    });
    expect(send).not.toHaveBeenCalled();
    expect(worker.transaction).not.toHaveBeenCalled();
  });

  it('safeFetch throws before resolving or connecting', async () => {
    await withDryRun(async () => {
      await expect(safeFetch('https://example.com', { method: 'GET', headers: {} })).rejects.toBeInstanceOf(DryRunSideEffectError);
    });
    // Outside a dry run the existing checks still answer (an invalid URL never connects).
    await expect(safeFetch('not a url', { method: 'GET', headers: {} })).resolves.toEqual({ ok: false, error: 'invalid_url' });
  });
});
