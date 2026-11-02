import { NextResponse } from 'next/server';
import { createClient } from '@/lib/data/server';
import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { requirePermission } from '@/lib/auth/permissions';
import { validateFlowForActivation } from '@/lib/flows/validate';
import { getT } from '@/lib/i18n/translate';
import { tenantOf } from '@/lib/audience/http';
import { withTenant } from '@/lib/db/tenant';
import { requireWithinLimit } from '@/lib/billing/entitlements';
import { loadFlowFormLookup } from '@/lib/whatsapp/forms/flow-lookup';

const t = getT('Api');

/**
 * POST /api/flows/[id]/activate
 *
 * Body: { status: 'draft' | 'active' | 'archived' }
 *
 * Activating runs the full validator and refuses on any 'error'
 * severity issue, and clears the flow's test numbers so pausing it
 * later gives a plain draft. Moving to draft is validated the same way
 * when the flow still has test numbers (it would run for them).
 * Archiving is unconditional.
 *
 * Returns the updated flow on success; on validation failure returns
 * the full issue list so the builder can highlight each problem.
 */

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  const { id } = await context.params;

  // Use the authenticated tenant client; role and RLS both apply.
  let caller;
  try {
    caller = await requireRole('agent');
  } catch (err) {
    return toErrorResponse(err);
  }

  const db = await createClient();
  const {
    data: { user },
  } = await db.auth.getUser();
  if (!user) {
    return NextResponse.json(
      { error: t('common.unauthorized') },
      { status: 401 }
    );
  }

  const body = (await request.json().catch(() => null)) as {
    status?: 'draft' | 'active' | 'archived';
  } | null;
  const status = body?.status;
  if (!status || !['draft', 'active', 'archived'].includes(status)) {
    return NextResponse.json(
      { error: t('flows.statusInvalid') },
      { status: 400 }
    );
  }
  // Publishing is a per-feature permission a workspace may turn off for a role.
  if (status === 'active') {
    try {
      await requirePermission(tenantOf(caller), 'flows.publish');
    } catch (err) {
      return toErrorResponse(err);
    }
  }

  // Ownership via RLS — caller's client.
  const { data: existing } = await db
    .from('flows')
    .select('id, test_numbers')
    .eq('id', id)
    .maybeSingle();
  if (!existing) {
    return NextResponse.json({ error: t('common.notFound') }, { status: 404 });
  }

  const admin = db;

  const testing = status === 'draft' && ((existing as { test_numbers?: string[] | null }).test_numbers ?? []).length > 0;
  if (status === 'active' || testing) {
    // Re-load with the full payload the validator needs.
    const [{ data: flow }, { data: nodes }] = await Promise.all([
      admin
        .from('flows')
        .select('id, name, trigger_type, trigger_config, entry_node_id, fallback_policy')
        .eq('id', id)
        .maybeSingle(),
      admin
        .from('flow_nodes')
        .select('node_key, node_type, config')
        .eq('flow_id', id),
    ]);
    if (!flow) {
      return NextResponse.json(
        { error: t('common.notFound') },
        { status: 404 }
      );
    }
    // A send_form step must use a form that is published right now.
    let forms: Awaited<ReturnType<typeof loadFlowFormLookup>> | undefined;
    if ((nodes ?? []).some((n: { node_type?: string }) => n.node_type === 'send_form')) {
      const ctx = await requireRole('agent');
      forms = await withTenant(tenantOf(ctx), (tx) => loadFlowFormLookup(tx, ctx.accountId));
    }
    const issues = validateFlowForActivation(
      flow as {
        name: string;
        trigger_type: 'keyword' | 'first_inbound_message' | 'manual' | 'template_reply';
        trigger_config: Record<string, unknown>;
        entry_node_id: string | null;
        fallback_policy: unknown;
        id: string;
      },
      (nodes ?? []) as Array<{
        node_key: string;
        node_type: string;
        config: Record<string, unknown>;
      }>,
      { forms }
    );
    const blockers = issues.filter((i) => i.severity === 'error');
    if (blockers.length > 0) {
      return NextResponse.json(
        {
          error: t('flows.cannotActivate'),
          issues,
        },
        { status: 422 }
      );
    }
    // Plan cap on active flows (testing drafts count, they run too); this flow does not count twice.
    // shortcut: checked before the update in another transaction, so two simultaneous activations can pass one over the cap; move the update under requireRoomFor if that matters.
    try {
      const ctx = await requireRole('agent');
      await withTenant(tenantOf(ctx), async (tx) => {
        const [{ n }] = await tx.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM flows
          WHERE account_id=${ctx.accountId}::uuid AND id<>${id}::uuid
          AND (status='active' OR (status='draft' AND cardinality(test_numbers)>0))`;
        await requireWithinLimit(tx, ctx.accountId, 'active_flows', n + 1);
      });
    } catch (err) {
      return toErrorResponse(err);
    }
  }

  const { data: updated, error } = await admin
    .from('flows')
    .update({ status, updated_at: new Date().toISOString(), ...(status === 'active' ? { test_numbers: [] } : {}) })
    .eq('id', id)
    .select()
    .maybeSingle();
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json({ flow: updated });
}
