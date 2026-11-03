// Analytics aggregates, computed in SQL per workspace.
//
// Every query runs inside withTenant (FORCE RLS) and also names account_id
// explicitly so each time predicate hits an (account_id, <time>) index; see
// prisma/migrations/20261103120000_analytics for the measured plan and the
// indexes added for it. Ranges come from range.ts (at most 366 days). Results
// are counts and durations only: no message text, names of contacts or phone
// numbers ever leave these queries.
//
// Definitions (kept here so reports and tests agree):
// - A reply is an agent or bot message that did not fail and is not a template
//   or system message (as on the dashboard). A customer "wait" is the run of
//   customer messages between two replies; its response time runs from the
//   first customer message of the run to the next reply, looking up to
//   REPLY_LOOKAHEAD past the range end. A run that started before the range is
//   measured from its first message inside the range.
// - First response: each conversation's first wait in the range.
// - Resolution time: resolved_at - created_at for conversations resolved in the
//   range on their first cycle (reopened_count = 0); a reopened conversation
//   does not store when its later cycle started, so it is counted in
//   `resolved` but not timed.
// - Conversation source: inbound (created by a customer message), business
//   (created by an outbound send), or campaign reply (inbound within 72 hours
//   after a campaign message to that contact), or ad (the inbound message that
//   created the conversation carried a click-to-WhatsApp ad referral, stored in
//   ad_referrals since Phase 10). The buckets are exclusive and add up to the
//   total: ad wins over campaign reply, which wins over plain inbound. Only
//   ad_referrals columns the app role may read are used (never ctwa_clid).
// - Agent attribution: messages.sender_id when stamped. Inbox sends by a
//   member (text, media, templates, interactive, forms, products, payment
//   links) stamp sender_id since Phase 9 (src/lib/whatsapp/agent-attribution.ts);
//   bot, flow, automation, AI and public-API sends never do. Agent rows
//   created before AGENT_ATTRIBUTION_CUTOFF have no sender_id, so they fall
//   back to whoever is assigned now (which can credit a reassigned
//   conversation's history to the new assignee). Agent rows after the cutoff
//   without sender_id (public API /api/v1/messages, integrations) are not
//   credited to anyone. CSAT is not collected, so there is none.
// - Activity in a range: created in the range, or has a message in the range.
// - AI handoffs: conversations.ai_handoff_at in the range (set at handoff and
//   kept when AI is resumed; a later handoff overwrites it).
// - Campaign reply: a customer message in the contact's conversation within
//   72 hours after the campaign message was delivered (or sent).

import { Prisma } from '@prisma/client';
import { withTenant, type TenantContext, type TenantTransaction } from '@/lib/db/tenant';
import { workspaceTimezone, type AnalyticsRange } from './range';

/** Bounds every analytics statement so a heavy report cannot hold a connection. */
export const ANALYTICS_STATEMENT_TIMEOUT_MS = 15_000;
const REPLY_LOOKAHEAD = Prisma.sql`interval '7 days'`;
const REPLY_WINDOW = Prisma.sql`interval '72 hours'`;
/**
 * Before this instant agent rows never carried sender_id, so analytics falls
 * back to the current assignee; from it on, a NULL sender_id means a non-member
 * send (public API, integrations) and is left unattributed. Set no later than
 * the Phase 9 deploy: inbox sends between this instant and the deploy are
 * unattributed, which under-counts rather than crediting API traffic to the
 * assignee.
 */
export const AGENT_ATTRIBUTION_CUTOFF = '2026-11-03T00:00:00Z';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class AnalyticsInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AnalyticsInputError';
  }
}

function assertUuid(value: string | undefined | null, what: string): void {
  if (value != null && !UUID.test(value)) throw new AnalyticsInputError(`Invalid ${what}`);
}

/**
 * Runs analytics in one tenant transaction with a statement timeout, passing
 * the workspace timezone so callers can build a range with parseRange.
 */
export async function runAnalytics<T>(context: TenantContext,
  operation: (tx: TenantTransaction, timezone: string) => Promise<T>): Promise<T> {
  return withTenant(context, async (tx) => {
    await tx.$queryRaw`SELECT set_config('statement_timeout', ${String(ANALYTICS_STATEMENT_TIMEOUT_MS)}, true)`;
    return operation(tx, await workspaceTimezone(tx, context.accountId));
  });
}

