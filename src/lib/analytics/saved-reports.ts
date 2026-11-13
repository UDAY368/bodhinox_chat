// Saved report definitions (Analytics > Reports), admins and owners only.
//
// A definition (analytics_saved_reports, FORCE RLS) names metrics, a
// grouping, a channel, a range and a file type. The app lists, creates, edits,
// duplicates and deletes them; previews one as a table; exports it straight
// away as CSV or PDF (audit-logged, built inside withTenant with a statement
// timeout); and emails it on a schedule (a report_schedules row of kind
// 'saved_report', one per definition, delivered by the existing scheduled
// report pipeline in report-schedules.ts and reports.ts). Deleting a
// definition deletes its schedule (foreign key ON DELETE CASCADE).
//
// Every statement runs inside withTenant and names account_id. Contents are
// counts, durations, member names and label names only.

import { Prisma } from '@prisma/client';
import { hasMinRole, type AccountRole } from '@/lib/auth/roles';
import { withTenant, type TenantTransaction } from '@/lib/db/tenant';
import { runAnalytics } from './queries';
import { parseRange, workspaceTimezone, type AnalyticsRange, type ReportCadence } from './range';
import { renderReport, type ReportTable } from './reports';
import { SAVED_REPORT_KIND } from './report-kinds';
import {
  assertAdminRecipients, MAX_REPORT_SCHEDULES, nextRunAt, parseRecipients, REPORT_CADENCES, SCHEDULE_COLUMNS, ScheduleError,
  toSchedules, type ReportSchedule, type ScheduleRow,
} from './report-schedules';
import {
  copyName, fileStem, MAX_SAVED_REPORTS, parseSavedReport, type SavedReportDefinition, type SavedReportIssue, type SavedReportSnapshot,
} from './saved-report-shape';
import { savedReportColumns, savedReportData, type SavedReportData } from './saved-report-table';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class SavedReportError extends Error {
  constructor(
    public readonly code: 'invalid' | 'duplicate_name' | 'not_found' | 'too_many',
    public readonly status: number,
    public readonly issue?: SavedReportIssue,
  ) {
    super(code);
    this.name = 'SavedReportError';
  }
}

export interface SavedReportActor {
  accountId: string;
  userId: string;
  role: AccountRole;
}

export interface SavedReport extends SavedReportDefinition {
  id: string;
  createdBy: { userId: string; name: string | null } | null;
  createdAt: string;
  updatedAt: string;
  schedule: ReportSchedule | null;
}

type Row = {
  id: string; name: string; metrics: string[]; group_by: string; channel: string; range_preset: string;
  from_day: string | null; to_day: string | null; format: string; created_by: string | null; creator_name: string | null;
  created_at: Date; updated_at: Date;
};

const COLUMNS = Prisma.sql`r.id::text AS id, r.name, r.metrics::text[] AS metrics, r.group_by, r.channel, r.range_preset,
  to_char(r.from_day, 'YYYY-MM-DD') AS from_day, to_char(r.to_day, 'YYYY-MM-DD') AS to_day, r.format,
  r.created_by::text AS created_by, (SELECT p.full_name FROM profiles p WHERE p.user_id=r.created_by LIMIT 1) AS creator_name,
  r.created_at, r.updated_at`;

function assertAdmin(actor: SavedReportActor): void {
  if (!hasMinRole(actor.role, 'admin')) throw new SavedReportError('not_found', 404);
}

function assertId(id: string): void {
  if (!UUID.test(id)) throw new SavedReportError('not_found', 404);
}

function definition(row: Row): SavedReportDefinition {
  // The table's checks hold every value to the same lists parseSavedReport accepts.
  return {
    name: row.name,
    metrics: row.metrics as SavedReportDefinition['metrics'],
    group: row.group_by as SavedReportDefinition['group'],
    channel: row.channel as SavedReportDefinition['channel'],
    range: { preset: row.range_preset as SavedReportDefinition['range']['preset'], from: row.from_day, to: row.to_day },
    format: row.format === 'pdf' ? 'pdf' : 'csv',
  };
}

const audit = (tx: TenantTransaction, actor: SavedReportActor, action: string, id: string, metadata: Record<string, unknown>) =>
  tx.$executeRaw`INSERT INTO audit_logs(account_id,user_id,action,resource_id,metadata)
    VALUES(${actor.accountId}::uuid,${actor.userId}::uuid,${action},${id},${JSON.stringify(metadata)}::jsonb)`;

