import { NextResponse } from 'next/server';
import { createClient } from '@/lib/data/server';
import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { parseChannelScope, validateFlowForActivation } from '@/lib/flows/validate';
import type { FlowRow, FlowNodeRow } from '@/lib/flows/types';
import { getT } from '@/lib/i18n/translate';
import { hasMinRole, type AccountRole } from '@/lib/auth/roles';
import { apiNodeUsesSecrets, canonicalJson } from '@/lib/flows/api-request';
import { secretAttributeKeys } from '@/lib/workspace/attributes';
import { tenantOf } from '@/lib/audience/http';
import { withTenant } from '@/lib/db/tenant';
import { gateWithinLimit } from '@/lib/billing/limits';
import { requirePermission } from '@/lib/auth/permissions';
import { lockAccountPublishing, readPublishState, saveDraft, type DraftPatch, type VersionNode } from '@/lib/flows/versions';
import { flowVersionErrorResponse } from '@/lib/flows/version-http';
import { assertScopeChangeAllowed, FlowChannelError, flowChannelErrorResponse, scopeChangeAllowed } from '@/lib/flows/channel-section';

const t = getT('Api');

const MAX_TEST_NUMBERS = 3;

/** Digits-only, de-duplicated test numbers (8–15 digits each), or null when the list is invalid. */
function parseTestNumbers(raw: unknown): string[] | null {
  if (!Array.isArray(raw)) return null;
  const numbers = [...new Set(raw.map((n) => (typeof n === 'string' ? n.replace(/\D/g, '') : '')))];
  return numbers.length <= MAX_TEST_NUMBERS && numbers.every((n) => n.length >= 8 && n.length <= 15) ? numbers : null;
}

