import { NextResponse } from 'next/server';
import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { requireSession } from '@/lib/auth/session';
import { tenantOf } from '@/lib/audience/http';
import { withTenant } from '@/lib/db/tenant';
import { getT } from '@/lib/i18n/translate';
import { loadPhoneMask, maskEmbeddedContact } from '@/lib/inbox/masking-apply';
import { listRuns, parseRunListFilter, publicRun, readFlowSummary, readRunEvents, readVersionNumbers } from '@/lib/flows/run-inspection';
import { FLOW_ID } from '@/lib/flows/version-http';

const t = getT('Api');

/**
 * GET /api/flows/[id]/runs?status=&version=<versionId|none>&before=<started_at,id> (any member)
 *
 * Newest-first page of 50 runs of one flow, each with its version number and
 * its event timeline, plus `next_cursor` for the following page and the
 * flow's versions (for the filter). A flow of another workspace is 404 (RLS
 * scopes every read). The contact's number is masked for a masked member.
 */
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  try {
    await requireSession(request);
    const ctx = await requireRole('viewer');
    if (!FLOW_ID.test(id)) return NextResponse.json({ error: t('common.notFound') }, { status: 404 });
    const filter = parseRunListFilter(new URL(request.url).searchParams);
    if (!filter) return NextResponse.json({ error: t('common.invalidRequestBody') }, { status: 400 });

    const result = await withTenant(tenantOf(ctx), async (tx) => {
      const flow = await readFlowSummary(tx, ctx.accountId, id);
      if (!flow) return null;
      const page = await listRuns(tx, ctx.accountId, id, filter);
      const events = await readRunEvents(tx, ctx.accountId, page.runs.map((r) => r.id), 5000);
      const versions = await readVersionNumbers(tx, ctx.accountId, id);
      const mask = await loadPhoneMask(tx, ctx);
      return {
        flow: { id: flow.id, name: flow.name },
        runs: page.runs.map((run) => maskEmbeddedContact(publicRun(run), mask)),
        events,
        versions,
        next_cursor: page.next_cursor,
      };
    });
    if (!result) return NextResponse.json({ error: t('common.notFound') }, { status: 404 });
    return NextResponse.json(result, { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (err) {
    const response = toErrorResponse(err);
    if (response.status === 500) return NextResponse.json({ error: t('common.internalServerError') }, { status: 500 });
    return response;
  }
}
