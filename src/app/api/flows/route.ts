import { NextResponse } from 'next/server';
import { createClient } from '@/lib/data/server';
import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { flowTemplateChannels, getFlowTemplate } from '@/lib/flows/templates';
import { getT } from '@/lib/i18n/translate';
import { parseChannelScope } from '@/lib/flows/validate';
import { isChannel } from '@/lib/channels/capabilities';
import type { FlowTriggerType } from '@/lib/flows/types';
import { requireSession } from '@/lib/auth/session';
import { withTenant } from '@/lib/db/tenant';
import { clickThroughRate, flowLinkStats, type FlowLinkStats } from '@/lib/flows/link-tracking';

const t = getT('Api');
const tSection = getT('Flows.channelSection');
const tNames = getT('Channels.names');

/**
 * GET /api/flows — list the caller's flows. `?channel=whatsapp|instagram`
 *   lists one channel's section: its own flows plus legacy 'any' flows,
 *   which run on both. Without it every flow is listed (API-key and
 *   mcp-server clients).
 * POST /api/flows — create a new (draft) flow. `channel_scope` is
 *   'whatsapp' or 'instagram' (a new flow belongs to one channel); absent
 *   is WhatsApp, or for a template its first channel.
 *
 * Available to every authenticated user. The previous per-account
 * beta gate was removed when Flows went to soft-GA; the UI still
 * shows a "Beta" label so users know the surface is young, but the
 * routes themselves are open.
 */

async function requireUser(): Promise<
  | { ok: true; userId: string; db: Awaited<ReturnType<typeof createClient>> }
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
  return { ok: true, userId: user.id, db };
}

export async function GET(request: Request) {
  const guard = await requireUser();
  if (!guard.ok) {
    return NextResponse.json(guard.body, { status: guard.status });
  }
  const { db } = guard;
  const channel = new URL(request.url).searchParams.get('channel');
  if (channel !== null && !isChannel(channel)) {
    return NextResponse.json({ error: tSection('channelInvalid') }, { status: 400 });
  }

  let query = db.from('flows').select('*');
  if (channel) query = query.in('channel_scope', [channel, 'any']);
  const { data, error } = await query.order('created_at', { ascending: false });
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  const flows = (data ?? []) as Array<Record<string, unknown> & { id: string }>;
  // Stage 5 (5F): each flow's tracked-link stats and CTR for the list row
  // (null CTR: the flow never sent a tracked link). Best effort: the list
  // still loads if the stats query fails.
  // A caller without a browser session (API key) gets no stats (null CTR),
  // without a log line on every call.
  let stats = new Map<string, FlowLinkStats>();
  const session = await requireSession(request).catch(() => null);
  if (session && flows.length) {
    try {
      stats = await withTenant({ accountId: session.accountId, userId: session.userId, role: session.role },
        (tx) => flowLinkStats(tx, session.accountId, flows.map((f) => f.id)));
    } catch {
      console.error('[flows] link stats unavailable');
    }
  }
  return NextResponse.json({
    flows: flows.map((flow) => {
      const link = stats.get(flow.id) ?? { sent: 0, clicked: 0 };
      return { ...flow, link_stats: link, ctr: clickThroughRate(link) };
    }),
  });
}

