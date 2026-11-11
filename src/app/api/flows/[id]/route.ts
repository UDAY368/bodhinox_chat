import { NextResponse } from 'next/server';
import { createClient } from '@/lib/data/server';
import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { parseChannelScope, validateFlowForActivation } from '@/lib/flows/validate';
import { FLOW_TRIGGER_LIMITS, IG_TEST_USERNAME, type FlowRow, type FlowNodeRow, type FlowTriggerConfig, type FlowTriggerType } from '@/lib/flows/types';
import { getT } from '@/lib/i18n/translate';
import { hasMinRole, type AccountRole } from '@/lib/auth/roles';
import { apiNodeUsesSecrets, canonicalJson } from '@/lib/flows/api-request';
import { secretAttributeKeys } from '@/lib/workspace/attributes';
import { tenantOf } from '@/lib/audience/http';
import { withTenant } from '@/lib/db/tenant';
import { gateWithinLimit } from '@/lib/billing/limits';
import { requirePermission } from '@/lib/auth/permissions';
import { FlowVersionError, lockAccountPublishing, readPublishState, saveDraft, type DraftPatch, type VersionNode } from '@/lib/flows/versions';
import { flowVersionErrorResponse, requireFlowMutation } from '@/lib/flows/version-http';
import { normalizeTestUsername } from '@/lib/flows/triggers';
import { assertScopeChangeAllowed, FlowChannelError, flowChannelErrorResponse, scopeChangeAllowed } from '@/lib/flows/channel-section';

const t = getT('Api');

const MAX_TEST_NUMBERS = 3;

/**
 * Stage 5: Instagram test usernames, stored lowercase without @ (1–30 of
 * [a-z0-9._], up to 3, de-duplicated), or null when the list is invalid.
 */
function parseTestUsernames(raw: unknown): string[] | null {
  if (!Array.isArray(raw) || raw.some((n) => typeof n !== 'string')) return null;
  const names = [...new Set((raw as string[]).map((n) => normalizeTestUsername(n)))];
  return names.length <= FLOW_TRIGGER_LIMITS.testUsernames && names.every((n) => IG_TEST_USERNAME.test(n)) ? names : null;
}

/**
 * Stage 5: the stored shape of extra triggers (array of { trigger_type, config },
 * at most FLOW_TRIGGER_LIMITS.extraTriggers, 64 KB). Which triggers may combine
 * is a publish rule (validate.ts), so a draft can hold work in progress.
 */
function parseExtraTriggers(raw: unknown): FlowTriggerConfig[] | null {
  if (!Array.isArray(raw) || raw.length > FLOW_TRIGGER_LIMITS.extraTriggers) return null;
  const ok = raw.every((entry) => entry && typeof entry === 'object' && !Array.isArray(entry)
    && typeof (entry as Record<string, unknown>).trigger_type === 'string'
    && (entry as Record<string, unknown>).config !== null && typeof (entry as Record<string, unknown>).config === 'object'
    && !Array.isArray((entry as Record<string, unknown>).config));
  if (!ok || JSON.stringify(raw).length > 65_536) return null;
  return raw.map((entry) => ({ trigger_type: (entry as FlowTriggerConfig).trigger_type, config: (entry as FlowTriggerConfig).config }) as FlowTriggerConfig);
}

