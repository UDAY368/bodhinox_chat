import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  accounts: [] as { account_id: string }[],
  inserts: [] as unknown[][],
  sla: vi.fn(), resolve: vi.fn(), reassign: vi.fn(),
}));
vi.mock('@/lib/db/prisma', () => ({
  getWorkerPrisma: () => ({
    $queryRaw: async () => h.accounts,
    $executeRaw: async (...args: unknown[]) => { h.inserts.push(args.slice(1)); return 2; },
  }),
}));
vi.mock('./sla', () => ({ SLA_CHECK_JOB: 'inbox.sla_check', runSlaCheck: h.sla }));
vi.mock('./lifecycle', () => ({ AUTO_RESOLVE_JOB: 'inbox.auto_resolve', runAutoResolve: h.resolve }));
vi.mock('./routing', () => ({ REASSIGN_JOB: 'inbox.reassign', runReassign: h.reassign }));

import { handleInboxJob, isInboxJob, resetInboxScheduleForTests, scheduleInboxSweeps } from './jobs';

const ACCOUNT = '00000000-0000-4000-8000-000000000001';

beforeEach(() => {
  vi.clearAllMocks();
  h.accounts = [{ account_id: ACCOUNT }];
  h.inserts = [];
  resetInboxScheduleForTests();
});

describe('scheduleInboxSweeps', () => {
  it('offers one SLA check per minute slot and one auto-resolve per five-minute slot', async () => {
    const now = Date.UTC(2026, 10, 2, 10, 7, 30);
    expect(await scheduleInboxSweeps(now)).toBe(2);
    expect(h.inserts[0]).toEqual([
      'inbox.sla_check', ACCOUNT, `inbox-sla:${ACCOUNT}:${Math.floor(now / 60_000)}`,
      'inbox.auto_resolve', ACCOUNT, `inbox-resolve:${ACCOUNT}:${Math.floor(now / 300_000)}`,
    ]);
  });
  it('looks again only after a minute', async () => {
    const now = Date.UTC(2026, 10, 2, 10, 7, 30);
    await scheduleInboxSweeps(now);
    expect(await scheduleInboxSweeps(now + 30_000)).toBe(0);
    expect(await scheduleInboxSweeps(now + 60_000)).toBe(2);
  });
});

describe('handleInboxJob', () => {
  it('routes each type to its handler', async () => {
    await handleInboxJob(ACCOUNT, 'inbox.sla_check', {});
    await handleInboxJob(ACCOUNT, 'inbox.auto_resolve', {});
    await handleInboxJob(ACCOUNT, 'inbox.reassign', { conversationId: 'x' });
    expect(h.sla).toHaveBeenCalledWith(ACCOUNT);
    expect(h.resolve).toHaveBeenCalledWith(ACCOUNT);
    expect(h.reassign).toHaveBeenCalledWith(ACCOUNT, { conversationId: 'x' });
    await expect(handleInboxJob(ACCOUNT, 'inbox.other', {})).rejects.toThrow();
    expect(isInboxJob('inbox.reassign')).toBe(true);
    expect(isInboxJob('flow.sweep')).toBe(false);
  });
});
