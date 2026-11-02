import { NextResponse } from 'next/server';
import { createClient } from '@/lib/data/server';
import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { validateFlowForActivation } from '@/lib/flows/validate';
import type { FlowRow, FlowNodeRow } from '@/lib/flows/types';
import { getT } from '@/lib/i18n/translate';
import { hasMinRole, type AccountRole } from '@/lib/auth/roles';
import { apiNodeUsesSecrets, canonicalJson } from '@/lib/flows/api-request';
import { secretAttributeKeys } from '@/lib/workspace/attributes';
import { tenantOf } from '@/lib/audience/http';
import { withTenant } from '@/lib/db/tenant';
import { requireWithinLimit } from '@/lib/billing/entitlements';
import { requirePermission } from '@/lib/auth/permissions';

const t = getT('Api');

const MAX_TEST_NUMBERS = 3;

/** Digits-only, de-duplicated test numbers (8–15 digits each), or null when the list is invalid. */
function parseTestNumbers(raw: unknown): string[] | null {
  if (!Array.isArray(raw)) return null;
  const numbers = [...new Set(raw.map((n) => (typeof n === 'string' ? n.replace(/\D/g, '') : '')))];
  return numbers.length <= MAX_TEST_NUMBERS && numbers.every((n) => n.length >= 8 && n.length <= 15) ? numbers : null;
}

/**
 * GET   /api/flows/[id]  — fetch one flow with its nodes.
 * PUT   /api/flows/[id]  — replace name/trigger/entry/fallback + the
 *                          full node graph (delete-then-insert under
 *                          the hood; not atomic, but the runner is
 *                          resilient to mid-edit reads — node_not_found
 *                          gracefully ends the run).
 * DELETE /api/flows/[id] — hard delete (RLS+CASCADE clean up nodes,
 *                          runs, events).
 *
 * All three require a signed-in caller who owns the flow. Flows is in
 * soft-GA — the beta gate that previously 404'd non-beta accounts is
 * gone; the "Beta" label in the UI is the only remaining signal.
 */

async function requireOwnership(flowId: string): Promise<
  | {
      ok: true;
      userId: string;
      db: Awaited<ReturnType<typeof createClient>>;
    }
  | { ok: false; status: number; body: { error: string } }
> {
  const db = await createClient();
  const {
    data: { user },
  } = await db.auth.getUser();
  if (!user) {
    return {
      ok: false,
      status: 401,
      body: { error: t('common.unauthorized') },
    };
  }
  // RLS scopes this to the caller — a flow owned by another user
  // returns null (404 below).
  const { data: flow } = await db
    .from('flows')
    .select('id')
    .eq('id', flowId)
    .maybeSingle();
  if (!flow) {
    return { ok: false, status: 404, body: { error: t('common.notFound') } };
  }
  return { ok: true, userId: user.id, db };
}

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> }
) {
  const { id } = await context.params;
  const guard = await requireOwnership(id);
  if (!guard.ok) return NextResponse.json(guard.body, { status: guard.status });
  const { db } = guard;

  const [{ data: flow }, { data: nodes }] = await Promise.all([
    db.from('flows').select('*').eq('id', id).maybeSingle(),
    db
      .from('flow_nodes')
      .select('*')
      .eq('flow_id', id)
      .order('created_at', { ascending: true }),
  ]);
  if (!flow) {
    return NextResponse.json({ error: t('common.notFound') }, { status: 404 });
  }
  return NextResponse.json({ flow, nodes: nodes ?? [] });
}

interface PutBody {
  name?: string;
  description?: string | null;
  trigger_type?: 'keyword' | 'first_inbound_message' | 'manual' | 'template_reply';
  trigger_config?: Record<string, unknown>;
  entry_node_id?: string | null;
  fallback_policy?: Record<string, unknown>;
  /** Up to 3 numbers a draft runs for; stored as digits. */
  test_numbers?: string[];
  nodes?: Array<{
    node_key: string;
    node_type: string;
    config: Record<string, unknown>;
    position_x?: number;
    position_y?: number;
  }>;
}