const from = (range: AnalyticsRange) => Prisma.sql`${range.from.toISOString()}::timestamptz`;
const to = (range: AnalyticsRange) => Prisma.sql`${range.to.toISOString()}::timestamptz`;
/** The member credited with an agent row: its sender, or for pre-cutoff rows the current assignee. */
const agentOf = (senderId: string, at: string, assignee: string) => Prisma.sql`COALESCE(${Prisma.raw(senderId)},
  CASE WHEN ${Prisma.raw(at)} < ${AGENT_ATTRIBUTION_CUTOFF}::timestamptz THEN ${Prisma.raw(assignee)} END)`;
const isReply = (m: string) => Prisma.raw(
  `${m}.sender_type IN ('agent','bot') AND ${m}.status <> 'failed' AND ${m}.content_type NOT IN ('template','system')`);

/**
 * Customer waits in the range and the reply that ended each one. `seg` counts
 * replies so far in a conversation, so a wait in segment n is answered by the
 * reply that opens segment n+1. `conversations` optionally limits the scan.
 */
function waitsSql(accountId: string, range: AnalyticsRange, conversations: Prisma.Sql = Prisma.empty) {
  return Prisma.sql`
    msgs AS (
      SELECT m.conversation_id, m.created_at, m.sender_type, m.sender_id,
        count(*) FILTER (WHERE m.sender_type <> 'customer')
          OVER (PARTITION BY m.conversation_id ORDER BY m.created_at, m.arrival_sequence) AS seg
      FROM messages m
      WHERE m.account_id=${accountId}::uuid AND m.created_at >= ${from(range)} AND m.created_at < ${to(range)} + ${REPLY_LOOKAHEAD}
        AND (m.sender_type='customer' OR (${isReply('m')})) ${conversations}
    ), waits AS (
      SELECT conversation_id, seg, min(created_at) AS wait_at FROM msgs
      WHERE sender_type='customer' AND created_at < ${to(range)} GROUP BY conversation_id, seg
    ), answers AS (
      SELECT DISTINCT ON (conversation_id, seg) conversation_id, seg, created_at AS reply_at, sender_type, sender_id
      FROM msgs WHERE sender_type <> 'customer' ORDER BY conversation_id, seg, created_at
    ), responses AS (
      SELECT w.conversation_id, w.wait_at, a.reply_at, a.sender_type, a.sender_id
      FROM waits w LEFT JOIN answers a ON a.conversation_id=w.conversation_id AND a.seg=w.seg+1
    )`;
}

/**
 * A conversation created before the range had a message inside it.
 * last_message_at is only a cheap pre-filter (it has no upper bound); the
 * EXISTS uses messages_conversation_time_idx.
 */
const activeIn = (accountId: string, range: AnalyticsRange, c: string) => Prisma.sql`(${Prisma.raw(c)}.last_message_at >= ${from(range)}
  AND EXISTS (SELECT 1 FROM messages am WHERE am.account_id=${accountId}::uuid AND am.conversation_id=${Prisma.raw(c)}.id
    AND am.created_at >= ${from(range)} AND am.created_at < ${to(range)}))`;

const seconds = (later: string, earlier: string) => Prisma.raw(`extract(epoch FROM (${later} - ${earlier}))`);
/** A percentile of seconds, rounded to whole seconds (NULL when there are no rows). */
const pct = (p: number, expr: Prisma.Sql, filter: Prisma.Sql = Prisma.empty) =>
  Prisma.sql`round((percentile_cont(${Prisma.raw(String(p))}) WITHIN GROUP (ORDER BY ${expr}) ${filter})::numeric)`;

// ------------------------------------------------------------------ conversations

export interface ConversationFilters {
  whatsappConfigId?: string | null;
  teamId?: string | null;
}

export interface DurationStats {
  count: number;
  medianSeconds: number | null;
  p90Seconds: number | null;
}

export interface ConversationStats {
  started: { total: number; inbound: number; business: number; campaignReply: number; ad: number };
  /** Current lifecycle state of conversations with activity in the range. */
  byLifecycle: { bot: number; requesting: number; assigned: number; resolved: number };
  firstResponse: DurationStats & { unanswered: number };
  resolution: DurationStats & { resolved: number };
}

