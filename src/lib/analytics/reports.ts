// Downloadable analytics reports (CSV).
//
// Flow: an admin or owner requests a report (requestReport). The report_runs
// row and its 'analytics.report' job commit in one transaction before the
// request is acknowledged. The worker (runReportJob) builds the CSV, stores it
// privately (report-storage.ts), marks the row ready and, when asked, emails
// the requester a link to the download route, which requires sign-in. Every
// download is audit-logged (openReportDownload). Reports expire 30 days after
// the request; the hourly 'analytics.report_sweep' deletes the file and marks
// the row expired, and fails requests stuck for six hours.
//
// Contents are counts, durations, campaign/template names and member names
// only: never message text, contact names or phone numbers. Files are capped at
// MAX_REPORT_ROWS rows (the row is flagged `truncated`). Cells are
// formula-safe and the file starts with a UTF-8 BOM so Excel reads it as UTF-8.
//
// Definitions follow queries.ts: a reply is an agent or bot message that did
// not fail and is not a template/system message; a campaign reply is a
// customer message within 72 hours after the campaign message; clicks are
// unique per recipient. Campaign reports cover campaigns scheduled (or, when
// unscheduled, created) in the range. In the day-wise report a recipient
// counts on the local day it was sent, or, if it was never sent (failed before
// sending), the day it was queued. Agent attribution is messages.sender_id when
// stamped, else (only for rows before AGENT_ATTRIBUTION_CUTOFF) the
// conversation's current assignee; later rows without a sender (public API)
// are not credited to anyone.

import { Prisma } from '@prisma/client';
import { authEmailTransport } from '@/lib/auth/email';
import { hasMinRole, type AccountRole } from '@/lib/auth/roles';
import { csvCell } from '@/lib/audience/export';
import { getWorkerPrisma } from '@/lib/db/prisma';
import { withTenant, type TenantTransaction } from '@/lib/db/tenant';
import { getT } from '@/lib/i18n/translate';
import { dispatchOnce, UncertainDispatchError } from '@/lib/jobs/dispatch';
import { AGENT_ATTRIBUTION_CUTOFF } from './queries';
import { parseRange, workspaceTimezone, type AnalyticsRange, type RangeInput } from './range';
import { deleteReportFile, putReportFile, reportObjectKey } from './report-storage';

export const REPORT_KINDS = ['campaign_daily', 'campaign_summary', 'member_campaigns', 'agent_performance'] as const;
export type ReportKind = (typeof REPORT_KINDS)[number];
export type ReportStatus = 'queued' | 'running' | 'ready' | 'failed' | 'expired';

export const REPORT_JOB = 'analytics.report';
export const REPORT_SWEEP_JOB = 'analytics.report_sweep';
export const MAX_REPORT_ROWS = 100_000;
/** Queued or running requests a workspace may have at once. */
export const MAX_PENDING_REPORTS = 5;
export const REPORT_LIST_LIMIT = 50;
export const REPORT_SWEEP_INTERVAL_MS = 60 * 60_000;
/** A heavy report must finish inside withTenant's 30 s transaction. */
const REPORT_STATEMENT_TIMEOUT_MS = 25_000;
const REPLY_LOOKAHEAD = Prisma.sql`interval '7 days'`;
const REPLY_WINDOW = Prisma.sql`interval '72 hours'`;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const ADDRESS = /^[^\s@<>",;]{1,64}@[^\s@<>",;]{1,255}$/;

export class ReportError extends Error {
  constructor(public readonly code: 'invalid_kind' | 'too_many_pending' | 'not_found' | 'not_ready', public readonly status: number) {
    super(code);
    this.name = 'ReportError';
  }
}

export function isReportKind(value: unknown): value is ReportKind {
  return typeof value === 'string' && (REPORT_KINDS as readonly string[]).includes(value);
}

export interface ReportParams {
  from: string;
  to: string;
  timezone: string;
}

export interface ReportRun {
  id: string;
  kind: ReportKind;
  status: ReportStatus;
  params: ReportParams;
  requestedBy: { userId: string; name: string | null } | null;
  emailRequested: boolean;
  rowCount: number | null;
  truncated: boolean;
  byteSize: number | null;
  error: string | null;
  createdAt: string;
  finishedAt: string | null;
  expiresAt: string;
}

// ------------------------------------------------------------------ CSV

export interface CsvColumn<R> {
  header: string;
  value: (row: R) => unknown;
}

