import { getWorkerPrisma } from '@/lib/db/prisma';

/**
 * Worker scheduling for reminders and scheduled replies (Stage 4, 4D). Called
 * from scheduleWork (every 30 s). The scheduler runs before any workspace is
 * chosen, so it asks the worker-only SECURITY DEFINER functions which
 * workspaces have something due (ids only), then offers one job per workspace
 * and 30-second slot (deduplicated). The jobs themselves run inside the
 * workspace's tenant scope: runDueReminders (reminders.ts) and
 * runScheduledReplies (scheduled-replies.ts). Nothing here reads content.
 */
export const REMINDERS_JOB = 'inbox.reminders_due';
export const SCHEDULED_REPLIES_JOB = 'inbox.scheduled_replies_due';
const SLOT_MS = 30_000;

/** Returns how many jobs it offered. */
export async function scheduleFollowUpSweeps(now: number = Date.now()): Promise<number> {
  const prisma = getWorkerPrisma();
  const slot = Math.floor(now / SLOT_MS);
  const reminders = await prisma.$queryRaw<{ account_id: string }[]>`SELECT * FROM crm_due_conversation_reminder_accounts()`;
  const replies = await prisma.$queryRaw<{ account_id: string }[]>`SELECT * FROM crm_due_scheduled_reply_accounts()`;
  for (const { account_id } of reminders)
    await prisma.$executeRaw`INSERT INTO jobs(type,tenant_id,payload,dedupe_key,max_attempts)
      VALUES(${REMINDERS_JOB},${account_id}::uuid,'{}'::jsonb,${`inbox-reminders:${account_id}:${slot}`},2)
      ON CONFLICT(dedupe_key) DO NOTHING`;
  for (const { account_id } of replies)
    await prisma.$executeRaw`INSERT INTO jobs(type,tenant_id,payload,dedupe_key,max_attempts)
      VALUES(${SCHEDULED_REPLIES_JOB},${account_id}::uuid,'{}'::jsonb,${`inbox-scheduled:${account_id}:${slot}`},2)
      ON CONFLICT(dedupe_key) DO NOTHING`;
  return reminders.length + replies.length;
}
