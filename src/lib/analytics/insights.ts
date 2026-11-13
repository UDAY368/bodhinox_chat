// Analytics redesign: trends over time, the "needs attention" counts, team
// stats with a per-member drill-down, automation runs, and the grouped metrics
// saved reports are built from. Every query takes a TenantTransaction (callers
// run it inside withTenant / runAnalytics) and also names account_id
// explicitly so each time predicate hits an (account_id, <time>) index.
// Results are counts, durations, member names and label/automation names only:
// never message text, contact names or phone numbers.
//
// One engine (factsSql) backs every grouped figure so the Overview,
// Conversations and Team tabs and a saved report agree on definitions:
// - new:        a conversation created in the range (closed when it is
//               resolved now or its status is closed);
// - resolved:   resolved_at in the range, timed from the start of the resolved
//               cycle as in queries.ts (untimed when that start is unknown);
// - first response: each conversation's first customer wait in the range and
//               the reply that ended it (queries.ts waitsSql). Grouped by
//               member, the first member reply to that wait instead
//               (humanFirstSql, as on the leaderboard);
// - messages:   agent and bot messages created in the range (system notes
//               excluded); failed ones are counted apart, never as sent.
// A member is credited as in queries.ts (agentOf): the sender, or for rows
// before AGENT_ATTRIBUTION_CUTOFF the current assignee. A conversation counts
// once for each label it carries, or under "none" without one.

import { Prisma } from '@prisma/client';
import type { TenantTransaction } from '@/lib/db/tenant';
import { agentOf, AnalyticsInputError, humanFirstSql, waitsSql } from './queries';
import { bucketKeys, localDay, type AnalyticsRange } from './range';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const from = (range: AnalyticsRange) => Prisma.sql`${range.from.toISOString()}::timestamptz`;
const to = (range: AnalyticsRange) => Prisma.sql`${range.to.toISOString()}::timestamptz`;

export type Channel = 'whatsapp' | 'instagram';
export interface InsightFilters {
  /** Only conversations on this channel (a legacy null channel is WhatsApp). */
  channel?: Channel | null;
  /** Only conversations on this WhatsApp number. */
  whatsappConfigId?: string | null;
}

export function assertFilters(filters: InsightFilters): void {
  if (filters.channel != null && filters.channel !== 'whatsapp' && filters.channel !== 'instagram')
    throw new AnalyticsInputError('Invalid channel');
  if (filters.whatsappConfigId != null && !UUID.test(filters.whatsappConfigId)) throw new AnalyticsInputError('Invalid number');
}

/** The x axis of a range: hours for one day, else the range's bucket (day, or week past 90 days). */
export type TimeBucket = 'hour' | 'day' | 'week';
export function timeBucket(range: AnalyticsRange): TimeBucket {
  return range.days === 1 ? 'hour' : range.bucket;
}

/**
 * Every bucket key of a range, in order, for zero-filling: `YYYY-MM-DDTHH`
 * hours of the one day (up to the current hour when the range ends now), else
 * days or ISO-week Mondays (range.ts bucketKeys).
 */
export function timeKeys(range: AnalyticsRange): string[] {
  if (timeBucket(range) !== 'hour') return bucketKeys(range);
  const endsToday = localDay(range.to, range.timezone) === range.startDay;
  const last = endsToday ? localHour(new Date(range.to.getTime() - 1), range.timezone) : 23;
  return Array.from({ length: Math.max(0, last) + 1 }, (_, h) => `${range.startDay}T${String(h).padStart(2, '0')}`);
}

function localHour(instant: Date, timezone: string): number {
  return Number(new Intl.DateTimeFormat('en-US', { timeZone: timezone, hour: '2-digit', hourCycle: 'h23' }).format(instant)) % 24;
}

const KEY_FORMAT: Record<TimeBucket | 'hour_of_day', string> = {
  hour: 'YYYY-MM-DD"T"HH24', day: 'YYYY-MM-DD', week: 'YYYY-MM-DD', hour_of_day: 'HH24',
};
const TRUNC: Record<TimeBucket, string> = { hour: 'hour', day: 'day', week: 'week' };