/** UTF-8 BOM, CRLF lines, every cell quoted and formula-neutralised. */
export function toCsv<R>(columns: CsvColumn<R>[], rows: R[]): Uint8Array {
  const lines = [columns.map((c) => csvCell(c.header)).join(',')];
  for (const row of rows) lines.push(columns.map((c) => csvCell(c.value(row))).join(','));
  return new TextEncoder().encode(`﻿${lines.join('\r\n')}\r\n`);
}

/** Percentage with one decimal, or empty when there is no base. */
export function rate(part: number, whole: number): string {
  return whole > 0 ? (Math.round((part / whole) * 1000) / 10).toFixed(1) : '';
}

// ------------------------------------------------------------------ SQL

const from = (range: AnalyticsRange) => Prisma.sql`${range.from.toISOString()}::timestamptz`;
const to = (range: AnalyticsRange) => Prisma.sql`${range.to.toISOString()}::timestamptz`;
const localDay = (expr: string, range: AnalyticsRange) =>
  Prisma.sql`to_char(${Prisma.raw(expr)} AT TIME ZONE ${range.timezone}, 'YYYY-MM-DD')`;
const localTime = (expr: string, range: AnalyticsRange) =>
  Prisma.sql`to_char(${Prisma.raw(expr)} AT TIME ZONE ${range.timezone}, 'YYYY-MM-DD HH24:MI')`;
const isReply = (m: string) => Prisma.raw(
  `${m}.sender_type IN ('agent','bot') AND ${m}.status <> 'failed' AND ${m}.content_type NOT IN ('template','system')`);
const memberName = (expr: string) => Prisma.raw(`(SELECT p.full_name FROM profiles p WHERE p.user_id=${expr} LIMIT 1)`);
const limit = Prisma.sql`LIMIT ${MAX_REPORT_ROWS + 1}`;

/** Campaigns in the range (b) and one row per recipient with its reply flag (r). */
function campaignCtes(accountId: string, range: AnalyticsRange) {
  return Prisma.sql`
    b AS (
      SELECT id, name, template_name, status, user_id, created_at, scheduled_at FROM broadcasts
      WHERE account_id=${accountId}::uuid
        AND COALESCE(scheduled_at, created_at) >= ${from(range)} AND COALESCE(scheduled_at, created_at) < ${to(range)}
    ), r AS (
      SELECT r.broadcast_id, r.status, r.sent_at, r.delivered_at, r.read_at, r.clicked_at,
        COALESCE(r.sent_at, r.created_at) AS at,
        r.contact_id IS NOT NULL AND COALESCE(r.sent_at, r.delivered_at) IS NOT NULL AND EXISTS (
          SELECT 1 FROM conversations c JOIN messages m ON m.account_id=c.account_id AND m.conversation_id=c.id
          WHERE c.account_id=${accountId}::uuid AND c.contact_id=r.contact_id AND m.sender_type='customer'
            AND m.created_at >= COALESCE(r.sent_at, r.delivered_at)
            AND m.created_at <= COALESCE(r.delivered_at, r.sent_at) + ${REPLY_WINDOW}) AS replied
      FROM broadcast_recipients r JOIN b ON b.id=r.broadcast_id WHERE r.account_id=${accountId}::uuid
    )`;
}

// count(r.broadcast_id): a campaign without recipients LEFT JOINs one NULL row.
const funnel = Prisma.raw(`
  count(r.broadcast_id)::int AS recipients,
  count(*) FILTER (WHERE r.sent_at IS NOT NULL OR r.status IN ('sent','delivered','read','replied'))::int AS sent,
  count(*) FILTER (WHERE r.delivered_at IS NOT NULL OR r.status IN ('delivered','read','replied'))::int AS delivered,
  count(*) FILTER (WHERE r.read_at IS NOT NULL OR r.status IN ('read','replied'))::int AS read,
  count(*) FILTER (WHERE r.replied)::int AS replied,
  count(*) FILTER (WHERE r.clicked_at IS NOT NULL)::int AS clicked,
  count(*) FILTER (WHERE r.status='failed')::int AS failed`);

export interface FunnelRow {
  recipients: number;
  sent: number;
  delivered: number;
  read: number;
  replied: number;
  clicked: number;
  failed: number;
}

export interface CampaignDailyRow extends FunnelRow {
  day: string;
  campaignId: string;
  campaign: string;
  template: string;
}

export function campaignDailyRows(tx: TenantTransaction, accountId: string, range: AnalyticsRange): Promise<CampaignDailyRow[]> {
  return tx.$queryRaw<CampaignDailyRow[]>(Prisma.sql`
    WITH ${campaignCtes(accountId, range)}
    SELECT ${localDay('r.at', range)} AS day, b.id::text AS "campaignId", b.name AS campaign, b.template_name AS template, ${funnel}
    FROM r JOIN b ON b.id=r.broadcast_id
    GROUP BY 1, b.id, b.name, b.template_name
    ORDER BY 1, b.name, b.id ${limit}`);
}

