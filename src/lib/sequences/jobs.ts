// Worker scheduling for sequences (Stage 5, 5H). Wired into
// src/lib/jobs/handlers.ts (5A owns it):
//   scheduleWork():  await import('@/lib/sequences/jobs').then((m) => m.scheduleSequenceSweeps())
//                      .catch(() => console.error('[worker] sequence scheduling failed'));
//   job dispatch:    else if (job.type === SEQUENCES_DUE_JOB) await handleSequenceJob(accountId);
// The scheduler runs before any workspace is chosen, so it asks the
// worker-only SECURITY DEFINER function which workspaces have a due message or
// an expired claim (ids only), then offers one job per workspace and 30-second
// slot (deduplicated). The job runs inside the workspace's tenant scope.
import { getWorkerPrisma } from '@/lib/db/prisma';
import { instagramConfig } from '@/lib/instagram/config';

export const SEQUENCES_DUE_JOB = 'sequences.due';
const SLOT_MS = 30_000;

/** Returns how many jobs it offered. Nothing while Instagram is off: the subscriptions wait. */
export async function scheduleSequenceSweeps(now: number = Date.now()): Promise<number> {
  if (!instagramConfig()) return 0;
  const prisma = getWorkerPrisma();
  const slot = Math.floor(now / SLOT_MS);
  const due = await prisma.$queryRaw<{ account_id: string }[]>`SELECT * FROM crm_due_sequence_accounts()`;
  for (const { account_id } of due)
    await prisma.$executeRaw`INSERT INTO jobs(type,tenant_id,payload,dedupe_key,max_attempts)
      VALUES(${SEQUENCES_DUE_JOB},${account_id}::uuid,'{}'::jsonb,${`sequences-due:${account_id}:${slot}`},2)
      ON CONFLICT(dedupe_key) DO NOTHING`;
  return due.length;
}

/** The sequences.due job. Loaded on demand so the flow engine stays out of the scheduler's module graph. */
export async function handleSequenceJob(accountId: string): Promise<number> {
  return (await import('./worker')).runDueSequences(accountId);
}
