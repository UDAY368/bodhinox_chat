import { NextResponse } from 'next/server';
import { requirePermission } from '@/lib/auth/permissions';
import { tenantOf } from '@/lib/audience/http';
import { withTenant } from '@/lib/db/tenant';
import { getT } from '@/lib/i18n/translate';
import { checkRateLimit, rateLimitResponse } from '@/lib/rate-limit';
import { isUuid, migrateRuns } from '@/lib/flows/versions';
import { FLOW_ID, flowVersionErrorResponse, requireFlowMutation } from '@/lib/flows/version-http';

const t = getT('Api');

/**
 * POST /api/flows/[id]/runs/migrate  { from_version_id }
 *
 * Moves runs of an old version onto the flow's live version, in one
 * transaction: only runs waiting for the customer at a step that exists in
 * the live version with the same type, not waiting out a delay, and idle for
 * a minute. Returns { migrated, left: [{ node_key, count }], to_version }.
 * Needs 'flows.publish'; 10 a minute per member.
 */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  try {
    const caller = await requireFlowMutation(request);
    await requirePermission(tenantOf(caller), 'flows.publish');
    const limit = checkRateLimit(`flows-migrate:${caller.userId}`, { limit: 10, windowMs: 60_000 });
    if (!limit.success) return rateLimitResponse(limit);
    if (!FLOW_ID.test(id)) return NextResponse.json({ error: t('common.notFound') }, { status: 404 });
    const body = (await request.json().catch(() => null)) as { from_version_id?: unknown } | null;
    if (!isUuid(body?.from_version_id)) return NextResponse.json({ error: t('common.invalidRequestBody') }, { status: 400 });
    const fromVersionId = body.from_version_id;
    const result = await withTenant(tenantOf(caller), (tx) =>
      migrateRuns(tx, { accountId: caller.accountId, flowId: id, userId: caller.userId, fromVersionId }));
    return NextResponse.json(result);
  } catch (err) {
    return flowVersionErrorResponse(err);
  }
}