export interface CampaignSummaryRow extends FunnelRow {
  campaignId: string;
  campaign: string;
  template: string;
  status: string;
  createdBy: string | null;
  createdAt: string;
  scheduledAt: string | null;
}

export function campaignSummaryRows(tx: TenantTransaction, accountId: string, range: AnalyticsRange): Promise<CampaignSummaryRow[]> {
  return tx.$queryRaw<CampaignSummaryRow[]>(Prisma.sql`
    WITH ${campaignCtes(accountId, range)}
    SELECT b.id::text AS "campaignId", b.name AS campaign, b.template_name AS template, b.status,
      ${memberName('b.user_id')} AS "createdBy",
      ${localTime('b.created_at', range)} AS "createdAt", ${localTime('b.scheduled_at', range)} AS "scheduledAt", ${funnel}
    FROM b LEFT JOIN r ON r.broadcast_id=b.id
    GROUP BY b.id, b.name, b.template_name, b.status, b.user_id, b.created_at, b.scheduled_at
    ORDER BY COALESCE(b.scheduled_at, b.created_at), b.id ${limit}`);
}

export interface MemberCampaignRow extends FunnelRow {
  userId: string;
  name: string | null;
  role: string | null;
  campaigns: number;
}

/** Every current member (zeros when idle) plus former members who created campaigns in the range. */
export function memberCampaignRows(tx: TenantTransaction, accountId: string, range: AnalyticsRange): Promise<MemberCampaignRow[]> {
  return tx.$queryRaw<MemberCampaignRow[]>(Prisma.sql`
    WITH ${campaignCtes(accountId, range)},
    per AS (
      SELECT b.user_id, count(DISTINCT b.id)::int AS campaigns, ${funnel}
      FROM b LEFT JOIN r ON r.broadcast_id=b.id GROUP BY b.user_id
    ), k AS (
      SELECT user_id FROM account_memberships WHERE account_id=${accountId}::uuid
      UNION SELECT user_id FROM per
    )
    SELECT k.user_id::text AS "userId", ${memberName('k.user_id')} AS name,
      (SELECT am.role FROM account_memberships am WHERE am.account_id=${accountId}::uuid AND am.user_id=k.user_id) AS role,
      COALESCE(per.campaigns, 0) AS campaigns, COALESCE(per.recipients, 0) AS recipients, COALESCE(per.sent, 0) AS sent,
      COALESCE(per.delivered, 0) AS delivered, COALESCE(per.read, 0) AS read, COALESCE(per.replied, 0) AS replied,
      COALESCE(per.clicked, 0) AS clicked, COALESCE(per.failed, 0) AS failed
    FROM k LEFT JOIN per ON per.user_id=k.user_id
    ORDER BY COALESCE(per.campaigns, 0) DESC, name NULLS LAST, k.user_id ${limit}`);
}

export interface AgentDayRow {
  day: string;
  userId: string;
  name: string | null;
  role: string | null;
  conversationsHandled: number;
  repliesSent: number;
  firstResponses: number;
  medianFirstResponseSeconds: number | null;
  resolved: number;
}

/**
 * Per agent per local day with any activity: conversations replied in,
 * replies, first responses (each conversation's first customer wait in the
 * range answered by an agent before the range end, counted on the wait's day)
 * with their median, and conversations resolved while assigned to the agent.
 */