export type MetricGroup = TimeBucket | 'hour_of_day' | 'channel' | 'agent' | 'label';

/** The group key of a fact row in `keyed` (alias f; labels joined as l). */
function keyExpr(group: MetricGroup, range: AnalyticsRange): Prisma.Sql {
  if (group === 'channel') return Prisma.sql`f.channel`;
  if (group === 'agent') return Prisma.sql`f.member::text`;
  if (group === 'label') return Prisma.sql`COALESCE(l.label_id::text, 'none')`;
  if (group === 'hour_of_day') return Prisma.sql`to_char(f.at AT TIME ZONE ${range.timezone}, ${KEY_FORMAT.hour_of_day})`;
  return Prisma.sql`to_char(date_trunc(${TRUNC[group]}, f.at AT TIME ZONE ${range.timezone}), ${KEY_FORMAT[group]})`;
}

/**
 * CTEs `scope` (the workspace's conversations, on one number when asked) and
 * `facts` (one row per new, resolved, first-response and message event in the
 * range: f, cid, channel, at, secs, member, closed). `byMember` credits first
 * responses and messages to members (see the header). The channel filter is
 * applied by the caller (channelWhere), so a channel split can ignore it.
 */
function factsSql(accountId: string, range: AnalyticsRange, filters: InsightFilters, byMember: boolean): Prisma.Sql {
  const numbered = Boolean(filters.whatsappConfigId);
  const firstResponses = byMember
    ? Prisma.sql`SELECT 'frt'::text, h.conversation_id, s.channel, h.wait_at, extract(epoch FROM (h.reply_at - h.wait_at))::float8,
        ${agentOf('h.sender_id', 'h.reply_at', 'h.assigned_agent_id')}, false
      FROM human_first h JOIN scope s ON s.id=h.conversation_id WHERE h.reply_at < ${to(range)}`
    : Prisma.sql`SELECT 'frt'::text, fw.conversation_id, s.channel, fw.wait_at, extract(epoch FROM (fw.reply_at - fw.wait_at))::float8,
        NULL::uuid, false
      FROM first_waits fw JOIN scope s ON s.id=fw.conversation_id WHERE fw.reply_at IS NOT NULL`;
  return Prisma.sql`
    scope AS (
      SELECT c.id, COALESCE(c.channel, 'whatsapp') AS channel, c.assigned_agent_id, c.created_at, c.resolved_at,
        (c.lifecycle_state='resolved' OR c.status='closed') AS closed,
        CASE WHEN c.reopened_count=0 OR c.reopened_at IS NOT NULL
          THEN extract(epoch FROM (c.resolved_at - COALESCE(c.reopened_at, c.created_at)))::float8 END AS res_secs
      FROM conversations c WHERE c.account_id=${accountId}::uuid
        ${numbered ? Prisma.sql`AND c.whatsapp_config_id=${filters.whatsappConfigId}::uuid` : Prisma.empty}
    ), ${waitsSql(accountId, range, numbered ? Prisma.sql`AND m.conversation_id IN (SELECT id FROM scope)` : Prisma.empty)},
    first_waits AS (
      SELECT DISTINCT ON (conversation_id) conversation_id, wait_at, reply_at FROM responses ORDER BY conversation_id, wait_at
    ), ${byMember ? Prisma.sql`${humanFirstSql(accountId)},` : Prisma.empty}
    facts AS MATERIALIZED (
      SELECT 'new'::text AS f, s.id AS cid, s.channel, s.created_at AS at, NULL::float8 AS secs, s.assigned_agent_id AS member, s.closed
      FROM scope s WHERE s.created_at >= ${from(range)} AND s.created_at < ${to(range)}
      UNION ALL
      SELECT 'res', s.id, s.channel, s.resolved_at, s.res_secs, s.assigned_agent_id, true
      FROM scope s WHERE s.resolved_at >= ${from(range)} AND s.resolved_at < ${to(range)}
      UNION ALL
      ${firstResponses}
      UNION ALL
      SELECT CASE WHEN m.status='failed' THEN 'fail' ELSE 'msg' END, m.conversation_id, s.channel, m.created_at, NULL::float8,
        CASE WHEN m.sender_type='agent' THEN ${agentOf('m.sender_id', 'm.created_at', 's.assigned_agent_id')} END, false
      FROM messages m JOIN scope s ON s.id=m.conversation_id
      WHERE m.account_id=${accountId}::uuid AND m.created_at >= ${from(range)} AND m.created_at < ${to(range)}
        AND m.sender_type IN ('agent','bot') AND m.content_type <> 'system'
    )`;
}

