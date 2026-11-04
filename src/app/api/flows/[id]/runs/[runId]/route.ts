import { NextResponse } from 'next/server';
import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { requireSession } from '@/lib/auth/session';
import { can } from '@/lib/auth/permissions';
import { tenantOf } from '@/lib/audience/http';
import { withTenant } from '@/lib/db/tenant';
import { getT } from '@/lib/i18n/translate';
import { loadPhoneMask, maskEmbeddedContact } from '@/lib/inbox/masking-apply';
import { publicRun, readFlowSummary, readRunEvents, readRunRow } from '@/lib/flows/run-inspection';
import { inspectReplayable, readRunIntents } from '@/lib/flows/replay';
import { FLOW_ID } from '@/lib/flows/version-http';

const t = getT('Api');

/**
 * GET /api/flows/[id]/runs/[runId] (any member)
 *
 * One run: its row (with version number), its event timeline, the states of
 * its outbound intents ({ kind, node_key, seq, attempt, part, status,
 * last_error, updated_at }, at most 200; never a payload or result), whether
 * it can be replayed (`replayable: { ok, reason? }`, `failed_node`), and what
 * the caller may do (`can: { replay, cancel }`). Another workspace's run is 404.
 */
export async function GET(request: Request, context: { params: Promise<{ id: string; runId: string }> }) {
  const { id, runId } = await context.params;
  try {
    await requireSession(request);
    const ctx = await requireRole('viewer');
    if (!FLOW_ID.test(id) || !FLOW_ID.test(runId)) return NextResponse.json({ error: t('common.notFound') }, { status: 404 });
    const result = await withTenant(tenantOf(ctx), async (tx) => {
      const flow = await readFlowSummary(tx, ctx.accountId, id);
      const run = flow && await readRunRow(tx, ctx.accountId, id, runId);
      if (!flow || !run) return null;
      const events = await readRunEvents(tx, ctx.accountId, [run.id], 1000);
      const intents = await readRunIntents(tx, ctx.accountId, run.id);
      const replay = await inspectReplayable(tx, ctx.accountId, id, run.id);
      const mask = await loadPhoneMask(tx, ctx);
      return {
        flow: { id: flow.id, name: flow.name, status: flow.status },
        run: maskEmbeddedContact(publicRun(run), mask),
        events,
        intents,
        replayable: replay?.replayable ?? { ok: false, reason: 'not_failed' },
        failed_node: replay?.failedNode ?? null,
        can: {
          replay: await can(tx, ctx, 'flows.replay'),
          cancel: await can(tx, ctx, 'flows.publish'),
        },
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