export function agentDayRows(tx: TenantTransaction, accountId: string, range: AnalyticsRange): Promise<AgentDayRow[]> {
  return tx.$queryRaw<AgentDayRow[]>(Prisma.sql`
    WITH msgs AS (
      SELECT m.conversation_id, m.created_at, m.sender_type, m.sender_id,
        count(*) FILTER (WHERE m.sender_type <> 'customer')
          OVER (PARTITION BY m.conversation_id ORDER BY m.created_at, m.arrival_sequence) AS seg
      FROM messages m
      WHERE m.account_id=${accountId}::uuid AND m.created_at >= ${from(range)} AND m.created_at < ${to(range)} + ${REPLY_LOOKAHEAD}
        AND (m.sender_type='customer' OR (${isReply('m')}))
    ), waits AS (
      SELECT conversation_id, seg, min(created_at) AS wait_at FROM msgs
      WHERE sender_type='customer' AND created_at < ${to(range)} GROUP BY conversation_id, seg
    ), answers AS (
      SELECT DISTINCT ON (conversation_id, seg) conversation_id, seg, created_at AS reply_at, sender_type, sender_id
      FROM msgs WHERE sender_type <> 'customer' ORDER BY conversation_id, seg, created_at
    ), first_waits AS (
      SELECT DISTINCT ON (w.conversation_id) w.conversation_id, w.wait_at, a.reply_at, a.sender_type, a.sender_id
      FROM waits w LEFT JOIN answers a ON a.conversation_id=w.conversation_id AND a.seg=w.seg+1
      ORDER BY w.conversation_id, w.wait_at
    ), fr AS (
      SELECT COALESCE(f.sender_id, CASE WHEN f.reply_at < ${AGENT_ATTRIBUTION_CUTOFF}::timestamptz THEN c.assigned_agent_id END) AS agent_id,
        ${localDay('f.wait_at', range)} AS day,
        extract(epoch FROM (f.reply_at - f.wait_at)) AS secs
      FROM first_waits f JOIN conversations c ON c.account_id=${accountId}::uuid AND c.id=f.conversation_id
      WHERE f.sender_type='agent' AND f.reply_at < ${to(range)}
    ), fr_t AS (
      SELECT agent_id, day, count(*)::int AS n,
        round((percentile_cont(0.5) WITHIN GROUP (ORDER BY secs))::numeric)::int AS median
      FROM fr WHERE agent_id IS NOT NULL GROUP BY agent_id, day
    ), rep AS (
      SELECT COALESCE(m.sender_id, CASE WHEN m.created_at < ${AGENT_ATTRIBUTION_CUTOFF}::timestamptz THEN c.assigned_agent_id END) AS agent_id,
        ${localDay('m.created_at', range)} AS day,
        count(*)::int AS replies, count(DISTINCT m.conversation_id)::int AS handled
      FROM messages m JOIN conversations c ON c.account_id=m.account_id AND c.id=m.conversation_id
      WHERE m.account_id=${accountId}::uuid AND m.created_at >= ${from(range)} AND m.created_at < ${to(range)}
        AND m.sender_type='agent' AND (${isReply('m')})
      GROUP BY 1, 2
    ), res AS (
      SELECT assigned_agent_id AS agent_id, ${localDay('resolved_at', range)} AS day, count(*)::int AS resolved
      FROM conversations
      WHERE account_id=${accountId}::uuid AND resolved_at >= ${from(range)} AND resolved_at < ${to(range)}
        AND assigned_agent_id IS NOT NULL
      GROUP BY 1, 2
    ), k AS (
      SELECT agent_id, day FROM rep UNION SELECT agent_id, day FROM fr_t UNION SELECT agent_id, day FROM res
    )
    SELECT k.day, k.agent_id::text AS "userId", ${memberName('k.agent_id')} AS name,
      (SELECT am.role FROM account_memberships am WHERE am.account_id=${accountId}::uuid AND am.user_id=k.agent_id) AS role,
      COALESCE(rep.handled, 0) AS "conversationsHandled", COALESCE(rep.replies, 0) AS "repliesSent",
      COALESCE(fr_t.n, 0) AS "firstResponses", fr_t.median AS "medianFirstResponseSeconds", COALESCE(res.resolved, 0) AS resolved
    FROM k
    LEFT JOIN rep ON rep.agent_id=k.agent_id AND rep.day=k.day
    LEFT JOIN fr_t ON fr_t.agent_id=k.agent_id AND fr_t.day=k.day
    LEFT JOIN res ON res.agent_id=k.agent_id AND res.day=k.day
    WHERE k.agent_id IS NOT NULL
    ORDER BY k.day, name NULLS LAST, k.agent_id ${limit}`);
}

// ------------------------------------------------------------------ report builders

const FUNNEL_COLUMNS: CsvColumn<FunnelRow>[] = [
  { header: 'recipients', value: (r) => r.recipients },
  { header: 'sent', value: (r) => r.sent },
  { header: 'delivered', value: (r) => r.delivered },
  { header: 'read', value: (r) => r.read },
  { header: 'replied', value: (r) => r.replied },
  { header: 'clicked', value: (r) => r.clicked },
  { header: 'failed', value: (r) => r.failed },
];
const RATE_COLUMNS: CsvColumn<FunnelRow>[] = [
  { header: 'delivery_rate_pct', value: (r) => rate(r.delivered, r.sent) },
  { header: 'read_rate_pct', value: (r) => rate(r.read, r.delivered) },
  { header: 'reply_rate_pct', value: (r) => rate(r.replied, r.delivered) },
  { header: 'click_rate_pct', value: (r) => rate(r.clicked, r.delivered) },
];