export async function conversationStats(tx: TenantTransaction, accountId: string, range: AnalyticsRange,
  filters: ConversationFilters = {}): Promise<ConversationStats> {
  assertUuid(filters.whatsappConfigId, 'number');
  assertUuid(filters.teamId, 'team');
  const filtered = Boolean(filters.whatsappConfigId || filters.teamId);
  const scopeFilter = Prisma.sql`
    ${filters.whatsappConfigId ? Prisma.sql`AND c.whatsapp_config_id=${filters.whatsappConfigId}::uuid` : Prisma.empty}
    ${filters.teamId ? Prisma.sql`AND c.assigned_agent_id IN (
      SELECT tm.user_id FROM team_members tm WHERE tm.account_id=${accountId}::uuid AND tm.team_id=${filters.teamId}::uuid)` : Prisma.empty}`;
  const rows = await tx.$queryRaw<{ stats: ConversationStats }[]>(Prisma.sql`
    WITH scope AS (
      SELECT c.id, c.contact_id, c.created_at, c.lifecycle_state, c.last_message_at, c.resolved_at,
        c.reopened_count, c.inbound_created_meta_id IS NOT NULL AS inbound, c.inbound_created_meta_id
      FROM conversations c WHERE c.account_id=${accountId}::uuid ${scopeFilter}
    ), campaign_sends AS MATERIALIZED (
      SELECT contact_id, sent_at FROM broadcast_recipients
      WHERE account_id=${accountId}::uuid AND sent_at >= ${from(range)} - ${REPLY_WINDOW} AND sent_at < ${to(range)}
        AND contact_id IS NOT NULL
    ), started AS (
      SELECT s.id, s.contact_id, s.created_at, s.inbound, s.inbound_created_meta_id FROM scope s
      WHERE s.created_at >= ${from(range)} AND s.created_at < ${to(range)}
    ), from_ad AS (
      -- The creating message carried an ad referral (a later re-click in the same conversation does not count).
      -- ad_referrals.wa_message_id is not granted to the app role, so match through the stored message.
      SELECT s.id FROM started s
      WHERE s.inbound AND EXISTS (SELECT 1 FROM ad_referrals r JOIN messages rm ON rm.account_id=r.account_id AND rm.id=r.message_id
        WHERE r.account_id=${accountId}::uuid AND r.conversation_id=s.id AND r.source_type='ad'
          AND rm.message_id=s.inbound_created_meta_id)
    ), campaign AS (
      -- A join, not EXISTS in the select list, so it plans as one hash join.
      SELECT DISTINCT s.id FROM started s JOIN campaign_sends cs ON cs.contact_id=s.contact_id
      WHERE s.inbound AND cs.sent_at <= s.created_at AND cs.sent_at >= s.created_at - ${REPLY_WINDOW}
    ), active AS (
      SELECT s.lifecycle_state FROM scope s
      WHERE s.created_at < ${to(range)} AND (s.created_at >= ${from(range)} OR ${activeIn(accountId, range, 's')})
    ), resolved AS (
      SELECT ${seconds('resolved_at', 'created_at')} AS secs, reopened_count FROM scope
      WHERE resolved_at >= ${from(range)} AND resolved_at < ${to(range)}
    ), ${waitsSql(accountId, range, filtered ? Prisma.sql`AND m.conversation_id IN (SELECT id FROM scope)` : Prisma.empty)},
    first_waits AS (
      SELECT DISTINCT ON (conversation_id) wait_at, reply_at FROM responses ORDER BY conversation_id, wait_at
    )
    SELECT json_build_object(
      'started', (SELECT json_build_object('total', count(*),
        'inbound', count(*) FILTER (WHERE inbound AND c.id IS NULL AND a.id IS NULL),
        'business', count(*) FILTER (WHERE NOT inbound), 'campaignReply', count(c.id) FILTER (WHERE a.id IS NULL),
        'ad', count(a.id))
        FROM started s LEFT JOIN campaign c ON c.id=s.id LEFT JOIN from_ad a ON a.id=s.id),
      'byLifecycle', (SELECT json_build_object(
        'bot', count(*) FILTER (WHERE lifecycle_state='bot'), 'requesting', count(*) FILTER (WHERE lifecycle_state='requesting'),
        'assigned', count(*) FILTER (WHERE lifecycle_state='assigned'), 'resolved', count(*) FILTER (WHERE lifecycle_state='resolved')) FROM active),
      'firstResponse', (SELECT json_build_object('count', count(reply_at), 'unanswered', count(*) - count(reply_at),
        'medianSeconds', ${pct(0.5, seconds('reply_at', 'wait_at'))},
        'p90Seconds', ${pct(0.9, seconds('reply_at', 'wait_at'))}) FROM first_waits),
      'resolution', (SELECT json_build_object('resolved', count(*), 'count', count(*) FILTER (WHERE reopened_count=0),
        'medianSeconds', ${pct(0.5, Prisma.sql`secs`, Prisma.sql`FILTER (WHERE reopened_count=0)`)},
        'p90Seconds', ${pct(0.9, Prisma.sql`secs`, Prisma.sql`FILTER (WHERE reopened_count=0)`)}) FROM resolved)
    ) AS stats`);
  return rows[0].stats;
}

