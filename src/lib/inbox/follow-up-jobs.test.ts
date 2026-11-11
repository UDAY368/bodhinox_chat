import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  reminders: [] as { account_id: string }[],
  replies: [] as { account_id: string }[],
  inserts: [] as unknown[][],
}));
vi.mock('@/lib/db/prisma', () => ({
  getWorkerPrisma: () => ({
    $queryRaw: async (strings: TemplateStringsArray) =>
      strings.join('?').includes('crm_due_conversation_reminder_accounts') ? h.reminders : h.replies,
    $executeRaw: async (...args: unknown[]) => { h.inserts.push(args.slice(1)); return 1; },
  }),
}));

import { REMINDERS_JOB, scheduleFollowUpSweeps, SCHEDULED_REPLIES_JOB } from './follow-up-jobs';

const A = '00000000-0000-4000-8000-00000000000a';
const B = '00000000-0000-4000-8000-00000000000b';

beforeEach(() => { h.reminders = []; h.replies = []; h.inserts = []; });

describe('scheduleFollowUpSweeps', () => {
  it('offers one job per workspace with something due and 30-second slot, deduplicated by key', async () => {
    const now = Date.UTC(2026, 10, 12, 10, 0, 40);
    h.reminders = [{ account_id: A }];
    h.replies = [{ account_id: A }, { account_id: B }];
    expect(await scheduleFollowUpSweeps(now)).toBe(3);
    const slot = Math.floor(now / 30_000);
    expect(h.inserts).toEqual([
      [REMINDERS_JOB, A, `inbox-reminders:${A}:${slot}`],
      [SCHEDULED_REPLIES_JOB, A, `inbox-scheduled:${A}:${slot}`],
      [SCHEDULED_REPLIES_JOB, B, `inbox-scheduled:${B}:${slot}`],
    ]);
  });
  it('offers nothing when nothing is due', async () => {
    expect(await scheduleFollowUpSweeps(Date.now())).toBe(0);
    expect(h.inserts).toEqual([]);
  });
});
