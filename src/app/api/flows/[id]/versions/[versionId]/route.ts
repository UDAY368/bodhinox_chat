import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth/account';
import { tenantOf } from '@/lib/audience/http';
import { withTenant } from '@/lib/db/tenant';
import { getT } from '@/lib/i18n/translate';
import { readVersion } from '@/lib/flows/versions';
import { FLOW_ID, flowVersionErrorResponse } from '@/lib/flows/version-http';

const t = getT('Api');

/**
 * GET /api/flows/[id]/versions/[versionId] (any member)
 *
 * The read-only snapshot a version runs: { version: { id, version,
 * published_at, trigger_type, trigger_config, entry_node_id,
 * fallback_policy, channel_scope, nodes } }. A version of another flow or
 * workspace is 404.
 */
export async function GET(_request: Request, context: { params: Promise<{ id: string; versionId: string }> }) {
  const { id, versionId } = await context.params;
  try {
    const ctx = await requireRole('viewer');
    if (!FLOW_ID.test(id) || !FLOW_ID.test(versionId)) return NextResponse.json({ error: t('common.notFound') }, { status: 404 });
    const version = await withTenant(tenantOf(ctx), (tx) => readVersion(tx, ctx.accountId, versionId));
    if (!version || version.flow_id !== id) return NextResponse.json({ error: t('common.notFound') }, { status: 404 });
    const { id: vid, version: number, published_at, trigger_type, trigger_config, entry_node_id, fallback_policy, channel_scope, nodes } = version;
    return NextResponse.json(
      { version: { id: vid, version: number, published_at, trigger_type, trigger_config, entry_node_id, fallback_policy, channel_scope, nodes } },
      { headers: { 'Cache-Control': 'private, no-store' } },
    );
  } catch (err) {
    return flowVersionErrorResponse(err);
  }
}