const channelWhere = (filters: InsightFilters) =>
  filters.channel ? Prisma.sql`AND f.channel=${filters.channel}` : Prisma.empty;
const memberWhere = (memberId: string | null | undefined) =>
  memberId ? Prisma.sql`AND f.member=${memberId}::uuid` : Prisma.empty;
const labelJoin = (accountId: string) =>
  Prisma.sql`LEFT JOIN conversation_label_links l ON l.account_id=${accountId}::uuid AND l.conversation_id=f.cid`;
const pctOf = (p: number, filter: string) =>
  Prisma.raw(`round((percentile_cont(${p}) WITHIN GROUP (ORDER BY f.secs) FILTER (WHERE ${filter}))::numeric)`);

/** The aggregate columns of one group (as JSON fields). */
const AGGREGATES = Prisma.sql`
  count(*) FILTER (WHERE f.f='new')::int AS "newC",
  count(*) FILTER (WHERE f.f='new' AND f.closed)::int AS closed,
  count(*) FILTER (WHERE f.f='res')::int AS resolved,
  ${pctOf(0.5, "f.f='frt'")} AS "frtMedian",
  ${pctOf(0.9, "f.f='frt'")} AS "frtP90",
  count(*) FILTER (WHERE f.f='frt')::int AS "frtCount",
  ${pctOf(0.5, "f.f='res' AND f.secs IS NOT NULL")} AS "resMedian",
  count(*) FILTER (WHERE f.f='msg')::int AS msgs,
  count(*) FILTER (WHERE f.f='fail')::int AS failed,
  count(DISTINCT f.cid) FILTER (WHERE f.f IN ('msg','fail'))::int AS handled`;

export interface GroupRow {
  key: string;
  newC: number;
  closed: number;
  resolved: number;
  frtMedian: number | null;
  frtP90: number | null;
  frtCount: number;
  resMedian: number | null;
  msgs: number;
  failed: number;
  /** Distinct conversations with a message counted in msgs or failed. */
  handled: number;
}

/** One grouped aggregate over `facts`, as a JSON array ordered by key. */
function groupedJson(accountId: string, group: MetricGroup | null, range: AnalyticsRange, where: Prisma.Sql): Prisma.Sql {
  const key = group ? keyExpr(group, range) : Prisma.sql`'all'`;
  return Prisma.sql`(SELECT COALESCE(json_agg(g ORDER BY g.key), '[]'::json) FROM (
    SELECT ${key} AS key, ${AGGREGATES}
    FROM facts f ${group === 'label' ? labelJoin(accountId) : Prisma.empty}
    WHERE true ${where} GROUP BY 1) g WHERE g.key IS NOT NULL)`;
}

/** Fills missing keys with zero rows, in `keys` order. */
export function fillRows(keys: string[], rows: GroupRow[]): GroupRow[] {
  const byKey = new Map(rows.map((r) => [r.key, r]));
  return keys.map((key) => byKey.get(key) ?? emptyRow(key));
}

export function emptyRow(key: string): GroupRow {
  return { key, newC: 0, closed: 0, resolved: 0, frtMedian: null, frtP90: null, frtCount: 0, resMedian: null, msgs: 0, failed: 0, handled: 0 };
}

/**
 * Metrics grouped one way (saved reports, and the by-channel and by-label
 * charts). `memberId` keeps only one member's facts; agent grouping and a
 * member filter credit first responses and messages to members.
 */