async function schedulesFor(tx: TenantTransaction, accountId: string, ids: string[]): Promise<Map<string, ReportSchedule>> {
  if (ids.length === 0) return new Map();
  const rows = await tx.$queryRaw<ScheduleRow[]>(Prisma.sql`SELECT ${SCHEDULE_COLUMNS} FROM report_schedules s
    WHERE s.account_id=${accountId}::uuid AND s.saved_report_id = ANY(${ids}::uuid[])`);
  const schedules = await toSchedules(tx, rows);
  return new Map(schedules.filter((s) => s.savedReport).map((s) => [s.savedReport!.id, s]));
}

async function toReports(tx: TenantTransaction, accountId: string, rows: Row[]): Promise<SavedReport[]> {
  const schedules = await schedulesFor(tx, accountId, rows.map((r) => r.id));
  return rows.map((r) => ({
    id: r.id,
    ...definition(r),
    createdBy: r.created_by ? { userId: r.created_by, name: r.creator_name } : null,
    createdAt: r.created_at.toISOString(),
    updatedAt: r.updated_at.toISOString(),
    schedule: schedules.get(r.id) ?? null,
  }));
}

async function loadRow(tx: TenantTransaction, accountId: string, id: string, lock = false): Promise<Row> {
  const rows = await tx.$queryRaw<Row[]>(Prisma.sql`SELECT ${COLUMNS} FROM analytics_saved_reports r
    WHERE r.account_id=${accountId}::uuid AND r.id=${id}::uuid ${lock ? Prisma.sql`FOR UPDATE` : Prisma.empty}`);
  if (!rows[0]) throw new SavedReportError('not_found', 404);
  return rows[0];
}

const lockWorkspace = (tx: TenantTransaction, accountId: string) =>
  tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`saved-reports:${accountId}`}, 0))`;

async function assertNameFree(tx: TenantTransaction, accountId: string, name: string, except: string | null): Promise<void> {
  const taken = await tx.$queryRaw<{ id: string }[]>`SELECT id::text AS id FROM analytics_saved_reports
    WHERE account_id=${accountId}::uuid AND lower(name)=lower(${name}) ${except ? Prisma.sql`AND id <> ${except}::uuid` : Prisma.empty}`;
  if (taken[0]) throw new SavedReportError('duplicate_name', 409);
}

function parse(input: unknown): SavedReportDefinition {
  const parsed = parseSavedReport(input);
  if (!parsed.ok) throw new SavedReportError('invalid', 400, parsed.issue);
  return parsed.value;
}

// ------------------------------------------------------------------ definitions

export async function listSavedReports(actor: SavedReportActor): Promise<SavedReport[]> {
  assertAdmin(actor);
  return withTenant(actor, async (tx) => toReports(tx, actor.accountId, await tx.$queryRaw<Row[]>(Prisma.sql`SELECT ${COLUMNS}
    FROM analytics_saved_reports r WHERE r.account_id=${actor.accountId}::uuid ORDER BY r.created_at DESC, r.id LIMIT ${MAX_SAVED_REPORTS}`)));
}

async function insert(tx: TenantTransaction, actor: SavedReportActor, d: SavedReportDefinition): Promise<string> {
  await lockWorkspace(tx, actor.accountId);
  const count = await tx.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM analytics_saved_reports WHERE account_id=${actor.accountId}::uuid`;
  if ((count[0]?.n ?? 0) >= MAX_SAVED_REPORTS) throw new SavedReportError('too_many', 409);
  await assertNameFree(tx, actor.accountId, d.name, null);
  const inserted = await tx.$queryRaw<{ id: string }[]>`INSERT INTO analytics_saved_reports
    (account_id,name,metrics,group_by,channel,range_preset,from_day,to_day,format,created_by)
    VALUES(${actor.accountId}::uuid,${d.name},${d.metrics}::text[],${d.group},${d.channel},${d.range.preset},
      ${d.range.from}::date,${d.range.to}::date,${d.format},${actor.userId}::uuid)
    RETURNING id::text AS id`;
  return inserted[0].id;
}

export async function createSavedReport(actor: SavedReportActor, input: unknown): Promise<SavedReport> {
  assertAdmin(actor);
  const d = parse(input);
  return withTenant(actor, async (tx) => {
    const id = await insert(tx, actor, d);
    await audit(tx, actor, 'analytics.saved_report_created', id, { group: d.group, metrics: d.metrics.length, channel: d.channel });
    return (await toReports(tx, actor.accountId, [await loadRow(tx, actor.accountId, id)]))[0];
  });
}