export interface BuiltReport {
  bytes: Uint8Array;
  rowCount: number;
  truncated: boolean;
}

function finish<R>(columns: CsvColumn<R>[], rows: R[]): BuiltReport {
  const truncated = rows.length > MAX_REPORT_ROWS;
  const kept = truncated ? rows.slice(0, MAX_REPORT_ROWS) : rows;
  return { bytes: toCsv(columns, kept), rowCount: kept.length, truncated };
}

/** Runs one report's query and renders its CSV. Times are local to range.timezone. */
export async function buildReport(tx: TenantTransaction, accountId: string, kind: ReportKind, range: AnalyticsRange): Promise<BuiltReport> {
  const tz = range.timezone;
  if (kind === 'campaign_daily')
    return finish<CampaignDailyRow>([
      { header: `day (${tz})`, value: (r) => r.day },
      { header: 'campaign_id', value: (r) => r.campaignId },
      { header: 'campaign', value: (r) => r.campaign },
      { header: 'template', value: (r) => r.template },
      ...FUNNEL_COLUMNS,
    ], await campaignDailyRows(tx, accountId, range));
  if (kind === 'campaign_summary')
    return finish<CampaignSummaryRow>([
      { header: 'campaign_id', value: (r) => r.campaignId },
      { header: 'campaign', value: (r) => r.campaign },
      { header: 'template', value: (r) => r.template },
      { header: 'status', value: (r) => r.status },
      { header: 'created_by', value: (r) => r.createdBy },
      { header: `created_at (${tz})`, value: (r) => r.createdAt },
      { header: `scheduled_at (${tz})`, value: (r) => r.scheduledAt },
      ...FUNNEL_COLUMNS,
      ...RATE_COLUMNS,
    ], await campaignSummaryRows(tx, accountId, range));
  if (kind === 'member_campaigns')
    return finish<MemberCampaignRow>([
      { header: 'member_id', value: (r) => r.userId },
      { header: 'member', value: (r) => r.name },
      { header: 'role', value: (r) => r.role ?? 'former member' },
      { header: 'campaigns', value: (r) => r.campaigns },
      ...FUNNEL_COLUMNS,
      ...RATE_COLUMNS,
    ], await memberCampaignRows(tx, accountId, range));
  return finish<AgentDayRow>([
    { header: `day (${tz})`, value: (r) => r.day },
    { header: 'agent_id', value: (r) => r.userId },
    { header: 'agent', value: (r) => r.name },
    { header: 'role', value: (r) => r.role ?? 'former member' },
    { header: 'conversations_handled', value: (r) => r.conversationsHandled },
    { header: 'replies_sent', value: (r) => r.repliesSent },
    { header: 'first_responses', value: (r) => r.firstResponses },
    { header: 'median_first_response_seconds', value: (r) => r.medianFirstResponseSeconds },
    { header: 'resolved', value: (r) => r.resolved },
  ], await agentDayRows(tx, accountId, range));
}

// ------------------------------------------------------------------ requests (app role)

export interface ReportActor {
  accountId: string;
  userId: string;
  role: AccountRole;
}

type RunRow = {
  id: string; kind: ReportKind; status: ReportStatus; params: ReportParams; requested_by: string | null;
  requester_name: string | null; email_requested: boolean; row_count: number | null; truncated: boolean;
  byte_size: bigint | number | null; error: string | null; created_at: Date; finished_at: Date | null; expires_at: Date;
};

const RUN_COLUMNS = Prisma.sql`r.id::text AS id, r.kind, r.status, r.params, r.requested_by::text AS requested_by,
  (SELECT p.full_name FROM profiles p WHERE p.user_id=r.requested_by LIMIT 1) AS requester_name,
  r.email_requested, r.row_count, r.truncated, r.byte_size, r.error, r.created_at, r.finished_at, r.expires_at`;

function toRun(row: RunRow): ReportRun {
  return {
    id: row.id, kind: row.kind, status: row.status, params: row.params,
    requestedBy: row.requested_by ? { userId: row.requested_by, name: row.requester_name } : null,
    emailRequested: row.email_requested, rowCount: row.row_count, truncated: row.truncated,
    byteSize: row.byte_size == null ? null : Number(row.byte_size), error: row.error,
    createdAt: row.created_at.toISOString(), finishedAt: row.finished_at?.toISOString() ?? null,
    expiresAt: row.expires_at.toISOString(),
  };
}

function assertAdmin(actor: ReportActor): void {
  if (!hasMinRole(actor.role, 'admin')) throw new ReportError('not_found', 404);
}

