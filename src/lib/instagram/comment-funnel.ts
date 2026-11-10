// The write side of the comment funnel (Stage 3, Instagram › Insights): marks
// the later steps of a comment-started run on its instagram_comment_events row
// (migration 20261117130500). Each mark is set once, the first time it happens,
// and only on the comment whose run it is; the read side (counts per post and
// per flow) is src/lib/instagram/funnel.ts.
//
// Steps and who marks them:
//   link_clicked   a tracked link sent in the run was opened
//   lead_captured  the run collected an email or phone number
//   followed       the follow gate saw the person follow the account
// The private reply and the "Opening DM" tap are already recorded by
// private-reply.ts (private_reply_status, opted_in_at).
//
// Worker role inside withTenant: the app role cannot write comment events.
// Nothing about the person or the message is logged or stored here.
import { Prisma } from '@prisma/client';
import { getWorkerPrisma } from '@/lib/db/prisma';
import { withTenant, type TenantTransaction } from '@/lib/db/tenant';

export type CommentFunnelStep = 'link_clicked' | 'lead_captured' | 'followed';

const COLUMN: Record<CommentFunnelStep, string> = {
  link_clicked: 'link_clicked_at',
  lead_captured: 'lead_captured_at',
  followed: 'followed_at',
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Marks `step` on the comment that started `runId`, inside the caller's
 * transaction (scoped to the run's workspace). True when this call set it;
 * false when the run started from no comment, the step was already marked,
 * or the ids are malformed.
 */
export async function markCommentFunnelStepTx(tx: TenantTransaction, accountId: string, runId: string,
  step: CommentFunnelStep): Promise<boolean> {
  if (!UUID.test(accountId) || !UUID.test(runId) || !Object.hasOwn(COLUMN, step)) return false;
  const column = Prisma.raw(COLUMN[step]);
  const updated = await tx.$executeRaw`UPDATE instagram_comment_events SET ${column}=now()
    WHERE account_id=${accountId}::uuid AND flow_run_id=${runId}::uuid AND ${column} IS NULL`;
  return updated > 0;
}

/** markCommentFunnelStepTx in its own worker transaction. */
export async function markCommentFunnelStep(accountId: string, runId: string, step: CommentFunnelStep): Promise<boolean> {
  if (!UUID.test(accountId) || !UUID.test(runId)) return false;
  return withTenant({ accountId, role: 'owner' }, (tx) => markCommentFunnelStepTx(tx, accountId, runId, step), getWorkerPrisma());
}
