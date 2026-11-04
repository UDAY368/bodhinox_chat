// Inbound enqueue for advisory assessments, called by the 'ai_assess' stage of
// inbound actions after the message webhook, for customer text only.
//
// It only queues a job; it never calls a provider and never sends anything.
// Nothing happens when the deployment kill switch is off or the workspace has
// not turned assessments on. A burst of messages collapses into one job per
// conversation per 10-minute slot (dedupe key), run at the slot's end. It never
// throws: an assessment is advisory, so a failed enqueue is logged as a reason
// code and the inbound job carries on.

import { getWorkerPrisma } from '@/lib/db/prisma';
import { withTenant } from '@/lib/db/tenant';
import { enqueueJob } from '@/lib/jobs/queue';
import { aiDeploymentEnabled } from '../gate';
import { logAiEvent } from '../log';
import { readAiSettings } from '../settings';
import { AI_ASSESS_JOB, assessJobSlot } from './job-contract';

/** Queues the conversation's debounced assessment; true when a job was queued (or already was). */
export async function enqueueAssessmentForInbound(accountId: string, conversationId: string, now: number = Date.now()): Promise<boolean> {
  if (!aiDeploymentEnabled()) return false;
  try {
    const settings = await withTenant({ accountId, role: 'owner' }, (tx) => readAiSettings(tx, accountId), getWorkerPrisma());
    if (!settings.assessment_enabled) return false;
    const { dedupeKey, runAt } = assessJobSlot(conversationId, now);
    await enqueueJob(AI_ASSESS_JOB, { conversationId }, { tenantId: accountId, dedupeKey, runAt, maxAttempts: 3 });
    return true;
  } catch (error) {
    logAiEvent({ feature: 'assess', reason: 'enqueue_failed', accountId, error });
    return false;
  }
}