const audit = (tx: TenantTransaction, actor: ReportActor, action: string, reportId: string, metadata: Record<string, unknown>) =>
  tx.$executeRaw`INSERT INTO audit_logs(account_id,user_id,action,resource_id,metadata)
    VALUES(${actor.accountId}::uuid,${actor.userId}::uuid,${action},${reportId},${JSON.stringify(metadata)}::jsonb)`;

/**
 * Records a request and queues its job in one transaction. The range is
 * resolved now, in the workspace timezone, so the file covers exactly the days
 * shown when it was requested. Throws AnalyticsRangeError or ReportError.
 */
export async function requestReport(actor: ReportActor, input: { kind: unknown; range: RangeInput; email?: boolean }): Promise<ReportRun> {
  assertAdmin(actor);
  if (!isReportKind(input.kind)) throw new ReportError('invalid_kind', 400);
  const kind = input.kind;
  return withTenant(actor, async (tx) => {
    const timezone = await workspaceTimezone(tx, actor.accountId);
    const range = parseRange(input.range, timezone);
    const params: ReportParams = { from: range.startDay, to: range.endDay, timezone };
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`reports:${actor.accountId}`}, 0))`;
    const pending = await tx.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM report_runs
      WHERE account_id=${actor.accountId}::uuid AND status IN ('queued','running')`;
    if ((pending[0]?.n ?? 0) >= MAX_PENDING_REPORTS) throw new ReportError('too_many_pending', 429);
    const inserted = await tx.$queryRaw<{ id: string }[]>`INSERT INTO report_runs(account_id,kind,params,requested_by,email_requested)
      VALUES(${actor.accountId}::uuid,${kind},${JSON.stringify(params)}::jsonb,${actor.userId}::uuid,${input.email === true})
      RETURNING id::text AS id`;
    const id = inserted[0].id;
    await tx.$executeRaw`INSERT INTO jobs(type,tenant_id,payload,dedupe_key,max_attempts)
      VALUES(${REPORT_JOB},${actor.accountId}::uuid,${JSON.stringify({ reportId: id })}::jsonb,${`analytics-report:${id}`},3)`;
    await audit(tx, actor, 'analytics.report_requested', id, { kind, from: params.from, to: params.to, email: input.email === true });
    const rows = await tx.$queryRaw<RunRow[]>(Prisma.sql`SELECT ${RUN_COLUMNS} FROM report_runs r
      WHERE r.account_id=${actor.accountId}::uuid AND r.id=${id}::uuid`);
    return toRun(rows[0]);
  });
}

/** The workspace's latest reports, newest first (admins and owners). */
export async function listReports(actor: ReportActor, limit = REPORT_LIST_LIMIT): Promise<ReportRun[]> {
  assertAdmin(actor);
  const n = Math.max(1, Math.min(REPORT_LIST_LIMIT, Math.floor(limit)));
  const rows = await withTenant(actor, (tx) => tx.$queryRaw<RunRow[]>(Prisma.sql`SELECT ${RUN_COLUMNS} FROM report_runs r
    WHERE r.account_id=${actor.accountId}::uuid ORDER BY r.created_at DESC, r.id LIMIT ${n}`));
  return rows.map(toRun);
}

export function reportFilename(kind: ReportKind, params: ReportParams): string {
  const day = (d: string) => (DAY.test(d) ? d : 'range');
  return `${kind}_${day(params.from)}_${day(params.to)}.csv`;
}

/**
 * Authorises one download and audit-logs it in the same transaction. Returns
 * the private object key; the caller streams the file. Not ready, failed or
 * expired reports are refused.
 */
export async function openReportDownload(actor: ReportActor, reportId: string): Promise<{ objectKey: string; filename: string }> {
  assertAdmin(actor);
  if (!UUID.test(reportId)) throw new ReportError('not_found', 404);
  return withTenant(actor, async (tx) => {
    const rows = await tx.$queryRaw<{ kind: ReportKind; status: ReportStatus; params: ReportParams; object_key: string | null; row_count: number | null; live: boolean }[]>`
      SELECT kind, status, params, object_key, row_count, expires_at > now() AS live FROM report_runs
      WHERE account_id=${actor.accountId}::uuid AND id=${reportId}::uuid`;
    const row = rows[0];
    if (!row) throw new ReportError('not_found', 404);
    if (row.status !== 'ready' || !row.object_key || !row.live) throw new ReportError('not_ready', 409);
    await audit(tx, actor, 'analytics.report_downloaded', reportId, { kind: row.kind, rows: row.row_count ?? 0 });
    return { objectKey: row.object_key, filename: reportFilename(row.kind, row.params) };
  });
}