export async function groupedMetrics(tx: TenantTransaction, accountId: string, range: AnalyticsRange,
  group: MetricGroup, filters: InsightFilters = {}, memberId?: string | null): Promise<GroupRow[]> {
  assertFilters(filters);
  if (memberId != null && !UUID.test(memberId)) throw new AnalyticsInputError('Invalid member');
  const byMember = group === 'agent' || Boolean(memberId);
  const rows = await tx.$queryRaw<{ rows: GroupRow[] }[]>(Prisma.sql`
    WITH ${factsSql(accountId, range, filters, byMember)}
    SELECT ${groupedJson(accountId, group, range, Prisma.sql`${channelWhere(filters)} ${memberWhere(memberId)}`)} AS rows`);
  return rows[0]?.rows ?? [];
}

// ------------------------------------------------------------------ trends

export interface LabelCount {
  id: string;
  name: string;
  color: string | null;
  newC: number;
}

export interface TrendReport {
  bucket: TimeBucket;
  /** One row per bucket key (zero-filled). */
  points: GroupRow[];
  /** New conversations by local hour of day, 0-23. */
  hours: number[];
  /** Per channel, ignoring the channel filter (the split the filter is chosen from). */
  channels: GroupRow[];
  /** New conversations per conversation label, then "none" (id 'none'). */
  labels: LabelCount[];
  /** Resolved conversations by time taken: under 1h, 1-4h, 4-12h, 12-24h, over a day. */
  resolutionSpread: number[];
  totals: GroupRow;
}

/** Upper bounds (seconds) of the resolution-time buckets; the last is open. */
export const RESOLUTION_BUCKETS = [3_600, 14_400, 43_200, 86_400];

/** Everything the Overview and Conversations tabs chart, in one statement. */
export async function trendReport(tx: TenantTransaction, accountId: string, range: AnalyticsRange,
  filters: InsightFilters = {}): Promise<TrendReport> {
  assertFilters(filters);
  const bucket = timeBucket(range);
  const where = channelWhere(filters);
  const rows = await tx.$queryRaw<{ report: {
    points: GroupRow[]; hours: GroupRow[]; channels: GroupRow[]; labels: { key: string; newC: number }[];
    spread: { b: number; n: number }[]; totals: GroupRow[]; names: { id: string; name: string; color: string | null }[];
  } }[]>(Prisma.sql`
    WITH ${factsSql(accountId, range, filters, false)}
    SELECT json_build_object(
      'points', ${groupedJson(accountId, bucket, range, where)},
      'hours', ${groupedJson(accountId, 'hour_of_day', range, Prisma.sql`AND f.f='new' ${where}`)},
      'channels', ${groupedJson(accountId, 'channel', range, Prisma.empty)},
      'labels', ${groupedJson(accountId, 'label', range, Prisma.sql`AND f.f='new' ${where}`)},
      'spread', (SELECT COALESCE(json_agg(json_build_object('b', b, 'n', n)), '[]'::json) FROM (
        SELECT width_bucket(f.secs, ${RESOLUTION_BUCKETS}::float8[]) AS b, count(*)::int AS n
        FROM facts f WHERE f.f='res' AND f.secs IS NOT NULL ${where} GROUP BY 1) s),
      'totals', ${groupedJson(accountId, null, range, where)},
      'names', (SELECT COALESCE(json_agg(json_build_object('id', cl.id, 'name', cl.name, 'color', cl.color) ORDER BY cl.name, cl.id), '[]'::json)
        FROM conversation_labels cl WHERE cl.account_id=${accountId}::uuid)
    ) AS report`);
  const r = rows[0].report;
  const hours = Array.from({ length: 24 }, () => 0);
  for (const row of r.hours) hours[Number(row.key)] = row.newC;
  const spread = [0, 0, 0, 0, 0];
  for (const s of r.spread) spread[Math.min(4, Math.max(0, s.b))] += s.n;
  const labelCounts = new Map(r.labels.map((l) => [l.key, l.newC]));
  const labels: LabelCount[] = r.names.map((n) => ({ id: n.id, name: n.name, color: n.color, newC: labelCounts.get(n.id) ?? 0 }));
  labels.push({ id: 'none', name: '', color: null, newC: labelCounts.get('none') ?? 0 });
  return {
    bucket,
    points: fillRows(timeKeys(range), r.points),
    hours,
    channels: fillRows(['whatsapp', 'instagram'], r.channels),
    labels,
    resolutionSpread: spread,
    totals: r.totals[0] ?? emptyRow('all'),
  };
}