export async function PUT(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  const { id } = await context.params;

  // Use the authenticated tenant client; role and RLS both apply.
  let ctx: Awaited<ReturnType<typeof requireRole>>;
  let role: AccountRole;
  let accountId: string;
  try {
    ctx = await requireRole('agent');
    ({ role, accountId } = ctx);
  } catch (err) {
    return toErrorResponse(err);
  }

  const guard = await requireOwnership(id);
  if (!guard.ok) return NextResponse.json(guard.body, { status: guard.status });

  const body = (await request.json().catch(() => null)) as PutBody | null;
  if (!body) {
    return NextResponse.json(
      { error: t('common.invalidJson') },
      { status: 400 }
    );
  }
  if (body.name !== undefined && !body.name.trim()) {
    return NextResponse.json({ error: t('flows.nameEmpty') }, { status: 400 });
  }
  const testNumbers = body.test_numbers === undefined ? undefined : parseTestNumbers(body.test_numbers);
  if (testNumbers === null) {
    return NextResponse.json({ error: t('flows.testNumbersInvalid', { max: MAX_TEST_NUMBERS }) }, { status: 400 });
  }

  const admin = guard.db;
  // Secret workspace values are admin-only. A non-admin may keep an admin's
  // API step that uses one, but not add or change one: that step could send
  // the secret anywhere.
  if (body.nodes !== undefined && !hasMinRole(role, 'admin')) {
    const secrets = await secretAttributeKeys(accountId);
    if (secrets.size) {
      const { data: before, error: beforeError } = await admin.from('flow_nodes').select('node_key,config').eq('flow_id', id);
      if (beforeError) return NextResponse.json({ error: beforeError.message }, { status: 500 });
      const kept = new Set((before ?? []).map((n: { node_key: string; config: unknown }) => `${JSON.stringify([n.node_key, canonicalJson(n.config)])}`));
      const changed = body.nodes.some((n) => n.node_type === 'api_request' && apiNodeUsesSecrets(n.config, secrets) &&
        !kept.has(`${JSON.stringify([n.node_key, canonicalJson(n.config)])}`));
      if (changed) return NextResponse.json({ error: t('flows.secretNeedsAdmin') }, { status: 403 });
    }
  }
  const { data: current, error: readError } = await admin.from('flows').select('*').eq('id', id).maybeSingle();
  if (readError) return NextResponse.json({ error: readError.message }, { status: 500 });
  // Editing an active flow goes live at once, and new test numbers start a draft running on real
  // phones: both publish flow behaviour, so they need 'flows.publish' like /activate.
  const storedNumbers = (current as FlowRow | null)?.test_numbers ?? [];
  const startsOrChangesTesting = !!testNumbers?.length &&
    (testNumbers.length !== storedNumbers.length || testNumbers.some((n) => !storedNumbers.includes(n)));
  if ((current as FlowRow | null)?.status === 'active' || startsOrChangesTesting) {
    try {
      await requirePermission(tenantOf(ctx), 'flows.publish');
    } catch (err) {
      return toErrorResponse(err);
    }
  }
  // A draft with test numbers runs for real customers' phones too, so it must be as valid as a live flow.
  const testing = (current as FlowRow | null)?.status === 'draft' &&
    (testNumbers ?? (current as FlowRow | null)?.test_numbers ?? []).length > 0;
  if ((current as FlowRow | null)?.status === 'active' || testing) {
    const existing = body.nodes === undefined
      ? await admin.from('flow_nodes').select('*').eq('flow_id', id)
      : { data: body.nodes, error: null };
    if (existing.error) return NextResponse.json({ error: existing.error.message }, { status: 500 });
    const flow = current as FlowRow;
    const issues = validateFlowForActivation({
      name: body.name !== undefined ? body.name.trim() : flow.name,
      trigger_type: body.trigger_type ?? flow.trigger_type,
      trigger_config: body.trigger_config ?? { ...flow.trigger_config },
      entry_node_id: body.entry_node_id !== undefined ? body.entry_node_id : flow.entry_node_id,
      fallback_policy: body.fallback_policy ?? flow.fallback_policy,
      id,
    }, (existing.data ?? []) as FlowNodeRow[]);
    if (issues.some((issue) => issue.severity === 'error')) {
      return NextResponse.json({ error: t('flows.cannotSaveActive'), issues }, { status: 422 });
    }
  }
  // A draft that starts testing runs like a live flow, so it takes a slot of the plan's active_flows.
  // shortcut: checked before the update in another transaction, like the activate route.
  if (testing && !((current as FlowRow).test_numbers ?? []).length) {
    try {
      await withTenant(tenantOf(ctx), async (tx) => {
        const [{ n }] = await tx.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM flows
          WHERE account_id=${accountId}::uuid AND id<>${id}::uuid
          AND (status='active' OR (status='draft' AND cardinality(test_numbers)>0))`;
        await requireWithinLimit(tx, accountId, 'active_flows', n + 1);
      });
    } catch (err) {
      return toErrorResponse(err);
    }
  }

  // Update the flow row first — the body may not include `nodes` (a
  // header-only save for editing the trigger config without touching
  // the graph). Skip node replacement in that case.
  const flowPatch: Record<string, unknown> = {
    updated_at: new Date().toISOString(),
  };
  if (body.name !== undefined) flowPatch.name = body.name.trim();
  if (body.description !== undefined) flowPatch.description = body.description;
  if (body.trigger_type !== undefined)
    flowPatch.trigger_type = body.trigger_type;
  if (body.trigger_config !== undefined)
    flowPatch.trigger_config = body.trigger_config;
  if (body.entry_node_id !== undefined)
    flowPatch.entry_node_id = body.entry_node_id;
  if (body.fallback_policy !== undefined)
    flowPatch.fallback_policy = body.fallback_policy;
  if (testNumbers !== undefined) flowPatch.test_numbers = testNumbers;

  const { error: updErr } = await admin
    .from('flows')
    .update(flowPatch)
    .eq('id', id);
  if (updErr) {
    return NextResponse.json({ error: updErr.message }, { status: 500 });
  }

  if (body.nodes !== undefined) {
    // Delete-then-insert. Not transactional but the runner handles
    // mid-edit reads safely (a node_not_found ends the run cleanly).
    const { error: delErr } = await admin
      .from('flow_nodes')
      .delete()
      .eq('flow_id', id);
    if (delErr) {
      return NextResponse.json({ error: delErr.message }, { status: 500 });
    }
    if (body.nodes.length > 0) {
      const { error: insErr } = await admin.from('flow_nodes').insert(
        body.nodes.map((n) => ({
          flow_id: id,
          node_key: n.node_key,
          node_type: n.node_type,
          config: n.config,
          position_x: n.position_x ?? 0,
          position_y: n.position_y ?? 0,
        }))
      );
      if (insErr) {
        return NextResponse.json({ error: insErr.message }, { status: 500 });
      }
    }
  }

  // Re-fetch and return the new state — the editor uses the response
  // to reconcile its local form state.
  const [{ data: flow }, { data: nodes }] = await Promise.all([
    admin.from('flows').select('*').eq('id', id).maybeSingle(),
    admin
      .from('flow_nodes')
      .select('*')
      .eq('flow_id', id)
      .order('created_at', { ascending: true }),
  ]);
  return NextResponse.json({ flow, nodes: nodes ?? [] });
}

export async function DELETE(
  _request: Request,
  context: { params: Promise<{ id: string }> }
) {
  const { id } = await context.params;

  // Use the authenticated tenant client; role and RLS both apply.
  try {
    await requireRole('agent');
  } catch (err) {
    return toErrorResponse(err);
  }

  const guard = await requireOwnership(id);
  if (!guard.ok) return NextResponse.json(guard.body, { status: guard.status });

  // CASCADE on flow_nodes / flow_runs / flow_run_events handles the
  // children. Active runs end abruptly — there's no graceful "drain"
  // mechanism in v1, but that's intentional: deleting a flow is a
  // deliberate destructive action and the partial unique index will
  // free up the contact for new triggers immediately.
  const { error } = await guard.db.from('flows').delete().eq('id', id);
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json({ ok: true });
}
