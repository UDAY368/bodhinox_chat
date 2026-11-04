import { NextResponse } from 'next/server';
import { requirePermission } from '@/lib/auth/permissions';
import { tenantOf } from '@/lib/audience/http';
import { withTenant } from '@/lib/db/tenant';
import { getT } from '@/lib/i18n/translate';
import { checkRateLimit, rateLimitResponse } from '@/lib/rate-limit';
import { cancelRuns, isUuid } from '@/lib/flows/versions';
import { FLOW_ID, flowVersionErrorResponse, requireFlowMutation } from '@/lib/flows/version-http';

const t = getT('Api');

/**
 * POST /api/flows/[id]/runs/cancel  { version_id } | { run_id }
 *
 * Ends the flow's runs in progress on one version, or one run, as
 * 'cancelled_by_member' (a run that ended meanwhile keeps its ending).
 * Returns { cancelled }. Needs 'flows.publish'; 10 a minute per member.
 */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  try {
    const caller = await requireFlowMutation(request);
    await requirePermission(tenantOf(caller), 'flows.publish');
    const limit = checkRateLimit(`flows-cancel-runs:${caller.userId}`, { limit: 10, windowMs: 60_000 });
    if (!limit.success) return rateLimitResponse(limit);
    if (!FLOW_ID.test(id)) return NextResponse.json({ error: t('common.notFound') }, { status: 404 });
    const body = (await request.json().catch(() => null)) as { version_id?: unknown; run_id?: unknown } | null;
    const versionId = body?.version_id === undefined ? undefined : body.version_id;
    const runId = body?.run_id === undefined ? undefined : body.run_id;
    // Exactly one target: pausing or archiving is how every run of a flow ends.
    if ((versionId === undefined) === (runId === undefined) ||
        (versionId !== undefined && !isUuid(versionId)) || (runId !== undefined && !isUuid(runId))) {
      return NextResponse.json({ error: t('common.invalidRequestBody') }, { status: 400 });
    }
    const result = await withTenant(tenantOf(caller), (tx) => cancelRuns(tx, {
      accountId: caller.accountId, flowId: id, userId: caller.userId,
      versionId: versionId as string | undefined, runId: runId as string | undefined,
    }));
    return NextResponse.json(result);
  } catch (err) {
    return flowVersionErrorResponse(err);
  }
}