/**
 * GET   /api/flows/[id]  — fetch one flow with its draft nodes, plus
 *                          { published_version, draft_hash,
 *                          has_unpublished_changes } (Phase 12).
 * PUT   /api/flows/[id]  — replace name/trigger/entry/fallback + the
 *                          full draft node graph, in one transaction
 *                          (flow row first, so a publish never sees half
 *                          a save). A published flow's runs keep their
 *                          version: the draft goes live only through
 *                          /activate (publish), which validates it then.
 * DELETE /api/flows/[id] — hard delete (RLS+CASCADE clean up nodes,
 *                          versions, runs, events). A flow that was ever
 *                          published must be archived first, with no runs
 *                          in progress (409 useArchive).
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
  try {
    const ctx = await requireRole('viewer');
    const state = await withTenant(tenantOf(ctx), (tx) => readPublishState(tx, ctx.accountId, id));
    return NextResponse.json({ flow, nodes: nodes ?? [], ...state });
  } catch (err) {
    return flowVersionErrorResponse(err);
  }
}

interface PutBody {
  name?: string;
  description?: string | null;
  trigger_type?: 'keyword' | 'first_inbound_message' | 'manual' | 'template_reply' | 'order_received' | 'ad_click';
  trigger_config?: Record<string, unknown>;
  entry_node_id?: string | null;
  fallback_policy?: Record<string, unknown>;
  /**
   * The flow's channel (Phase 11, Stage 1): 'whatsapp' | 'instagram'. A legacy
   * 'any' flow may keep 'any'; nothing else may take it. A published flow's
   * channel is fixed (409 channel_locked); a never-published draft may move.
   */
  channel_scope?: unknown;
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
      if (beforeError) return NextResponse.json({ error: t('common.internalServerError') }, { status: 500 });
      const kept = new Set((before ?? []).map((n: { node_key: string; config: unknown }) => `${JSON.stringify([n.node_key, canonicalJson(n.config)])}`));
      const changed = body.nodes.some((n) => n.node_type === 'api_request' && apiNodeUsesSecrets(n.config, secrets) &&
        !kept.has(`${JSON.stringify([n.node_key, canonicalJson(n.config)])}`));
      if (changed) return NextResponse.json({ error: t('flows.secretNeedsAdmin') }, { status: 403 });
    }
  }
  const { data: current, error: readError } = await admin.from('flows').select('*').eq('id', id).maybeSingle();
  if (readError) return NextResponse.json({ error: t('common.internalServerError') }, { status: 500 });
  const currentScope = (current as FlowRow | null)?.channel_scope ?? 'whatsapp';
  const channelScope = parseChannelScope(body.channel_scope, currentScope);
  if (channelScope === null) {
    return NextResponse.json({ error: getT('Flows.channelSection')('anyNotAllowed') }, { status: 400 });
  }
  // Checked again under the row lock in the save transaction below.
  if (channelScope !== undefined && !scopeChangeAllowed(currentScope, channelScope, (current as FlowRow | null)?.published_version_id)) {
    return flowChannelErrorResponse(new FlowChannelError('channel_locked', currentScope === 'any' ? null : currentScope))!;
  }
  // A published flow (Phase 12) runs its version, so editing its draft changes nothing live:
  // validation and 'flows.publish' apply when it is published. An active flow not yet
  // versioned (deploy-window straggler) still runs its draft, so it keeps the old rules.
  const draftIsLive = (current as FlowRow | null)?.status === 'active' && !(current as FlowRow | null)?.published_version_id;
  // New test numbers start a draft running on real phones: that publishes flow behaviour
  // too, so it needs 'flows.publish' like /activate.
  const storedNumbers = (current as FlowRow | null)?.test_numbers ?? [];
  const startsOrChangesTesting = !!testNumbers?.length &&
    (testNumbers.length !== storedNumbers.length || testNumbers.some((n) => !storedNumbers.includes(n)));
  if (draftIsLive || startsOrChangesTesting) {
    try {
      await requirePermission(tenantOf(ctx), 'flows.publish');
    } catch (err) {
      return toErrorResponse(err);
    }
  }
  // A draft with test numbers runs for real customers' phones too, so it must be as valid as a live flow.
  const testing = (current as FlowRow | null)?.status === 'draft' &&
    (testNumbers ?? (current as FlowRow | null)?.test_numbers ?? []).length > 0;
  if (draftIsLive || testing) {
    const existing = body.nodes === undefined
      ? await admin.from('flow_nodes').select('*').eq('flow_id', id)
      : { data: body.nodes, error: null };
    if (existing.error) return NextResponse.json({ error: t('common.internalServerError') }, { status: 500 });
    const flow = current as FlowRow;
    const issues = validateFlowForActivation({
      name: body.name !== undefined ? body.name.trim() : flow.name,
      trigger_type: body.trigger_type ?? flow.trigger_type,
      trigger_config: body.trigger_config ?? { ...flow.trigger_config },
      entry_node_id: body.entry_node_id !== undefined ? body.entry_node_id : flow.entry_node_id,
      fallback_policy: body.fallback_policy ?? flow.fallback_policy,
      channel_scope: channelScope ?? flow.channel_scope,
      id,
    }, (existing.data ?? []) as FlowNodeRow[]);
    if (issues.some((issue) => issue.severity === 'error')) {
      return NextResponse.json({ error: t('flows.cannotSaveActive'), issues }, { status: 422 });
    }
  }

  // The body may not include `nodes` (a header-only save for editing the
  // trigger config without touching the graph): the node list is then kept.
  const patch: DraftPatch = {};
  if (body.name !== undefined) patch.name = body.name.trim();
  if (body.description !== undefined) patch.description = body.description;
  if (body.trigger_type !== undefined) patch.trigger_type = body.trigger_type;
  if (body.trigger_config !== undefined) patch.trigger_config = body.trigger_config;
  if (body.entry_node_id !== undefined) patch.entry_node_id = body.entry_node_id;
  if (body.fallback_policy !== undefined) patch.fallback_policy = body.fallback_policy;
  if (testNumbers !== undefined) patch.test_numbers = testNumbers;
  if (channelScope !== undefined) patch.channel_scope = channelScope;

  // A draft that starts testing runs like a live flow, so it takes a slot of the plan's active_flows:
  // counted under the account's publish lock in the transaction that saves it, so a concurrent
  // publish or test start cannot take the same slot.
  const startsTesting = !!testNumbers?.length;
  let state;
  try {
    state = await withTenant(tenantOf(ctx), async (tx) => {
      if (startsTesting) {
        await lockAccountPublishing(tx, accountId);
        const [row] = await tx.$queryRaw<{ starts: boolean }[]>`SELECT status='draft' AND cardinality(test_numbers)=0 AS starts
          FROM flows WHERE account_id=${accountId}::uuid AND id=${id}::uuid`;
        if (row?.starts) {
          const [{ n }] = await tx.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM flows
            WHERE account_id=${accountId}::uuid AND id<>${id}::uuid
            AND (status='active' OR (status='draft' AND cardinality(test_numbers)>0))`;
          await gateWithinLimit(tx, accountId, 'active_flows', n + 1);
        }
      }
      if (channelScope !== undefined) await assertScopeChangeAllowed(tx, accountId, id, channelScope);
      await saveDraft(tx, { accountId, flowId: id, patch, nodes: body.nodes as VersionNode[] | undefined });
      return readPublishState(tx, accountId, id);
    });
  } catch (err) {
    return flowChannelErrorResponse(err) ?? flowVersionErrorResponse(err);
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
  return NextResponse.json({ flow, nodes: nodes ?? [], ...state });
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

  // A flow that was ever published has runs pinned to its versions and an
  // audit trail: it is archived (which ends or waits out its runs) before it
  // can be deleted. A never-published flow deletes as before.
  const { data: row, error: rowError } = await guard.db.from('flows').select('id,status,published_version_id').eq('id', id).maybeSingle();
  if (rowError) return NextResponse.json({ error: t('common.internalServerError') }, { status: 500 });
  const flowRow = row as Pick<FlowRow, 'status' | 'published_version_id'> | null;
  if (flowRow?.published_version_id) {
    const { count, error: countError } = await guard.db.from('flow_runs').select('id', { count: 'exact', head: true })
      .eq('flow_id', id).eq('status', 'active');
    if (countError) return NextResponse.json({ error: t('common.internalServerError') }, { status: 500 });
    if (flowRow.status !== 'archived' || (count ?? 0) > 0) {
      return NextResponse.json({ error: t('flows.useArchive'), active_runs: count ?? 0 }, { status: 409 });
    }
  }

  // CASCADE on flow_nodes / flow_runs / flow_run_events handles the
  // children. Active runs end abruptly — there's no graceful "drain"
  // mechanism in v1, but that's intentional: deleting a flow is a
  // deliberate destructive action and the partial unique index will
  // free up the contact for new triggers immediately.
  const { error } = await guard.db.from('flows').delete().eq('id', id);
  if (error) {
    return NextResponse.json({ error: t('common.internalServerError') }, { status: 500 });
  }
  return NextResponse.json({ ok: true });
}