// ------------------------------------------------------------------ worker

const worker = (accountId: string) => ({ accountId, role: 'owner' as const });

function validParams(value: unknown): ReportParams | null {
  const p = value as Partial<ReportParams> | null;
  return p && typeof p.from === 'string' && DAY.test(p.from) && typeof p.to === 'string' && DAY.test(p.to)
    && typeof p.timezone === 'string' ? { from: p.from, to: p.to, timezone: p.timezone } : null;
}

async function markFailed(accountId: string, reportId: string, error: string): Promise<void> {
  await withTenant(worker(accountId), (tx) => tx.$executeRaw`UPDATE report_runs SET status='failed',error=${error},finished_at=now()
    WHERE account_id=${accountId}::uuid AND id=${reportId}::uuid AND status IN ('queued','running')`, getWorkerPrisma());
}

/**
 * The 'analytics.report' job: payload { reportId }. Builds and stores the file,
 * marks the row ready, then emails the requester when asked. A failure is
 * retried by the queue; on the last attempt the row is marked failed.
 */
export async function runReportJob(accountId: string, payload: Record<string, unknown>,
  attempt: { attempts: number; maxAttempts: number } = { attempts: 1, maxAttempts: 1 }): Promise<void> {
  const reportId = typeof payload.reportId === 'string' && UUID.test(payload.reportId) ? payload.reportId : null;
  if (!reportId) throw new Error('Invalid report job');
  const claimed = await withTenant(worker(accountId), (tx) => tx.$queryRaw<{ kind: ReportKind; params: unknown; email_requested: boolean; requested_by: string | null }[]>`
    UPDATE report_runs SET status='running' WHERE account_id=${accountId}::uuid AND id=${reportId}::uuid
      AND status IN ('queued','running') AND expires_at > now()
    RETURNING kind, params, email_requested, requested_by::text AS requested_by`, getWorkerPrisma());
  const run = claimed[0];
  if (!run) return; // Already finished, failed, expired or gone.
  const params = validParams(run.params);
  if (!isReportKind(run.kind) || !params) return markFailed(accountId, reportId, 'invalid_request');
  try {
    const built = await withTenant(worker(accountId), async (tx) => {
      await tx.$queryRaw`SELECT set_config('statement_timeout', ${String(REPORT_STATEMENT_TIMEOUT_MS)}, true)`;
      const range = parseRange({ preset: 'custom', from: params.from, to: params.to, bucket: 'day' }, params.timezone);
      return buildReport(tx, accountId, run.kind, range);
    }, getWorkerPrisma());
    const key = reportObjectKey(accountId, reportId);
    await putReportFile(accountId, key, built.bytes);
    const marked = await withTenant(worker(accountId), (tx) => tx.$executeRaw`UPDATE report_runs SET status='ready',object_key=${key},
      row_count=${built.rowCount},truncated=${built.truncated},byte_size=${built.bytes.byteLength},error=NULL,finished_at=now()
      WHERE account_id=${accountId}::uuid AND id=${reportId}::uuid AND status='running'`, getWorkerPrisma());
    if (marked === 0) {
      // The row left 'running' meanwhile (timed out by the sweep, expired or
      // gone). Remove the file just written unless a concurrent run of this
      // job already made the same file ready; the sweep also deletes it by
      // its deterministic key at expiry.
      const now = await withTenant(worker(accountId), (tx) => tx.$queryRaw<{ status: string }[]>`
        SELECT status FROM report_runs WHERE account_id=${accountId}::uuid AND id=${reportId}::uuid`, getWorkerPrisma());
      if (now[0]?.status !== 'ready') await deleteReportFile(accountId, key).catch(() => undefined);
      return;
    }
  } catch (error) {
    // Only the category is kept; errors can carry SQL or provider details.
    console.error('[reports] build failed', { kind: run.kind, attempt: attempt.attempts });
    if (attempt.attempts >= attempt.maxAttempts) await markFailed(accountId, reportId, 'build_failed');
    throw error;
  }
  if (run.email_requested && run.requested_by) await emailReportReady(accountId, reportId, run.kind, params, run.requested_by);
}