/** Replaces a definition. Its schedule keeps its timing and recipients and takes the new file type. */
export async function updateSavedReport(actor: SavedReportActor, id: string, input: unknown): Promise<SavedReport> {
  assertAdmin(actor);
  assertId(id);
  const d = parse(input);
  return withTenant(actor, async (tx) => {
    await lockWorkspace(tx, actor.accountId);
    await loadRow(tx, actor.accountId, id, true);
    await assertNameFree(tx, actor.accountId, d.name, id);
    await tx.$executeRaw`UPDATE analytics_saved_reports SET name=${d.name}, metrics=${d.metrics}::text[], group_by=${d.group},
      channel=${d.channel}, range_preset=${d.range.preset}, from_day=${d.range.from}::date, to_day=${d.range.to}::date, format=${d.format}
      WHERE account_id=${actor.accountId}::uuid AND id=${id}::uuid`;
    await tx.$executeRaw`UPDATE report_schedules SET format=${d.format}, updated_at=now()
      WHERE account_id=${actor.accountId}::uuid AND saved_report_id=${id}::uuid AND format <> ${d.format}`;
    await audit(tx, actor, 'analytics.saved_report_updated', id, { group: d.group, metrics: d.metrics.length, channel: d.channel });
    return (await toReports(tx, actor.accountId, [await loadRow(tx, actor.accountId, id)]))[0];
  });
}

/** A copy named "<name> copy" (then "copy 2", ...), without the schedule. */
export async function duplicateSavedReport(actor: SavedReportActor, id: string): Promise<SavedReport> {
  assertAdmin(actor);
  assertId(id);
  return withTenant(actor, async (tx) => {
    const source = definition(await loadRow(tx, actor.accountId, id));
    const names = await tx.$queryRaw<{ name: string }[]>`SELECT name FROM analytics_saved_reports WHERE account_id=${actor.accountId}::uuid`;
    const copy = await insert(tx, actor, { ...source, name: copyName(source.name, names.map((n) => n.name)) });
    await audit(tx, actor, 'analytics.saved_report_created', copy, { duplicateOf: id });
    return (await toReports(tx, actor.accountId, [await loadRow(tx, actor.accountId, copy)]))[0];
  });
}

/** Deletes a definition; its schedule goes with it, so its emails stop. */
export async function deleteSavedReport(actor: SavedReportActor, id: string): Promise<void> {
  assertAdmin(actor);
  assertId(id);
  await withTenant(actor, async (tx) => {
    const deleted = await tx.$executeRaw`DELETE FROM analytics_saved_reports WHERE account_id=${actor.accountId}::uuid AND id=${id}::uuid`;
    if (deleted === 0) throw new SavedReportError('not_found', 404);
    await audit(tx, actor, 'analytics.saved_report_deleted', id, {});
  });
}

// ------------------------------------------------------------------ preview and export

function snapshot(d: SavedReportDefinition): SavedReportSnapshot {
  return { name: d.name, metrics: d.metrics, group: d.group, channel: d.channel };
}

function rangeOf(d: SavedReportDefinition, timezone: string): AnalyticsRange {
  return parseRange(d.range.preset === 'custom' ? { preset: 'custom', from: d.range.from, to: d.range.to } : { preset: d.range.preset }, timezone);
}

export interface SavedReportPreview extends SavedReportData {
  range: { startDay: string; endDay: string; days: number; timezone: string };
}

/** The report's rows for its range, resolved now in the workspace timezone. */
export async function previewSavedReport(actor: SavedReportActor, id: string): Promise<SavedReportPreview> {
  assertAdmin(actor);
  assertId(id);
  return runAnalytics(actor, async (tx, timezone) => {
    const d = definition(await loadRow(tx, actor.accountId, id));
    const range = rangeOf(d, timezone);
    const data = await savedReportData(tx, actor.accountId, snapshot(d), range);
    return { ...data, range: { startDay: range.startDay, endDay: range.endDay, days: range.days, timezone } };
  });
}

/**
 * Builds the file now (CSV or PDF; the report's own type unless asked) and
 * audit-logs the export in the same transaction as the query. Rendering runs
 * after the transaction commits.
 */
export async function exportSavedReport(actor: SavedReportActor, id: string, format?: 'csv' | 'pdf'):
  Promise<{ bytes: Uint8Array; filename: string; format: 'csv' | 'pdf' }> {
  assertAdmin(actor);
  assertId(id);
  const built = await runAnalytics(actor, async (tx, timezone) => {
    const d = definition(await loadRow(tx, actor.accountId, id));
    const range = rangeOf(d, timezone);
    const data = await savedReportData(tx, actor.accountId, snapshot(d), range);
    const chosen = format ?? d.format;
    await audit(tx, actor, 'analytics.saved_report_exported', id, { format: chosen, rows: data.rows.length, from: range.startDay, to: range.endDay });
    return { d, data, range, timezone, chosen };
  });
  const table = { columns: savedReportColumns(built.data, built.timezone), rows: built.data.rows } as unknown as ReportTable;
  const params = { from: built.range.startDay, to: built.range.endDay, timezone: built.timezone, report: snapshot(built.d) };
  const file = await renderReport(table, built.chosen, { kind: SAVED_REPORT_KIND, params });
  return { bytes: file.bytes, filename: `${fileStem(built.d.name)}_${params.from}_${params.to}.${built.chosen}`, format: built.chosen };
}