// ------------------------------------------------------------------ agents

export interface AgentLeaderboardRow {
  userId: string;
  name: string | null;
  role: string;
  conversationsHandled: number;
  repliesSent: number;
  firstResponseCount: number;
  medianFirstResponseSeconds: number | null;
  resolved: number;
}

/** Per member of the workspace, busiest first. Members without activity are listed with zeros. */
export async function agentLeaderboard(tx: TenantTransaction, accountId: string, range: AnalyticsRange): Promise<AgentLeaderboardRow[]> {
  const rows = await tx.$queryRaw<{ board: AgentLeaderboardRow[] }[]>(Prisma.sql`
    WITH ${waitsSql(accountId, range)},
    agent_replies AS (
      SELECT m.conversation_id, ${agentOf('m.sender_id', 'm.created_at', 'c.assigned_agent_id')} AS agent_id
      FROM messages m JOIN conversations c ON c.account_id=m.account_id AND c.id=m.conversation_id
      WHERE m.account_id=${accountId}::uuid AND m.created_at >= ${from(range)} AND m.created_at < ${to(range)}
        AND m.sender_type='agent' AND (${isReply('m')})
    ), reply_totals AS (
      SELECT agent_id, count(*) AS replies, count(DISTINCT conversation_id) AS handled FROM agent_replies GROUP BY agent_id
    ), first_waits AS (
      -- Each conversation's first wait only, as in conversationStats and the report.
      SELECT DISTINCT ON (conversation_id) conversation_id, wait_at, reply_at, sender_type, sender_id
      FROM responses ORDER BY conversation_id, wait_at
    ), first_responses AS (
      SELECT ${agentOf('r.sender_id', 'r.reply_at', 'c.assigned_agent_id')} AS agent_id, ${seconds('r.reply_at', 'r.wait_at')} AS secs
      FROM first_waits r JOIN conversations c ON c.account_id=${accountId}::uuid AND c.id=r.conversation_id
      WHERE r.sender_type='agent' AND r.reply_at < ${to(range)}
    ), response_totals AS (
      SELECT agent_id, count(*) AS n, ${pct(0.5, Prisma.sql`secs`)} AS median
      FROM first_responses WHERE agent_id IS NOT NULL GROUP BY agent_id
    ), resolved_totals AS (
      SELECT assigned_agent_id AS agent_id, count(*) AS resolved FROM conversations
      WHERE account_id=${accountId}::uuid AND resolved_at >= ${from(range)} AND resolved_at < ${to(range)}
        AND assigned_agent_id IS NOT NULL GROUP BY assigned_agent_id
    )
    SELECT COALESCE(json_agg(json_build_object(
      'userId', am.user_id, 'name', p.full_name, 'role', am.role,
      'conversationsHandled', COALESCE(rt.handled, 0), 'repliesSent', COALESCE(rt.replies, 0),
      'firstResponseCount', COALESCE(fr.n, 0), 'medianFirstResponseSeconds', fr.median,
      'resolved', COALESCE(rs.resolved, 0))
      ORDER BY COALESCE(rt.handled, 0) DESC, COALESCE(rt.replies, 0) DESC, p.full_name), '[]'::json) AS board
    FROM account_memberships am
    LEFT JOIN profiles p ON p.user_id=am.user_id
    LEFT JOIN reply_totals rt ON rt.agent_id=am.user_id
    LEFT JOIN response_totals fr ON fr.agent_id=am.user_id
    LEFT JOIN resolved_totals rs ON rs.agent_id=am.user_id
    WHERE am.account_id=${accountId}::uuid`);
  return rows[0].board;
}

