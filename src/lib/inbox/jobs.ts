import { getWorkerPrisma } from '@/lib/db/prisma';
import { AUTO_RESOLVE_JOB, runAutoResolve } from './lifecycle';
import { REASSIGN_JOB, runReassign } from './routing';
import { runSlaCheck, SLA_CHECK_JOB } from './sla';

/**
 * Inbox worker jobs.
 *  - inbox.sla_check (every minute) and inbox.auto_resolve (every five
 *    minutes), one per workspace that has inbox automation configured
 *    (crm_accounts_for_inbox_sweep), deduplicated per time slot.
 *  - inbox.reassign, queued per conversation by routing with a delay (see
 *    src/lib/inbox/routing.ts); not scheduled here.
 * Every job runs inside the workspace's tenant scope; nothing here logs
 * customer content.
 */

export const INBOX_JOB_TYPES = [SLA_CHECK_JOB, AUTO_RESOLVE_JOB, REASSIGN_JOB] as const;
export const SLA_CHECK_INTERVAL_MS = 60_000;
export const AUTO_RESOLVE_INTERVAL_MS = 5 * 60_000;

export function isInboxJob(type: string): boolean {
  return (INBOX_JOB_TYPES as readonly string[]).includes(type);
}

let lastSchedule = Number.NEGATIVE_INFINITY;

/** Called from scheduleWork (every 30 s); enqueues at most once a minute. Returns the jobs it offered. */
export async function scheduleInboxSweeps(now: number = Date.now(), force = false): Promise<number> {
  if (!force && now - lastSchedule < SLA_CHECK_INTERVAL_MS) return 0;
  const accounts = await getWorkerPrisma().$queryRaw<{ account_id: string }[]>`SELECT * FROM crm_accounts_for_inbox_sweep()`;
  const slaSlot = Math.floor(now / SLA_CHECK_INTERVAL_MS);
  const resolveSlot = Math.floor(now / AUTO_RESOLVE_INTERVAL_MS);
  let offered = 0;
  for (const { account_id } of accounts) {
    await getWorkerPrisma().$executeRaw`INSERT INTO jobs(type,tenant_id,payload,dedupe_key,max_attempts)
      VALUES(${SLA_CHECK_JOB},${account_id}::uuid,'{}'::jsonb,${`inbox-sla:${account_id}:${slaSlot}`},2),
        (${AUTO_RESOLVE_JOB},${account_id}::uuid,'{}'::jsonb,${`inbox-resolve:${account_id}:${resolveSlot}`},2)
      ON CONFLICT(dedupe_key) DO NOTHING`;
    offered += 2;
  }
  lastSchedule = now;
  return offered;
}

/** Test hook: forget when the scheduler last ran. */
export function resetInboxScheduleForTests(): void {
  lastSchedule = Number.NEGATIVE_INFINITY;
}

export async function handleInboxJob(accountId: string, type: string, payload: Record<string, unknown>): Promise<void> {
  if (type === SLA_CHECK_JOB) await runSlaCheck(accountId);
  else if (type === AUTO_RESOLVE_JOB) await runAutoResolve(accountId);
  else if (type === REASSIGN_JOB) await runReassign(accountId, payload);
  else throw new Error('Unsupported inbox job type');
}
