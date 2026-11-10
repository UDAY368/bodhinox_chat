import { NextResponse } from 'next/server';
import { createClient } from '@/lib/data/server';
import { requireRole, toErrorResponse } from '@/lib/auth/account';
import type { FlowRow, FlowNodeRow } from '@/lib/flows/types';
import { getT } from '@/lib/i18n/translate';
import { hasMinRole, type AccountRole } from '@/lib/auth/roles';
import { apiNodeUsesSecrets } from '@/lib/flows/api-request';
import { secretAttributeKeys } from '@/lib/workspace/attributes';
import { parseChannelScope } from '@/lib/flows/validate';

const t = getT('Api');

/**
 * POST /api/flows/[id]/duplicate — copy a flow and its node graph into a
 * new draft owned by the caller. Test numbers and run counters are not
 * copied, so the copy never runs until someone tests or activates it.
 *
 * Body (optional): { channel_scope?: 'whatsapp' | 'instagram' } — the copy's
 * channel. Absent, the copy keeps its source's channel; a legacy 'any'
 * source becomes a WhatsApp copy, since no new flow runs on both. Splitting
 * a legacy flow is one copy per channel; the source stays until archived.
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  const { id } = await context.params;

  // Use the authenticated tenant client; role and RLS both apply.
  let role: AccountRole;
  let accountId: string;
  try {
    ({ role, accountId } = await requireRole('agent'));
  } catch (err) {
    return toErrorResponse(err);
  }

  const raw = await request.text().catch(() => '');
  let body: { channel_scope?: unknown } = {};
  if (raw.trim()) {
    try {
      body = JSON.parse(raw) as { channel_scope?: unknown };
    } catch {
      return NextResponse.json({ error: t('common.invalidJson') }, { status: 400 });
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return NextResponse.json({ error: t('common.invalidJson') }, { status: 400 });
    }
  }
  const target = parseChannelScope(body.channel_scope);
  if (target === null || target === 'any') {
    return NextResponse.json({ error: getT('Flows.channelSection')('anyNotAllowed') }, { status: 400 });
  }

  const db = await createClient();
  const {
    data: { user },
  } = await db.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: t('common.unauthorized') }, { status: 401 });
  }

  // RLS scopes this to the caller's account — another account's flow
  // returns null (404 below).
  const { data: source, error: readError } = await db.from('flows').select('*').eq('id', id).maybeSingle();
  if (readError) return NextResponse.json({ error: readError.message }, { status: 500 });
  if (!source) return NextResponse.json({ error: t('common.notFound') }, { status: 404 });
  const flow = source as FlowRow;

  const { data: nodeRows, error: nodesReadError } = await db
    .from('flow_nodes')
    .select('*')
    .eq('flow_id', id)
    .order('created_at', { ascending: true });
  if (nodesReadError) return NextResponse.json({ error: nodesReadError.message }, { status: 500 });
  const nodes = (nodeRows ?? []) as FlowNodeRow[];

  // Secret workspace values are admin-only (see PUT /api/flows/[id]): a
  // copy would hand a non-admin a new, editable step that sends the secret.
  if (!hasMinRole(role, 'admin')) {
    const secrets = await secretAttributeKeys(accountId);
    if (secrets.size && nodes.some((n) => n.node_type === 'api_request' && apiNodeUsesSecrets(n.config as Record<string, unknown>, secrets))) {
      return NextResponse.json({ error: t('flows.secretNeedsAdmin') }, { status: 403 });
    }
  }

  const { data: copy, error: flowErr } = await db
    .from('flows')
    .insert({
      user_id: user.id,
      account_id: accountId,
      name: t('flows.copyName', { name: flow.name }),
      description: flow.description,
      status: 'draft',
      trigger_type: flow.trigger_type,
      trigger_config: flow.trigger_config,
      entry_node_id: flow.entry_node_id,
      fallback_policy: flow.fallback_policy,
      // The asked-for channel, else the source's; never a new 'any'.
      channel_scope: target ?? (flow.channel_scope === 'instagram' ? 'instagram' : 'whatsapp'),
      test_numbers: [],
    })
    .select()
    .single();
  if (flowErr || !copy) {
    return NextResponse.json({ error: flowErr?.message ?? t('flows.insertFailed') }, { status: 500 });
  }

  if (nodes.length > 0) {
    const { error: nodesErr } = await db.from('flow_nodes').insert(
      nodes.map((n) => ({
        flow_id: copy.id,
        node_key: n.node_key,
        node_type: n.node_type,
        config: n.config,
        position_x: n.position_x ?? 0,
        position_y: n.position_y ?? 0,
      }))
    );
    if (nodesErr) {
      // Roll back so a half-copied flow doesn't sit as an empty draft.
      await db.from('flows').delete().eq('id', copy.id);
      return NextResponse.json({ error: nodesErr.message }, { status: 500 });
    }
  }
  return NextResponse.json({ flow: copy }, { status: 201 });
}