/** Outbound message totals for a range (the previous-period deltas of the trend tiles). */
export async function messageTotals(tx: TenantTransaction, accountId: string, range: AnalyticsRange,
  filters: InsightFilters = {}): Promise<{ msgs: number; failed: number }> {
  assertFilters(filters);
  const rows = await tx.$queryRaw<{ msgs: number; failed: number }[]>(Prisma.sql`
    SELECT count(*) FILTER (WHERE m.status <> 'failed')::int AS msgs, count(*) FILTER (WHERE m.status='failed')::int AS failed
    FROM messages m JOIN conversations c ON c.account_id=m.account_id AND c.id=m.conversation_id
    WHERE m.account_id=${accountId}::uuid AND m.created_at >= ${from(range)} AND m.created_at < ${to(range)}
      AND m.sender_type IN ('agent','bot') AND m.content_type <> 'system'
      ${filters.channel ? Prisma.sql`AND COALESCE(c.channel, 'whatsapp')=${filters.channel}` : Prisma.empty}
      ${filters.whatsappConfigId ? Prisma.sql`AND c.whatsapp_config_id=${filters.whatsappConfigId}::uuid` : Prisma.empty}`);
  return rows[0] ?? { msgs: 0, failed: 0 };
}

// ------------------------------------------------------------------ needs attention

/** Counts are capped so a huge backlog stays one bounded scan; the UI shows "999+". */
export const ATTENTION_CAP = 999;
/** A WhatsApp reply window "closes soon" inside its last two hours (the inbox's Expiring soon filter). */
const CLOSING_SOON = Prisma.sql`interval '2 hours'`;
const WINDOW = Prisma.sql`interval '24 hours'`;

export interface AttentionCounts {
  /** Open conversations nobody owns (the inbox's Unassigned filter). */
  unowned: number;
  /** Conversations with unread customer messages (Unread). */
  unread: number;
  /** WhatsApp chats waiting on a reply whose 24-hour window closes within two hours (Expiring soon). */
  closingSoon: number;
  /** WhatsApp chats waiting on a reply whose window has closed: a template is needed. */
  needsTemplate: number;
  /** Agent and bot messages that failed since local midnight. */
  failedToday: number;
  /** Rules and flows that ran before and are now switched off (names of the first three). */
  switchedOff: number;
  switchedOffNames: string[];
}

/**
 * What needs someone now, for the Overview's "Needs attention" card. Live
 * state, not a range. A conversation "waits" when its last customer message is
 * later than its last reply (the inbox's definition).
 */
