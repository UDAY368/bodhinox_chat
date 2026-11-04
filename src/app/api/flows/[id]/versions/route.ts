import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth/account';
import { tenantOf } from '@/lib/audience/http';
import { withTenant } from '@/lib/db/tenant';
import { getT } from '@/lib/i18n/translate';
import { countActiveRuns, listVersions, readPublishState } from '@/lib/flows/versions';
import { FLOW_ID, flowVersionErrorResponse } from '@/lib/flows/version-http';

const t = getT('Api');

/**
 * GET /api/flows/[id]/versions (any member)
 *
 * { versions: [{ id, version, published_at, published_by_name, node_count, active_runs }],
 *   published_version, draft_hash, has_unpublished_changes, active_runs }
 *
 * active_runs counts every run in progress on the flow, including runs on no
 * version (draft test-number runs, deploy-window stragglers), which archive
 * refuses without cancel_active.
 *
 * Newest first. A flow of another workspace is 404 (RLS scopes every read).
 */
export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  try {
    const ctx = await requireRole('viewer');
    if (!FLOW_ID.test(id)) return NextResponse.json({ error: t('common.notFound') }, { status: 404 });
    const result = await withTenant(tenantOf(ctx), async (tx) => {
      const state = await readPublishState(tx, ctx.accountId, id);
      if (!state) return null;
      return { versions: await listVersions(tx, ctx.accountId, id), ...state,
        active_runs: await countActiveRuns(tx, ctx.accountId, id) };
    });
    if (!result) return NextResponse.json({ error: t('common.notFound') }, { status: 404 });
    return NextResponse.json(result, { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (err) {
    return flowVersionErrorResponse(err);
  }
}