/** An ISO time the editor last loaded or saved the draft at, or null when malformed. */
function parseBaseUpdatedAt(raw: unknown): string | null {
  return typeof raw === 'string' && raw.length <= 40 && Number.isFinite(Date.parse(raw)) ? new Date(raw).toISOString() : null;
}

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
 * PUT and DELETE also pass the Origin/CSRF check (requireFlowMutation).
 * Stage 5: PUT takes `extra_triggers` (Instagram flows; checked on publish),
 * `test_usernames` (Instagram drafts; like test numbers they start the draft
 * running, so they need 'flows.publish', a plan slot and a valid draft) and
 * `base_updated_at` (the draft the editor last saw: when the stored draft is
 * newer the save is refused with 409 draft_changed and nothing is written;
 * omitted, the save goes through as before).
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
  trigger_type?: FlowTriggerType;
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
  /** Stage 5: up to 3 Instagram usernames a draft runs for. */
  test_usernames?: unknown;
  /** Stage 5: further triggers (Instagram flows). */
  extra_triggers?: unknown;
  /** Stage 5 autosave: flows.updated_at as the editor last saw it. */
  base_updated_at?: unknown;
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
    // A live session, the Origin/CSRF check and role >= agent.
    ctx = await requireFlowMutation(request);
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
  const testUsernames = body.test_usernames === undefined ? undefined : parseTestUsernames(body.test_usernames);
  if (testUsernames === null) {
    return NextResponse.json({ error: getT('Flows.testUsernames')('invalid') }, { status: 400 });
  }
  const extraTriggers = body.extra_triggers === undefined ? undefined : parseExtraTriggers(body.extra_triggers);
  if (extraTriggers === null) {
    return NextResponse.json({ error: getT('Flows.multiTrigger')('limitReached', { max: FLOW_TRIGGER_LIMITS.extraTriggers + 1 }) }, { status: 400 });
  }
  const baseUpdatedAt = body.base_updated_at === undefined || body.base_updated_at === null ? undefined : parseBaseUpdatedAt(body.base_updated_at);
  if (baseUpdatedAt === null) return NextResponse.json({ error: t('common.invalidJson') }, { status: 400 });

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
  // Test usernames are Instagram's (WhatsApp drafts keep test numbers).
  if (testUsernames?.length && (channelScope ?? currentScope) !== 'instagram') {
    return NextResponse.json({ error: getT('Flows.testUsernames')('invalid') }, { status: 400 });
  }
  // A published flow (Phase 12) runs its version, so editing its draft changes nothing live:
  // validation and 'flows.publish' apply when it is published. An active flow not yet
  // versioned (deploy-window straggler) still runs its draft, so it keeps the old rules.
  const draftIsLive = (current as FlowRow | null)?.status === 'active' && !(current as FlowRow | null)?.published_version_id;
  // New test numbers start a draft running on real phones: that publishes flow behaviour
  // too, so it needs 'flows.publish' like /activate.
  const storedNumbers = (current as FlowRow | null)?.test_numbers ?? [];
  const storedUsernames = (current as FlowRow | null)?.test_usernames ?? [];
  const changes = (next: string[] | undefined, stored: string[]) => !!next?.length &&
    (next.length !== stored.length || next.some((n) => !stored.includes(n)));
  // Stage 5: test usernames start an Instagram draft running for real accounts, like test numbers.
  const startsOrChangesTesting = changes(testNumbers, storedNumbers) || changes(testUsernames, storedUsernames);
  if (draftIsLive || startsOrChangesTesting) {
    try {
      await requirePermission(tenantOf(ctx), 'flows.publish');
    } catch (err) {
      return toErrorResponse(err);
    }
  }
  // A draft with test numbers runs for real customers' phones too, so it must be as valid as a live flow.
  const testing = (current as FlowRow | null)?.status === 'draft' &&
    ((testNumbers ?? storedNumbers).length > 0 || (testUsernames ?? storedUsernames).length > 0);
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
      extra_triggers: extraTriggers ?? flow.extra_triggers ?? [],
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
  if (testUsernames !== undefined) patch.test_usernames = testUsernames;
  if (extraTriggers !== undefined) patch.extra_triggers = extraTriggers;

  // A draft that starts testing runs like a live flow, so it takes a slot of the plan's active_flows:
  // counted under the account's publish lock in the transaction that saves it, so a concurrent
  // publish or test start cannot take the same slot.
  const startsTesting = !!testNumbers?.length || !!testUsernames?.length;
  let state;
  try {
    state = await withTenant(tenantOf(ctx), async (tx) => {
      if (startsTesting) {
        await lockAccountPublishing(tx, accountId);
        const [row] = await tx.$queryRaw<{ starts: boolean }[]>`SELECT status='draft' AND cardinality(test_numbers)=0
            AND cardinality(test_usernames)=0 AS starts
          FROM flows WHERE account_id=${accountId}::uuid AND id=${id}::uuid`;
        if (row?.starts) {
          const [{ n }] = await tx.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM flows
            WHERE account_id=${accountId}::uuid AND id<>${id}::uuid
            AND (status='active' OR (status='draft' AND (cardinality(test_numbers)>0 OR cardinality(test_usernames)>0)))`;
          await gateWithinLimit(tx, accountId, 'active_flows', n + 1);
        }
      }
      if (channelScope !== undefined) await assertScopeChangeAllowed(tx, accountId, id, channelScope);
      await saveDraft(tx, { accountId, flowId: id, patch, nodes: body.nodes as VersionNode[] | undefined, baseUpdatedAt });
      return readPublishState(tx, accountId, id);
    });
  } catch (err) {
    // Stage 5 autosave: a newer draft is never overwritten silently (the editor offers Reload or Overwrite).
    if (err instanceof FlowVersionError && err.code === 'draft_changed' && err.detail.stale_draft) {
      return NextResponse.json({ error: t('flows.draftChanged'), code: 'draft_changed', updated_at: err.detail.updated_at }, { status: 409 });
    }
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

  // Use the authenticated tenant client; role, the Origin/CSRF check and RLS all apply.
  try {
    await requireFlowMutation(_request);
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
