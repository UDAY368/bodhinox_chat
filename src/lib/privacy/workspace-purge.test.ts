import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  due: [] as { account_id: string; purged: boolean }[],
  inserted: [] as { sql: string; values: unknown[] }[],
  sql: [] as string[],
  contexts: [] as unknown[],
  options: [] as unknown[],
  check: null as string | null,
  finish: null as string | null,
  purgeRow: [] as { cleared: boolean }[],
  storage: { configured: true, done: true, calls: 0 },
  updates: 0,
}));

const text = (s: TemplateStringsArray) => s.join('?');
vi.mock('@/lib/db/prisma', () => ({
  getWorkerPrisma: () => ({
    $queryRaw: async (s: TemplateStringsArray) => {
      const q = text(s);
      if (q.includes('crm_accounts_due_for_purge')) return h.due;
      if (q.includes('FROM workspace_purges')) return h.purgeRow;
      throw new Error(`unexpected query ${q}`);
    },
    $executeRaw: async (s: TemplateStringsArray, ...values: unknown[]) => {
      const q = text(s);
      if (q.includes('UPDATE workspace_purges')) { h.updates++; return 1; }
      h.inserted.push({ sql: q, values });
      return 1;
    },
  }),
}));
vi.mock('@/lib/db/tenant', () => ({
  withTenant: async (ctx: unknown, fn: (tx: unknown) => unknown, _db: unknown, options?: unknown) => {
    h.contexts.push(ctx);
    h.options.push(options);
    return fn({
      $queryRaw: async (s: TemplateStringsArray) => {
        const q = text(s);
        h.sql.push(q);
        if (q.includes('crm_workspace_purge_check')) return [{ reason: h.check }];
        if (q.includes('crm_workspace_purge_finish')) return [{ reason: h.finish }];
        if (q.includes('count(*)')) return [{ contacts: BigInt(3), messages: BigInt(12) }];
        throw new Error(`unexpected tenant query ${q}`);
      },
      $executeRaw: async (s: TemplateStringsArray) => { h.sql.push(text(s)); return 2; },
    });
  },
}));
vi.mock('@/lib/storage/server', () => ({
  storageConfigured: () => h.storage.configured,
  deleteWorkspaceObjects: async () => { h.storage.calls++; return { deleted: 4, done: h.storage.done }; },
}));

import {
  clearPurgedWorkspaceStorage, resetWorkspacePurgeScheduleForTests, runWorkspacePurge, scheduleWorkspacePurges, workspacePurgeEnabled,
} from './workspace-purge';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const ON = { WORKSPACE_PURGE_ENABLED: 'true' };

beforeEach(() => {
  resetWorkspacePurgeScheduleForTests();
  Object.assign(h, { due: [], inserted: [], sql: [], contexts: [], options: [], check: null, finish: null, purgeRow: [{ cleared: false }], updates: 0 });
  h.storage = { configured: true, done: true, calls: 0 };
  vi.spyOn(console, 'info').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

describe('[BIL-03][SEC-01] workspace purge', () => {
  it('is off unless WORKSPACE_PURGE_ENABLED is exactly true', () => {
    expect(workspacePurgeEnabled({})).toBe(false);
    expect(workspacePurgeEnabled({ WORKSPACE_PURGE_ENABLED: '1' })).toBe(false);
    expect(workspacePurgeEnabled(ON)).toBe(true);
  });

  it('queues a tenant purge job for a due workspace and a tenantless storage job for a purged one, once a day', async () => {
    h.due = [{ account_id: A, purged: false }, { account_id: B, purged: true }, { account_id: 'nope', purged: false }];
    const now = Date.parse('2026-11-20T06:00:00Z');
    expect(await scheduleWorkspacePurges(now)).toBe(2);
    expect(h.inserted[0].sql).toContain('tenant_id');
    expect(h.inserted[0].values).toEqual(['workspace.purge', A, `workspace-purge:${A}:2026-11-20`]);
    expect(h.inserted[1].sql).not.toContain('tenant_id');
    expect(h.inserted[1].values).toEqual(['workspace.purge_storage', JSON.stringify({ accountId: B }), `workspace-purge-storage:${B}:2026-11-20`]);
    expect(await scheduleWorkspacePurges(now + 2 * 60 * 60_000)).toBe(0);
  });

  it('only counts and logs while the flag is off: nothing is copied, finished or deleted', async () => {
    const result = await runWorkspacePurge(A, {});
    expect(result).toEqual({ state: 'dry_run', reason: null, counts: { contacts: 3, messages: 12 } });
    expect(h.sql.some((q) => q.includes('crm_workspace_purge_finish') || q.includes('purged_invoices'))).toBe(false);
    expect(h.contexts).toEqual([{ accountId: A, role: 'owner' }]);
    expect(h.storage.calls).toBe(0);
    expect(console.info).toHaveBeenCalledWith(expect.stringContaining('dry run'), A, 'due', JSON.stringify({ contacts: 3, messages: 12 }));
  });

  it('skips a workspace the re-check refuses (cancelled, not due, live subscription)', async () => {
    h.check = 'live_subscription';
    expect(await runWorkspacePurge(A, ON)).toEqual({ state: 'skipped', reason: 'live_subscription' });
    expect(h.sql.some((q) => q.includes('crm_workspace_purge_finish'))).toBe(false);
    expect(h.storage.calls).toBe(0);
  });

  it('copies invoices, finishes inside the workspace scope with a long timeout, then clears storage', async () => {
    const result = await runWorkspacePurge(A, ON);
    expect(result).toEqual({ state: 'purged', counts: { contacts: 3, messages: 12 }, invoicesRetained: 2, storageCleared: true });
    const order = h.sql.map((q) => (q.includes('purged_invoices') ? 'copy' : q.includes('purge_finish') ? 'finish' : q.includes('purge_check') ? 'check' : 'count'));
    expect(order).toEqual(['check', 'count', 'copy', 'finish']);
    expect(h.contexts[0]).toEqual({ accountId: A, role: 'owner' });
    expect(h.options[0]).toEqual({ timeoutMs: 10 * 60_000 });
    expect(h.updates).toBe(1);
  });

  it('rolls back when the final re-check refuses', async () => {
    h.finish = 'not_due';
    await expect(runWorkspacePurge(A, ON)).rejects.toThrow(/not_due/);
  });

  it('never deletes files of a workspace without a purge record, and keeps retrying until the prefix is empty', async () => {
    h.purgeRow = [];
    await expect(clearPurgedWorkspaceStorage(A)).rejects.toThrow(/no purge record/);
    expect(h.storage.calls).toBe(0);
    h.purgeRow = [{ cleared: false }];
    h.storage.done = false;
    expect(await clearPurgedWorkspaceStorage(A)).toBe(false);
    expect(h.updates).toBe(0);
    h.storage.configured = false;
    expect(await clearPurgedWorkspaceStorage(A)).toBe(false);
    h.purgeRow = [{ cleared: true }];
    expect(await clearPurgedWorkspaceStorage(A)).toBe(true);
    await expect(runWorkspacePurge('x', ON)).rejects.toThrow(/Invalid/);
  });
});