export async function attentionCounts(tx: TenantTransaction, accountId: string, timezone: string,
  filters: InsightFilters = {}): Promise<AttentionCounts> {
  assertFilters(filters);
  const scope = Prisma.sql`c.account_id=${accountId}::uuid AND c.status <> 'closed'
    ${filters.channel ? Prisma.sql`AND COALESCE(c.channel, 'whatsapp')=${filters.channel}` : Prisma.empty}
    ${filters.whatsappConfigId ? Prisma.sql`AND c.whatsapp_config_id=${filters.whatsappConfigId}::uuid` : Prisma.empty}`;
  const capped = (sql: Prisma.Sql) => Prisma.sql`(SELECT count(*)::int FROM (${sql} LIMIT ${ATTENTION_CAP + 1}) x)`;
  const lastCustomer = Prisma.sql`(SELECT max(cm.created_at) FROM messages cm WHERE cm.account_id=c.account_id AND cm.conversation_id=c.id AND cm.sender_type='customer')`;
  const lastReply = Prisma.sql`(SELECT max(rm.created_at) FROM messages rm WHERE rm.account_id=c.account_id AND rm.conversation_id=c.id
    AND rm.sender_type IN ('agent','bot') AND rm.status IN ('sent','delivered','read') AND rm.content_type NOT IN ('template','system'))`;
  const waiting = (window: Prisma.Sql) => Prisma.sql`SELECT 1 FROM (
      SELECT ${lastCustomer} AS customer_at, ${lastReply} AS reply_at FROM conversations c
      WHERE ${scope} AND COALESCE(c.channel, 'whatsapp')='whatsapp' AND ${window}) w
    WHERE w.customer_at IS NOT NULL AND (w.reply_at IS NULL OR w.customer_at > w.reply_at)`;
  const automationChannel = filters.channel ? Prisma.sql`AND a.channel=${filters.channel}` : Prisma.empty;
  const flowChannel = filters.channel ? Prisma.sql`AND f.channel_scope IN (${filters.channel}, 'any')` : Prisma.empty;
  const rows = await tx.$queryRaw<{ counts: AttentionCounts }[]>(Prisma.sql`
    WITH today AS (SELECT (date_trunc('day', now() AT TIME ZONE ${timezone}) AT TIME ZONE ${timezone}) AS start),
    off AS (
      SELECT a.name, a.last_executed_at FROM automations a WHERE a.account_id=${accountId}::uuid AND NOT a.is_active
        AND a.archived_at IS NULL AND a.execution_count > 0 ${automationChannel}
      UNION ALL
      SELECT f.name, f.last_executed_at FROM flows f WHERE f.account_id=${accountId}::uuid AND f.status='paused'
        AND f.archived_at IS NULL AND f.execution_count > 0 ${flowChannel}
    )
    SELECT json_build_object(
      'unowned', ${capped(Prisma.sql`SELECT 1 FROM conversations c WHERE ${scope} AND c.assigned_agent_id IS NULL`)},
      'unread', ${capped(Prisma.sql`SELECT 1 FROM conversations c WHERE c.account_id=${accountId}::uuid AND c.unread_count > 0
        ${filters.channel ? Prisma.sql`AND COALESCE(c.channel, 'whatsapp')=${filters.channel}` : Prisma.empty}
        ${filters.whatsappConfigId ? Prisma.sql`AND c.whatsapp_config_id=${filters.whatsappConfigId}::uuid` : Prisma.empty}`)},
      -- last_message_at bounds the scan; the subqueries confirm who spoke last.
      'closingSoon', ${capped(waiting(Prisma.sql`c.last_message_at > now() - ${WINDOW}
        AND ${lastCustomer} > now() - ${WINDOW} AND ${lastCustomer} <= now() - ${WINDOW} + ${CLOSING_SOON}`))},
      'needsTemplate', ${capped(waiting(Prisma.sql`c.last_message_at <= now() - ${WINDOW} AND c.last_message_at > now() - interval '30 days'`))},
      'failedToday', ${capped(Prisma.sql`SELECT 1 FROM messages m JOIN conversations c ON c.account_id=m.account_id AND c.id=m.conversation_id
        WHERE m.account_id=${accountId}::uuid AND m.created_at >= (SELECT start FROM today) AND m.status='failed'
          AND m.sender_type IN ('agent','bot')
          ${filters.channel ? Prisma.sql`AND COALESCE(c.channel, 'whatsapp')=${filters.channel}` : Prisma.empty}
          ${filters.whatsappConfigId ? Prisma.sql`AND c.whatsapp_config_id=${filters.whatsappConfigId}::uuid` : Prisma.empty}`)},
      'switchedOff', (SELECT count(*)::int FROM off),
      'switchedOffNames', (SELECT COALESCE(json_agg(name), '[]'::json) FROM (
        SELECT name FROM off ORDER BY last_executed_at DESC NULLS LAST, name LIMIT 3) n)
    ) AS counts`);
  return rows[0].counts;
}

// ------------------------------------------------------------------ team

export type Presence = 'online' | 'away' | 'offline';

