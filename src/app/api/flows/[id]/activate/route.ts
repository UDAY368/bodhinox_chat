import { NextResponse } from 'next/server';
import { requirePermission } from '@/lib/auth/permissions';
import { getT } from '@/lib/i18n/translate';
import { tenantOf } from '@/lib/audience/http';
import { withTenant } from '@/lib/db/tenant';
import { loadWorkspaceCapabilities } from '@/lib/flows/capabilities';
import { archiveFlow, moveToDraft, pauseFlow, publishFlow } from '@/lib/flows/versions';
import { FLOW_ID, flowVersionErrorResponse, requireFlowMutation } from '@/lib/flows/version-http';
import { assertFlowChannelOpen, flowChannelErrorResponse } from '@/lib/flows/channel-section';

const t = getT('Api');

const STATUSES = ['draft', 'active', 'paused', 'archived'] as const;
type Target = (typeof STATUSES)[number];

/**
 * POST /api/flows/[id]/activate
 *
 * Body: { status: 'active' | 'paused' | 'archived' | 'draft', cancel_active?: boolean, draft_hash?: string }
 *
 * - active: publishes the draft as a new immutable version (or reuses the
 *   live one when nothing changed) and makes it live; a paused flow resumes
 *   this way. Needs 'flows.publish'. The draft is validated, including
 *   provider capabilities and Connect Flow loops through other live flows,
 *   under a per-account lock. draft_hash, when given, must match the draft
 *   on the server (409 draftChanged), so the author publishes what they saw.
 *   A flow whose channel the workspace has turned off is refused (409
 *   channel_disabled); a legacy 'any' flow needs one of its channels on.
 * - paused: no new enrollments; runs in progress finish on their version.
 *   cancel_active ends them now. Needs a published version (409).
 * - archived: 409 with active_runs while runs are in progress, unless
 *   cancel_active ends them.
 * - draft: a published flow is paused instead; a never-published flow keeps
 *   the draft/test-number meaning.
 *
 * Ending runs (cancel_active) needs 'flows.publish' as well. Returns
 * { flow, version? }; on validation failure 422 { error, issues }.
 */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  try {
    const caller = await requireFlowMutation(request);
    if (!FLOW_ID.test(id)) return NextResponse.json({ error: t('common.notFound') }, { status: 404 });
    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    const status = body?.status as Target | undefined;
    if (!status || !STATUSES.includes(status) ||
        (body?.cancel_active !== undefined && typeof body.cancel_active !== 'boolean') ||
        (body?.draft_hash !== undefined && (typeof body.draft_hash !== 'string' || !/^[0-9a-f]{64}$/.test(body.draft_hash)))) {
      return NextResponse.json({ error: t('flows.statusInvalid') }, { status: 400 });
    }
    const cancelActive = body?.cancel_active === true;
    const tenant = tenantOf(caller);
    // Publishing, and ending customers' runs, are per-feature permissions a workspace may turn off for a role.
    if (status === 'active' || cancelActive) await requirePermission(tenant, 'flows.publish');
    const args = { accountId: caller.accountId, flowId: id, userId: caller.userId };

    if (status === 'active') {
      // Capabilities are read on the worker connection, so they never depend on the caller's role.
      const caps = await loadWorkspaceCapabilities(tenant);
      const result = await withTenant(tenant, async (tx) => {
        await assertFlowChannelOpen(tx, caller.accountId, id);
        return publishFlow(tx, {
          ...args, caps, expectedDraftHash: typeof body?.draft_hash === 'string' ? body.draft_hash : undefined,
        });
      });
      return NextResponse.json({ flow: result.flow, version: result.version, reused: result.reused });
    }
    if (status === 'paused') {
      const result = await withTenant(tenant, (tx) => pauseFlow(tx, { ...args, cancelActive }));
      return NextResponse.json({ flow: result.flow, cancelled: result.cancelled });
    }
    if (status === 'archived') {
      const result = await withTenant(tenant, (tx) => archiveFlow(tx, { ...args, cancelActive }));
      return NextResponse.json({ flow: result.flow, cancelled: result.cancelled });
    }
    const result = await withTenant(tenant, (tx) => moveToDraft(tx, args));
    return NextResponse.json({ flow: result.flow, paused: result.paused });
  } catch (err) {
    return flowChannelErrorResponse(err) ?? flowVersionErrorResponse(err);
  }
}