// ------------------------------------------------------------------ schedule

export interface SavedScheduleInput {
  cadence?: unknown;
  hourLocal?: unknown;
  minuteLocal?: unknown;
  recipients?: unknown;
}

const isCadence = (v: unknown): v is ReportCadence => typeof v === 'string' && (REPORT_CADENCES as readonly string[]).includes(v);
const isInt = (v: unknown, max: number): v is number => Number.isInteger(v) && (v as number) >= 0 && (v as number) <= max;

/**
 * Creates or changes the report's email schedule: how often, the local time to
 * the minute, and 1-10 recipients who are admins or owners now (and are checked
 * again at every send). A paused schedule stays paused. Counts toward the
 * workspace's MAX_REPORT_SCHEDULES.
 */
export async function setSavedReportSchedule(actor: SavedReportActor, id: string, input: SavedScheduleInput): Promise<SavedReport> {
  assertAdmin(actor);
  assertId(id);
  if (!isCadence(input.cadence) || !isInt(input.hourLocal, 23) || !isInt(input.minuteLocal, 59)) throw new ScheduleError('invalid', 400);
  const cadence = input.cadence, hour = input.hourLocal, minute = input.minuteLocal;
  const recipients = parseRecipients(input.recipients);
  return withTenant(actor, async (tx) => {
    // The same lock createSchedule takes, so the workspace limit holds across both paths.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`report-schedules:${actor.accountId}`}, 0))`;
    const report = await loadRow(tx, actor.accountId, id, true);
    await assertAdminRecipients(tx, actor.accountId, recipients);
    const next = nextRunAt(cadence, hour, await workspaceTimezone(tx, actor.accountId), new Date(), minute);
    const existing = await tx.$queryRaw<{ id: string }[]>`SELECT id::text AS id FROM report_schedules
      WHERE account_id=${actor.accountId}::uuid AND saved_report_id=${id}::uuid FOR UPDATE`;
    if (existing[0]) {
      await tx.$executeRaw`UPDATE report_schedules SET cadence=${cadence}, hour_local=${hour}, minute_local=${minute},
        recipients=${recipients}::uuid[], format=${report.format}, next_run_at=${next}, updated_at=now()
        WHERE account_id=${actor.accountId}::uuid AND id=${existing[0].id}::uuid`;
      await audit(tx, actor, 'analytics.report_schedule_updated', existing[0].id, { savedReport: id, cadence, hour, minute, recipients: recipients.length });
    } else {
      const count = await tx.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM report_schedules WHERE account_id=${actor.accountId}::uuid`;
      if ((count[0]?.n ?? 0) >= MAX_REPORT_SCHEDULES) throw new ScheduleError('too_many', 409);
      const inserted = await tx.$queryRaw<{ id: string }[]>`INSERT INTO report_schedules
        (account_id,kind,format,cadence,hour_local,minute_local,saved_report_id,recipients,created_by,next_run_at)
        VALUES(${actor.accountId}::uuid,${SAVED_REPORT_KIND},${report.format},${cadence},${hour},${minute},${id}::uuid,
          ${recipients}::uuid[],${actor.userId}::uuid,${next})
        RETURNING id::text AS id`;
      await audit(tx, actor, 'analytics.report_schedule_created', inserted[0].id, { savedReport: id, cadence, hour, minute, recipients: recipients.length });
    }
    return (await toReports(tx, actor.accountId, [report]))[0];
  });
}

/** Stops emailing the report (deletes its schedule). */
export async function removeSavedReportSchedule(actor: SavedReportActor, id: string): Promise<SavedReport> {
  assertAdmin(actor);
  assertId(id);
  return withTenant(actor, async (tx) => {
    const report = await loadRow(tx, actor.accountId, id);
    const deleted = await tx.$queryRaw<{ id: string }[]>`DELETE FROM report_schedules
      WHERE account_id=${actor.accountId}::uuid AND saved_report_id=${id}::uuid RETURNING id::text AS id`;
    if (!deleted[0]) throw new ScheduleError('not_found', 404);
    await audit(tx, actor, 'analytics.report_schedule_deleted', deleted[0].id, { savedReport: id });
    return (await toReports(tx, actor.accountId, [report]))[0];
  });
}