export interface TeamMemberRow extends Omit<GroupRow, 'key'> {
  userId: string;
  name: string | null;
  role: string;
  presence: Presence;
}

/** Seconds since the last heartbeat after which a member reads as offline (src/lib/presence.ts OFFLINE_AFTER_MS). */
const ONLINE_WITHIN_SECONDS = 75;

/**
 * Every member of the workspace with their figures for the range (zeros when
 * idle) and live presence. Name, role and presence only; no email.
 */
export async function teamStats(tx: TenantTransaction, accountId: string, range: AnalyticsRange,
  filters: InsightFilters = {}): Promise<TeamMemberRow[]> {
  const rows = await groupedMetrics(tx, accountId, range, 'agent', filters);
  const members = await tx.$queryRaw<{ userId: string; name: string | null; role: string; presence: Presence }[]>(Prisma.sql`
    SELECT am.user_id::text AS "userId", p.full_name AS name, am.role,
      CASE WHEN mp.last_seen_at > now() - make_interval(secs => ${ONLINE_WITHIN_SECONDS}) THEN mp.status ELSE 'offline' END AS presence
    FROM account_memberships am
    LEFT JOIN profiles p ON p.user_id=am.user_id
    LEFT JOIN member_presence mp ON mp.account_id=am.account_id AND mp.user_id=am.user_id
    WHERE am.account_id=${accountId}::uuid
    ORDER BY p.full_name NULLS LAST, am.user_id`);
  const byMember = new Map(rows.map((r) => [r.key.toLowerCase(), r]));
  return members.map((m) => {
    const { key: _key, ...stats } = byMember.get(m.userId.toLowerCase()) ?? emptyRow(m.userId);
    void _key;
    return { ...m, presence: m.presence === 'online' || m.presence === 'away' ? m.presence : 'offline', ...stats };
  });
}

export interface MemberDetail {
  bucket: TimeBucket;
  points: GroupRow[];
  channels: GroupRow[];
  totals: GroupRow;
}

/** One member's figures over time and by channel. 404-style null when they are not a member. */
export async function memberDetail(tx: TenantTransaction, accountId: string, range: AnalyticsRange, memberId: string,
  filters: InsightFilters = {}): Promise<MemberDetail | null> {
  assertFilters(filters);
  if (!UUID.test(memberId)) throw new AnalyticsInputError('Invalid member');
  const member = await tx.$queryRaw<{ ok: number }[]>`SELECT 1 AS ok FROM account_memberships
    WHERE account_id=${accountId}::uuid AND user_id=${memberId}::uuid`;
  if (!member[0]) return null;
  const bucket = timeBucket(range);
  const where = Prisma.sql`${channelWhere(filters)} ${memberWhere(memberId)}`;
  const rows = await tx.$queryRaw<{ detail: { points: GroupRow[]; channels: GroupRow[]; totals: GroupRow[] } }[]>(Prisma.sql`
    WITH ${factsSql(accountId, range, filters, true)}
    SELECT json_build_object(
      'points', ${groupedJson(accountId, bucket, range, where)},
      'channels', ${groupedJson(accountId, 'channel', range, where)},
      'totals', ${groupedJson(accountId, null, range, where)}
    ) AS detail`);
  const d = rows[0].detail;
  return {
    bucket,
    points: fillRows(timeKeys(range), d.points),
    channels: filters.channel ? fillRows([filters.channel], d.channels) : fillRows(['whatsapp', 'instagram'], d.channels),
    totals: d.totals[0] ?? emptyRow('all'),
  };
}

// ------------------------------------------------------------------ automations

export type AutomationKind = 'flow' | 'rule' | 'sequence';

export interface AutomationRunRow {
  id: string;
  name: string;
  kind: AutomationKind;
  /** 'whatsapp' | 'instagram', or 'any' for a flow on both channels. */
  channel: string;
  live: boolean;
  runs: number;
  /** Runs where a tracked link or button was tapped, of runs that showed one (flows only); null without any. */
  clickRate: number | null;
}

