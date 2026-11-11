import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth/account';
import { tenantOf } from '@/lib/audience/http';
import { withTenant } from '@/lib/db/tenant';
import { getT } from '@/lib/i18n/translate';
import { readNodeStats } from '@/lib/flows/versions';
import { FLOW_ID, flowVersionErrorResponse } from '@/lib/flows/version-http';

const t = getT('Api');

/**
 * GET /api/flows/[id]/node-stats (any member; Stage 5)
 *
 * { stats: { [node_key]: { waiting, passed } } } from run state: runs waiting
 * at each step now (a smart delay, a question) and runs that went past it.
 * Counts only, never contact data. A flow of another workspace is 404 (RLS
 * and the explicit account filter scope every read).
 */
export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  try {
    const ctx = await requireRole('viewer');
    if (!FLOW_ID.test(id)) return NextResponse.json({ error: t('common.notFound') }, { status: 404 });
    const stats = await withTenant(tenantOf(ctx), (tx) => readNodeStats(tx, ctx.accountId, id));
    if (!stats) return NextResponse.json({ error: t('common.notFound') }, { status: 404 });
    return NextResponse.json({ stats }, { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (err) {
    return flowVersionErrorResponse(err);
  }
}