// ------------------------------------------------------------------ campaigns

export interface FunnelCounts {
  recipients: number;
  sent: number;
  delivered: number;
  read: number;
  replied: number;
  clicked: number;
  failed: number;
}

export interface CampaignFunnel {
  totals: FunnelCounts;
  broadcasts: (FunnelCounts & { id: string; name: string; templateName: string; at: string | null })[];
}

export const FUNNEL_BROADCAST_LIMIT = 100;

// count(broadcast_id): a campaign without recipients LEFT JOINs one NULL row.
const funnelColumns = Prisma.sql`
  'recipients', count(broadcast_id),
  'sent', count(*) FILTER (WHERE sent_at IS NOT NULL OR status IN ('sent','delivered','read','replied')),
  'delivered', count(*) FILTER (WHERE delivered_at IS NOT NULL OR status IN ('delivered','read','replied')),
  'read', count(*) FILTER (WHERE read_at IS NOT NULL OR status IN ('read','replied')),
  'replied', count(*) FILTER (WHERE replied),
  'clicked', count(*) FILTER (WHERE clicked_at IS NOT NULL),
  'failed', count(*) FILTER (WHERE status='failed')`;

/** Funnel for the campaigns scheduled (or created) in a range, or for one campaign. */
export async function campaignFunnel(tx: TenantTransaction, accountId: string,
  scope: { range: AnalyticsRange } | { broadcastId: string }): Promise<CampaignFunnel> {
  let match: Prisma.Sql;
  if ('broadcastId' in scope) {
    assertUuid(scope.broadcastId, 'campaign');
    match = Prisma.sql`id=${scope.broadcastId}::uuid`;
  } else {
    match = Prisma.sql`COALESCE(scheduled_at, created_at) >= ${from(scope.range)} AND COALESCE(scheduled_at, created_at) < ${to(scope.range)}`;
  }
  const rows = await tx.$queryRaw<{ funnel: CampaignFunnel }[]>(Prisma.sql`
    WITH b AS (
      SELECT id, name, template_name, COALESCE(scheduled_at, created_at) AS at FROM broadcasts
      WHERE account_id=${accountId}::uuid AND ${match}
    ), r AS (
      SELECT r.broadcast_id, r.status, r.sent_at, r.delivered_at, r.read_at, r.clicked_at,
        r.contact_id IS NOT NULL AND COALESCE(r.sent_at, r.delivered_at) IS NOT NULL AND EXISTS (
          SELECT 1 FROM conversations c JOIN messages m ON m.account_id=c.account_id AND m.conversation_id=c.id
          WHERE c.account_id=${accountId}::uuid AND c.contact_id=r.contact_id AND m.sender_type='customer'
            AND m.created_at >= COALESCE(r.sent_at, r.delivered_at)
            AND m.created_at <= COALESCE(r.delivered_at, r.sent_at) + ${REPLY_WINDOW}) AS replied
      FROM broadcast_recipients r JOIN b ON b.id=r.broadcast_id WHERE r.account_id=${accountId}::uuid
    ), per AS (
      SELECT b.id, b.name, b.template_name, b.at, json_build_object(${funnelColumns}) AS counts
      FROM b LEFT JOIN r ON r.broadcast_id=b.id GROUP BY b.id, b.name, b.template_name, b.at
    )
    SELECT json_build_object(
      'totals', (SELECT json_build_object(${funnelColumns}) FROM r),
      'broadcasts', COALESCE((SELECT json_agg(x) FROM (
        SELECT (json_build_object('id', id, 'name', name, 'templateName', template_name, 'at', at)::jsonb || counts::jsonb) AS x
        FROM per ORDER BY at DESC LIMIT ${FUNNEL_BROADCAST_LIMIT}) y), '[]'::json)
    ) AS funnel`);
  return rows[0].funnel;
}

// ------------------------------------------------------------------ flows

export interface FlowStats {
  started: number;
  completed: number;
  handedOff: number;
  timedOut: number;
  failed: number;
  cancelled: number;
  active: number;
  /** Where runs that did not complete stopped: the last node each one reached. */
  dropOff: { flowId: string; nodeKey: string; nodeType: string | null; runs: number }[];
}

