import { getWorkerPrisma } from '@/lib/db/prisma';
import { enqueueTenantJobs } from '@/lib/jobs/queue';

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
  // One statement per job type for every workspace (same dedupe keys as one insert per workspace).
  await enqueueTenantJobs(REMINDERS_JOB, {}, reminders.map(({ account_id }) => ({ tenantId: account_id, dedupeKey: `inbox-reminders:${account_id}:${slot}` })), 2);
  await enqueueTenantJobs(SCHEDULED_REPLIES_JOB, {}, replies.map(({ account_id }) => ({ tenantId: account_id, dedupeKey: `inbox-scheduled:${account_id}:${slot}` })), 2);
  return reminders.length + replies.length;
}
