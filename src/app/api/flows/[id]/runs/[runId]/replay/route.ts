import { NextResponse } from 'next/server';
import { requirePermission } from '@/lib/auth/permissions';
import { tenantOf } from '@/lib/audience/http';
import { withTenant } from '@/lib/db/tenant';
import { getT } from '@/lib/i18n/translate';
import { checkRateLimit, rateLimitResponse } from '@/lib/rate-limit';
import { isUniqueViolation, ReplayError, replayFlowRun, type ReplayRefusal } from '@/lib/flows/replay';
import { FLOW_ID, flowVersionErrorResponse, requireFlowMutation } from '@/lib/flows/version-http';

const t = getT('Api');

const REFUSAL_KEY: Record<ReplayRefusal, string> = {
  not_failed: 'flows.replay.notFailed',
  too_old: 'flows.replay.tooOld',
  no_contact: 'flows.replay.noContact',
  flow_archived: 'flows.replay.flowArchived',
  not_pinned: 'flows.replay.notPinned',
  not_replayable_reason: 'flows.replay.notReplayableReason',
  needs_reconciliation: 'flows.replay.needsReconciliation',
  already_sent: 'flows.replay.alreadySent',
  conversation_busy: 'flows.replay.conversationBusy',
};

const refused = (reason: ReplayRefusal) =>
  NextResponse.json({ error: t(REFUSAL_KEY[reason]), reason }, { status: 409 });

/**
 * POST /api/flows/[id]/runs/[runId]/replay
 *
 * Re-runs the step a failed run stopped on, on the run's pinned version.
 * Needs 'flows.replay' (admin ceiling), a CSRF-checked live session, and is
 * limited to 10 a minute per member. The run is reactivated and the
 * `flow.replay` job queued in one transaction before the 202. Refusals are
 * 409 with a fixed `reason` (see src/lib/flows/replay.ts); a step whose send
 * has an ambiguous outcome is never re-sent (needs_reconciliation).
 */
export async function POST(request: Request, context: { params: Promise<{ id: string; runId: string }> }) {
  const { id, runId } = await context.params;
  try {
    const caller = await requireFlowMutation(request);
    await requirePermission(tenantOf(caller), 'flows.replay');
    const limit = checkRateLimit(`flows-replay:${caller.userId}`, { limit: 10, windowMs: 60_000 });
    if (!limit.success) return rateLimitResponse(limit);
    if (!FLOW_ID.test(id) || !FLOW_ID.test(runId)) return NextResponse.json({ error: t('common.notFound') }, { status: 404 });
    const queued = await withTenant(tenantOf(caller), (tx) =>
      replayFlowRun(tx, { accountId: caller.accountId, flowId: id, runId, userId: caller.userId }));
    return NextResponse.json({ replay: queued }, { status: 202 });
  } catch (err) {
    if (err instanceof ReplayError) {
      return err.reason === 'not_found' ? NextResponse.json({ error: t('common.notFound') }, { status: 404 }) : refused(err.reason);
    }
    // Another run started on the conversation between the check and the update.
    if (isUniqueViolation(err)) return refused('conversation_busy');
    return flowVersionErrorResponse(err);
  }
}