export const DROP_OFF_LIMIT = 200;

export async function flowStats(tx: TenantTransaction, accountId: string, range: AnalyticsRange, flowId?: string | null): Promise<FlowStats> {
  assertUuid(flowId, 'flow');
  const rows = await tx.$queryRaw<{ stats: FlowStats }[]>(Prisma.sql`
    WITH runs AS (
      SELECT flow_id, status, current_node_key FROM flow_runs
      WHERE account_id=${accountId}::uuid AND started_at >= ${from(range)} AND started_at < ${to(range)}
        ${flowId ? Prisma.sql`AND flow_id=${flowId}::uuid` : Prisma.empty}
    ), drops AS (
      SELECT r.flow_id, r.current_node_key, n.node_type, count(*) AS runs
      FROM runs r LEFT JOIN flow_nodes n ON n.account_id=${accountId}::uuid AND n.flow_id=r.flow_id AND n.node_key=r.current_node_key
      WHERE r.status NOT IN ('completed','active') AND r.current_node_key IS NOT NULL
      GROUP BY r.flow_id, r.current_node_key, n.node_type
    )
    SELECT json_build_object(
      'started', count(*), 'completed', count(*) FILTER (WHERE status='completed'),
      'handedOff', count(*) FILTER (WHERE status='handed_off'), 'timedOut', count(*) FILTER (WHERE status='timed_out'),
      'failed', count(*) FILTER (WHERE status='failed'), 'cancelled', count(*) FILTER (WHERE status='cancelled'),
      'active', count(*) FILTER (WHERE status='active'),
      'dropOff', COALESCE((SELECT json_agg(json_build_object('flowId', flow_id, 'nodeKey', current_node_key, 'nodeType', node_type, 'runs', runs)
        ORDER BY runs DESC, current_node_key) FROM (SELECT * FROM drops ORDER BY runs DESC, current_node_key LIMIT ${DROP_OFF_LIMIT}) d), '[]'::json)
    ) AS stats FROM runs`);
  return rows[0].stats;
}

// ------------------------------------------------------------------ AI

export interface AiStats {
  aiReplies: number;
  /** Conversations the AI replied in during the range. */
  aiConversations: number;
  /** Conversations the AI handed to a person during the range (by ai_handoff_at). */
  handoffs: number;
  /** Questions first recorded in the range. RLS shows them to agents and above only, so a viewer sees 0. */
  unansweredRecorded: number;
  /** Of aiConversations: resolved with no agent reply or AI handoff between the first AI reply and the resolve, and not paused for a person. */
  resolvedByAi: number;
  resolutionRate: number | null;
}

export async function aiStats(tx: TenantTransaction, accountId: string, range: AnalyticsRange): Promise<AiStats> {
  const rows = await tx.$queryRaw<{ stats: AiStats }[]>(Prisma.sql`
    WITH ai AS (
      SELECT conversation_id, min(created_at) AS first_ai_at, count(*) AS replies FROM messages
      WHERE account_id=${accountId}::uuid AND created_at >= ${from(range)} AND created_at < ${to(range)}
        AND ai_generated AND sender_type <> 'customer' AND status <> 'failed'
      GROUP BY conversation_id
    ), resolved AS (
      SELECT ai.conversation_id FROM ai JOIN conversations c ON c.account_id=${accountId}::uuid AND c.id=ai.conversation_id
      -- Not handed to a person: no handoff between the first AI reply and the
      -- resolve, no pending handoff note, and the bot not paused (agent sends
      -- and manual takeovers pause it).
      WHERE c.resolved_at >= ai.first_ai_at AND NOT c.bot_paused AND c.ai_handoff_summary IS NULL
        AND (c.ai_handoff_at IS NULL OR c.ai_handoff_at < ai.first_ai_at OR c.ai_handoff_at > c.resolved_at)
        AND NOT EXISTS (
        SELECT 1 FROM messages m WHERE m.account_id=${accountId}::uuid AND m.conversation_id=ai.conversation_id
          AND m.sender_type='agent' AND m.created_at > ai.first_ai_at AND m.created_at <= c.resolved_at)
    )
    SELECT json_build_object(
      'aiReplies', (SELECT COALESCE(sum(replies), 0) FROM ai),
      'aiConversations', (SELECT count(*) FROM ai),
      'handoffs', (SELECT count(*) FROM conversations WHERE account_id=${accountId}::uuid
        AND ai_handoff_at >= ${from(range)} AND ai_handoff_at < ${to(range)}),
      'unansweredRecorded', (SELECT count(*) FROM ai_unanswered_questions WHERE account_id=${accountId}::uuid
        AND created_at >= ${from(range)} AND created_at < ${to(range)}),
      'resolvedByAi', (SELECT count(*) FROM resolved),
      'resolutionRate', (SELECT round((SELECT count(*) FROM resolved)::numeric / NULLIF((SELECT count(*) FROM ai), 0), 4))
    ) AS stats`);
  return rows[0].stats;
}