export async function POST(request: Request) {
  // Use the authenticated tenant client; role and RLS both apply.
  try {
    await requireRole('agent');
  } catch (err) {
    return toErrorResponse(err);
  }

  const guard = await requireUser();
  if (!guard.ok) {
    return NextResponse.json(guard.body, { status: guard.status });
  }
  const { userId, db } = guard;

  // Use the authenticated tenant client; role and RLS both apply.
  const { data: profile } = await db
    .from('profiles')
    .select('account_id')
    .eq('user_id', userId)
    .single();
  const accountId = profile?.account_id as string | undefined;
  if (!accountId) {
    return NextResponse.json(
      { error: t('common.profileNotLinked') },
      { status: 403 }
    );
  }

  const body = (await request.json().catch(() => null)) as {
    name?: string;
    description?: string | null;
    trigger_type?: FlowTriggerType;
    trigger_config?: Record<string, unknown>;
    /**
     * If set, clone the matching template's name + trigger +
     * entry_node_id + nodes[] into a fresh draft for this user.
     * `name` from the body overrides the template default if
     * provided.
     */
    template_slug?: string;
    /** The flow's channel: 'whatsapp' | 'instagram' (Stage 1: never a new 'any'). */
    channel_scope?: unknown;
  } | null;
  if (!body) {
    return NextResponse.json(
      { error: t('common.invalidJson') },
      { status: 400 }
    );
  }
  const channel_scope = parseChannelScope(body.channel_scope);
  if (channel_scope === null || channel_scope === 'any') {
    return NextResponse.json({ error: tSection('anyNotAllowed') }, { status: 400 });
  }

  const admin = db;

  // -------- Template clone path --------
  if (body.template_slug) {
    const template = getFlowTemplate(body.template_slug);
    if (!template) {
      return NextResponse.json(
        {
          error: t('flows.unknownTemplate', {
            slug: String(body.template_slug),
          }),
        },
        { status: 400 }
      );
    }
    // The template's own channels: a create in a section the template does not
    // fit is refused rather than made into a flow that cannot publish.
    const channels = flowTemplateChannels(template);
    const scope = channel_scope ?? channels[0];
    if (!scope || !channels.includes(scope)) {
      return NextResponse.json(
        { error: tSection('templateUnavailable', { channel: tNames(scope ?? 'whatsapp') }) },
        { status: 400 }
      );
    }
    const { data: flow, error: flowErr } = await admin
      .from('flows')
      .insert({
        user_id: userId,
        account_id: accountId,
        name: body.name?.trim() || template.name,
        description: template.description,
        status: 'draft',
        trigger_type: template.trigger_type,
        trigger_config: template.trigger_config,
        entry_node_id: template.entry_node_id,
        channel_scope: scope,
        // Stage 5: templates may ship with sticky notes explaining each step.
        ...(template.canvas_notes?.length ? { canvas_notes: template.canvas_notes } : {}),
      })
      .select()
      .single();
    if (flowErr || !flow) {
      return NextResponse.json(
        { error: flowErr?.message ?? t('flows.insertFailed') },
        { status: 500 }
      );
    }
    if (template.nodes.length > 0) {
      const { error: nodesErr } = await admin.from('flow_nodes').insert(
        template.nodes.map((n) => ({
          flow_id: flow.id,
          node_key: n.node_key,
          node_type: n.node_type,
          config: n.config,
        }))
      );
      if (nodesErr) {
        // Roll back the parent flow so a half-cloned template doesn't
        // sit as an empty draft. CASCADE on flow_id removes the
        // (probably zero) nodes too.
        await admin.from('flows').delete().eq('id', flow.id);
        return NextResponse.json({ error: nodesErr.message }, { status: 500 });
      }
    }
    return NextResponse.json({ flow }, { status: 201 });
  }

  // -------- Plain (empty) create path --------
  if (!body.name?.trim()) {
    return NextResponse.json(
      { error: t('flows.nameRequired') },
      { status: 400 }
    );
  }
  const trigger_type = body.trigger_type ?? 'keyword';

  const { data, error } = await admin
    .from('flows')
    .insert({
      user_id: userId,
      account_id: accountId,
      name: body.name.trim(),
      description: body.description ?? null,
      status: 'draft',
      trigger_type,
      trigger_config: body.trigger_config ?? {},
      channel_scope: channel_scope ?? 'whatsapp',
    })
    .select()
    .single();
  if (error || !data) {
    return NextResponse.json(
      { error: error?.message ?? t('common.insertFailed') },
      { status: 500 }
    );
  }
  return NextResponse.json({ flow: data }, { status: 201 });
}