export interface AutomationStats {
  /** The busiest automations (at most AUTOMATION_LIMIT), most runs first. */
  top: AutomationRunRow[];
  /** Runs by kind across every automation, not only `top`. */
  byKind: Record<AutomationKind, number>;
  total: number;
}

export const AUTOMATION_LIMIT = 50;

/**
 * Automation runs in the range: flow runs started, rule executions logged
 * (automation_logs) and sequence messages sent. Channel-filtered by the
 * automation's own channel (a flow for 'any' channel counts on both).
 */
export async function automationStats(tx: TenantTransaction, accountId: string, range: AnalyticsRange,
  filters: InsightFilters = {}): Promise<AutomationStats> {
  assertFilters(filters);
  const channel = filters.channel ? Prisma.sql`WHERE x.channel IN (${filters.channel}, 'any')` : Prisma.empty;
  const rows = await tx.$queryRaw<{ stats: { top: AutomationRunRow[]; kinds: { kind: AutomationKind; runs: number }[] } }[]>(Prisma.sql`
    WITH runs_in AS (
      SELECT r.id, r.flow_id FROM flow_runs r
      WHERE r.account_id=${accountId}::uuid AND r.started_at >= ${from(range)} AND r.started_at < ${to(range)}
    ), link_runs AS (
      SELECT l.flow_run_id, bool_or(l.first_clicked_at IS NOT NULL) AS clicked FROM flow_tracked_links l
      WHERE l.account_id=${accountId}::uuid AND l.flow_run_id IN (SELECT id FROM runs_in) GROUP BY l.flow_run_id
    ), flow_agg AS (
      SELECT ri.flow_id AS id, count(*)::int AS runs, count(lr.flow_run_id)::int AS shown, count(*) FILTER (WHERE lr.clicked)::int AS clicked
      FROM runs_in ri LEFT JOIN link_runs lr ON lr.flow_run_id=ri.id GROUP BY ri.flow_id
    ), rule_agg AS (
      SELECT automation_id AS id, count(*)::int AS runs FROM automation_logs
      WHERE account_id=${accountId}::uuid AND created_at >= ${from(range)} AND created_at < ${to(range)} GROUP BY automation_id
    ), seq_agg AS (
      SELECT sequence_id AS id, count(*)::int AS runs FROM sequence_message_sends
      WHERE account_id=${accountId}::uuid AND created_at >= ${from(range)} AND created_at < ${to(range)} AND status='sent'
      GROUP BY sequence_id
    ), x AS (
      SELECT f.id, f.name, 'flow'::text AS kind, f.channel_scope AS channel, f.status='active' AS live, a.runs,
        CASE WHEN a.shown > 0 THEN round(a.clicked * 100.0 / a.shown)::int END AS "clickRate"
      FROM flow_agg a JOIN flows f ON f.account_id=${accountId}::uuid AND f.id=a.id
      UNION ALL
      SELECT au.id, au.name, 'rule', au.channel, au.is_active, r.runs, NULL::int
      FROM rule_agg r JOIN automations au ON au.account_id=${accountId}::uuid AND au.id=r.id
      UNION ALL
      SELECT s.id, s.name, 'sequence', s.channel, s.status='active', q.runs, NULL::int
      FROM seq_agg q JOIN sequences s ON s.account_id=${accountId}::uuid AND s.id=q.id
    ), filtered AS (SELECT * FROM x ${channel})
    SELECT json_build_object(
      'top', (SELECT COALESCE(json_agg(t), '[]'::json) FROM (
        SELECT * FROM filtered ORDER BY runs DESC, name, id LIMIT ${AUTOMATION_LIMIT}) t),
      'kinds', (SELECT COALESCE(json_agg(k), '[]'::json) FROM (
        SELECT kind, sum(runs)::int AS runs FROM filtered GROUP BY kind) k)
    ) AS stats`);
  const s = rows[0].stats;
  const byKind: Record<AutomationKind, number> = { flow: 0, rule: 0, sequence: 0 };
  for (const k of s.kinds) byKind[k.kind] = k.runs;
  return { top: s.top, byKind, total: byKind.flow + byKind.rule + byKind.sequence };
}