// ------------------------------------------------------------------ templates

export interface TemplateDailyRow {
  /** Local day (or ISO week Monday when range.bucket is 'week'), YYYY-MM-DD. */
  day: string;
  templateName: string;
  sent: number;
  delivered: number;
  read: number;
  replied: number;
  clicked: number;
  failed: number;
}

/**
 * Template sends per bucket and template: campaign recipients (by sent time)
 * plus template messages sent from the inbox, flows and automations. Clicks
 * are tracked for campaigns only.
 */
export async function templateDaily(tx: TenantTransaction, accountId: string, range: AnalyticsRange,
  templateName?: string | null): Promise<TemplateDailyRow[]> {
  if (templateName != null && (typeof templateName !== 'string' || templateName.length < 1 || templateName.length > 512))
    throw new AnalyticsInputError('Invalid template');
  const bucket = range.bucket === 'week' ? 'week' : 'day';
  return tx.$queryRaw<TemplateDailyRow[]>(Prisma.sql`
    WITH sends AS (
      SELECT b.template_name, r.sent_at AS at,
        (r.delivered_at IS NOT NULL OR r.status IN ('delivered','read','replied')) AS delivered,
        (r.read_at IS NOT NULL OR r.status IN ('read','replied')) AS read,
        r.clicked_at IS NOT NULL AS clicked, r.status='failed' AS failed,
        r.contact_id IS NOT NULL AND EXISTS (
          SELECT 1 FROM conversations c JOIN messages i ON i.account_id=c.account_id AND i.conversation_id=c.id
          WHERE c.account_id=${accountId}::uuid AND c.contact_id=r.contact_id AND i.sender_type='customer'
            AND i.created_at >= r.sent_at AND i.created_at <= COALESCE(r.delivered_at, r.sent_at) + ${REPLY_WINDOW}) AS replied
      FROM broadcast_recipients r JOIN broadcasts b ON b.account_id=r.account_id AND b.id=r.broadcast_id
      WHERE r.account_id=${accountId}::uuid AND r.sent_at >= ${from(range)} AND r.sent_at < ${to(range)}
        ${templateName ? Prisma.sql`AND b.template_name=${templateName}` : Prisma.empty}
      UNION ALL
      SELECT m.template_name, m.created_at, m.status IN ('delivered','read'), m.status='read', false, m.status='failed',
        EXISTS (SELECT 1 FROM messages i WHERE i.account_id=m.account_id AND i.conversation_id=m.conversation_id
          AND i.sender_type='customer' AND i.created_at > m.created_at AND i.created_at <= m.created_at + ${REPLY_WINDOW})
      FROM messages m
      WHERE m.account_id=${accountId}::uuid AND m.created_at >= ${from(range)} AND m.created_at < ${to(range)}
        AND m.content_type='template' AND m.sender_type IN ('agent','bot') AND m.template_name IS NOT NULL
        ${templateName ? Prisma.sql`AND m.template_name=${templateName}` : Prisma.empty}
    )
    SELECT to_char(date_trunc(${bucket}, at AT TIME ZONE ${range.timezone}), 'YYYY-MM-DD') AS day,
      template_name AS "templateName", count(*)::int AS sent,
      count(*) FILTER (WHERE delivered)::int AS delivered, count(*) FILTER (WHERE read)::int AS read,
      count(*) FILTER (WHERE replied)::int AS replied, count(*) FILTER (WHERE clicked)::int AS clicked,
      count(*) FILTER (WHERE failed)::int AS failed
    FROM sends GROUP BY 1, 2 ORDER BY 1, 2`);
}