/** Sent once (outbound intent); skipped while SMTP or APP_URL is unset, or when the requester is no longer an admin. */
async function emailReportReady(accountId: string, reportId: string, kind: ReportKind, params: ReportParams, userId: string): Promise<void> {
  const sender = process.env.AUTH_EMAIL_FROM;
  const origin = process.env.APP_URL || process.env.NEXT_PUBLIC_APP_URL;
  if (!process.env.SMTP_URL || !sender || !origin) return;
  // The row is already ready, so a retry would not reach this step: every
  // failure here, including the lookup, is logged by category and swallowed.
  try {
    const rows = await withTenant(worker(accountId), (tx) => tx.$queryRaw<{ email: string | null; role: string }[]>`
      SELECT p.email, m.role FROM account_memberships m LEFT JOIN profiles p ON p.user_id=m.user_id
      WHERE m.account_id=${accountId}::uuid AND m.user_id=${userId}::uuid LIMIT 1`, getWorkerPrisma());
    const address = rows[0]?.email?.trim() ?? '';
    if (!rows[0] || !['owner', 'admin'].includes(rows[0].role) || !ADDRESS.test(address)) return;
    const t = getT('Analytics.reports');
    const link = new URL(`/api/analytics/reports/${reportId}/download`, origin).toString();
    const values = { report: t(`kinds.${kind}`), from: params.from, to: params.to };
    await dispatchOnce(accountId, `report-email:${reportId}`, async () => {
      const transport = authEmailTransport();
      try {
        await transport.sendMail({
          from: sender, to: address, subject: t('email.subject', values),
          text: `${t('email.body', values)}\n\n${link}\n\n${t('email.footer')}\n`,
        });
      } finally {
        transport.close();
      }
      return { sent: true };
    });
  } catch (error) {
    // The report is ready in the app either way; never re-send blindly.
    if (!(error instanceof UncertainDispatchError)) console.error('[reports] ready email failed', { kind });
  }
}

let lastSweepSchedule = Number.NEGATIVE_INFINITY;

/** Called from scheduleWork; offers one sweep job per workspace with due reports, at most hourly. */
export async function scheduleReportSweeps(now: number = Date.now(), force = false): Promise<number> {
  if (!force && now - lastSweepSchedule < REPORT_SWEEP_INTERVAL_MS) return 0;
  const accounts = await getWorkerPrisma().$queryRaw<{ account_id: string }[]>`SELECT * FROM crm_accounts_with_due_reports()`;
  const slot = Math.floor(now / REPORT_SWEEP_INTERVAL_MS);
  for (const { account_id } of accounts)
    await getWorkerPrisma().$executeRaw`INSERT INTO jobs(type,tenant_id,payload,dedupe_key,max_attempts)
      VALUES(${REPORT_SWEEP_JOB},${account_id}::uuid,'{}'::jsonb,${`report-sweep:${account_id}:${slot}`},2)
      ON CONFLICT(dedupe_key) DO NOTHING`;
  lastSweepSchedule = now;
  return accounts.length;
}

export function resetReportSweepScheduleForTests(): void {
  lastSweepSchedule = Number.NEGATIVE_INFINITY;
}

/** Fails requests stuck for six hours, then deletes expired files and marks their rows expired. */
export async function runReportSweep(accountId: string): Promise<{ failed: number; expired: number }> {
  const failed = await withTenant(worker(accountId), (tx) => tx.$executeRaw`UPDATE report_runs SET status='failed',error='timed_out',finished_at=now()
    WHERE account_id=${accountId}::uuid AND status IN ('queued','running') AND created_at < now() - interval '6 hours'`, getWorkerPrisma());
  const due = await withTenant(worker(accountId), (tx) => tx.$queryRaw<{ id: string; object_key: string | null }[]>`
    SELECT id::text AS id, object_key FROM report_runs
    WHERE account_id=${accountId}::uuid AND status <> 'expired' AND expires_at < now() ORDER BY expires_at LIMIT 500`, getWorkerPrisma());
  let expired = 0;
  for (const row of due) {
    // File first: a failed delete leaves the row for the next sweep.
    // Always by the deterministic key: a file can exist without object_key
    // (uploaded, then the ready update failed or found the row timed out).
    await deleteReportFile(accountId, row.object_key ?? reportObjectKey(accountId, row.id));
    expired += await withTenant(worker(accountId), (tx) => tx.$executeRaw`UPDATE report_runs SET status='expired',object_key=NULL
      WHERE account_id=${accountId}::uuid AND id=${row.id}::uuid AND status <> 'expired'`, getWorkerPrisma());
  }
  return { failed, expired };
}

/** Worker entry for both report job types. */
export async function handleReportJob(accountId: string, type: string, payload: Record<string, unknown>,
  attempt?: { attempts: number; maxAttempts: number }): Promise<void> {
  if (type === REPORT_JOB) return runReportJob(accountId, payload, attempt);
  if (type === REPORT_SWEEP_JOB) {
    await runReportSweep(accountId);
    return;
  }
  throw new Error('Unsupported report job type');
}
