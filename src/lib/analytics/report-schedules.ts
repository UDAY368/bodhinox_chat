// Scheduled report delivery (Phase 12 design §5.4).
//
// An admin schedules a report kind and format with a cadence (daily, weekly on
// Monday, monthly on the 1st) at a local hour, for up to ten recipients who
// must be admins or owners of the workspace. At most MAX_REPORT_SCHEDULES per
// workspace, counted under a per-workspace advisory lock.
//
// The worker discovers workspaces with a due schedule every five minutes
// (scheduleReportSchedules, called from scheduleWork) and runs
// 'analytics.report_schedules' per workspace. For each due schedule, in one
// worker transaction with the schedule row locked (SKIP LOCKED):
//   1. the creator must still be an admin or owner of the workspace, or the
//      schedule pauses ('creator_lost_access', audited) and produces nothing;
//   2. the previous complete period is computed in the workspace timezone;
//   3. a report_runs row is inserted as the creator with this schedule_id, and
//      ON CONFLICT on (schedule, period start) makes a repeat a no-op;
//   4. its 'analytics.report' job is queued in the same transaction;
//   5. next_run_at advances to the next local occurrence (DST-safe).
// Delivery (reports.ts emailReportRecipients) rechecks every recipient's live
// membership and role again at send time.

import { Prisma } from '@prisma/client';
import { hasMinRole, type AccountRole } from '@/lib/auth/roles';
import { getWorkerPrisma } from '@/lib/db/prisma';
import { withTenant, type TenantTransaction } from '@/lib/db/tenant';
import { addDays, localDay, localMidnight, previousCompletePeriod, workspaceTimezone, type ReportCadence } from './range';
import { isReportFormat, isReportKind, isRunKind, REPORT_JOB, type ReportFormat, type ReportParams, type RunKind } from './reports';
import { SAVED_REPORT_KIND } from './report-kinds';
import { parseSnapshot } from './saved-report-shape';

export const REPORT_SCHEDULES_JOB = 'analytics.report_schedules';
export const MAX_REPORT_SCHEDULES = 10;
export const MAX_SCHEDULE_RECIPIENTS = 10;
export const REPORT_CADENCES: readonly ReportCadence[] = ['daily', 'weekly', 'monthly'];
export const SCHEDULE_DISCOVERY_INTERVAL_MS = 5 * 60_000;
/** Due schedules handled per workspace job; the rest wait for the next sweep. */
const SCHEDULES_PER_JOB = 50;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type PauseReason = 'manual' | 'creator_lost_access' | 'no_recipients';

export class ScheduleError extends Error {
  constructor(
    public readonly code: 'invalid' | 'invalid_recipients' | 'not_found' | 'too_many' | 'creator_lost_access',
    public readonly status: number,
  ) {
    super(code);
    this.name = 'ScheduleError';
  }
}

export interface ScheduleActor {
  accountId: string;
  userId: string;
  role: AccountRole;
}

export interface ReportSchedule {
  id: string;
  kind: RunKind;
  format: ReportFormat;
  cadence: ReportCadence;
  hourLocal: number;
  /** Minutes past hourLocal (saved report schedules pick any minute; the others run on the hour). */
  minuteLocal: number;
  /** The saved report a 'saved_report' schedule emails, else null. */
  savedReport: { id: string; name: string } | null;
  recipients: { userId: string; name: string | null }[];
  createdBy: { userId: string; name: string | null };
  pausedAt: string | null;
  pauseReason: PauseReason | null;
  nextRunAt: string;
  lastRunId: string | null;
  createdAt: string;
}

// ------------------------------------------------------------------ timing

function localHour(instant: number, timezone: string): number {
  const hour = new Intl.DateTimeFormat('en-US', { timeZone: timezone, hour: '2-digit', hourCycle: 'h23' }).format(instant);
  return Number(hour) % 24;
}

/** The instant a local day reaches `hour` in `timezone` (DST-safe; a skipped hour lands an hour off). */
export function localHourInstant(day: string, hour: number, timezone: string): Date {
  let instant = localMidnight(day, timezone).getTime() + hour * 3_600_000;
  // A DST change between midnight and the hour shifts the wall clock by its size.
  const drift = localHour(instant, timezone) - hour;
  if (drift !== 0) instant -= (((drift % 24) + 36) % 24 - 12) * 3_600_000;
  return new Date(instant);
}

/**
 * The next occurrence strictly after `now`: daily every day, weekly on Monday,
 * monthly on the 1st, at `hour` local time in the workspace timezone.
 */
export function nextRunAt(cadence: ReportCadence, hour: number, timezone: string, now: Date = new Date(), minute = 0): Date {
  const today = localDay(now, timezone);
  const isCandidate = (day: string) => {
    if (cadence === 'daily') return true;
    const [y, m, d] = day.split('-').map(Number);
    if (cadence === 'weekly') return new Date(Date.UTC(y, m - 1, d)).getUTCDay() === 1;
    return d === 1;
  };
  for (let i = 0; i <= 62; i++) {
    const day = addDays(today, i);
    if (!isCandidate(day)) continue;
    const at = new Date(localHourInstant(day, hour, timezone).getTime() + minute * 60_000);
    if (at.getTime() > now.getTime()) return at;
  }
  throw new Error('No next schedule occurrence');
}

// ------------------------------------------------------------------ validation

export interface ScheduleInput {
  kind?: unknown;
  format?: unknown;
  cadence?: unknown;
  hourLocal?: unknown;
  recipients?: unknown;
}

const isCadence = (value: unknown): value is ReportCadence => typeof value === 'string' && (REPORT_CADENCES as readonly string[]).includes(value);
const isHour = (value: unknown): value is number => Number.isInteger(value) && (value as number) >= 0 && (value as number) <= 23;

export function parseRecipients(value: unknown): string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_SCHEDULE_RECIPIENTS) throw new ScheduleError('invalid_recipients', 400);
  const ids = value.map((v) => (typeof v === 'string' && UUID.test(v) ? v.toLowerCase() : null));
  if (ids.some((v) => v === null) || new Set(ids).size !== ids.length) throw new ScheduleError('invalid_recipients', 400);
  return ids as string[];
}

/** Every recipient must be a current admin or owner of this workspace. */
export async function assertAdminRecipients(tx: TenantTransaction, accountId: string, recipients: string[]): Promise<void> {
  const rows = await tx.$queryRaw<{ user_id: string }[]>`SELECT user_id::text AS user_id FROM account_memberships
    WHERE account_id=${accountId}::uuid AND user_id = ANY(${recipients}::uuid[]) AND role IN ('owner','admin')`;
  if (rows.length !== recipients.length) throw new ScheduleError('invalid_recipients', 400);
}

function assertAdmin(actor: ScheduleActor): void {
  if (!hasMinRole(actor.role, 'admin')) throw new ScheduleError('not_found', 404);
}

const audit = (tx: TenantTransaction, actor: ScheduleActor, action: string, scheduleId: string, metadata: Record<string, unknown>) =>
  tx.$executeRaw`INSERT INTO audit_logs(account_id,user_id,action,resource_id,metadata)
    VALUES(${actor.accountId}::uuid,${actor.userId}::uuid,${action},${scheduleId},${JSON.stringify(metadata)}::jsonb)`;

export type ScheduleRow = {
  id: string; kind: RunKind; format: ReportFormat; cadence: ReportCadence; hour_local: number; minute_local?: number | null;
  saved_report_id?: string | null; saved_report_name?: string | null; recipients: string[];
  created_by: string; paused_at: Date | null; pause_reason: PauseReason | null; next_run_at: Date; last_run_id: string | null;
  created_at: Date;
};

export const SCHEDULE_COLUMNS = Prisma.sql`s.id::text AS id, s.kind, s.format, s.cadence, s.hour_local, s.minute_local,
  s.saved_report_id::text AS saved_report_id,
  (SELECT sr.name FROM analytics_saved_reports sr WHERE sr.account_id=s.account_id AND sr.id=s.saved_report_id) AS saved_report_name,
  s.recipients::text[] AS recipients,
  s.created_by::text AS created_by, s.paused_at, s.pause_reason, s.next_run_at, s.last_run_id::text AS last_run_id, s.created_at`;

async function names(tx: TenantTransaction, ids: string[]): Promise<Map<string, string | null>> {
  if (ids.length === 0) return new Map();
  const rows = await tx.$queryRaw<{ user_id: string; full_name: string | null }[]>`SELECT user_id::text AS user_id, full_name
    FROM profiles WHERE user_id = ANY(${ids}::uuid[])`;
  return new Map(rows.map((r) => [r.user_id, r.full_name]));
}

export async function toSchedules(tx: TenantTransaction, rows: ScheduleRow[]): Promise<ReportSchedule[]> {
  const people = await names(tx, [...new Set(rows.flatMap((r) => [r.created_by, ...r.recipients]))]);
  return rows.map((r) => ({
    id: r.id, kind: r.kind, format: r.format, cadence: r.cadence, hourLocal: r.hour_local, minuteLocal: r.minute_local ?? 0,
    savedReport: r.saved_report_id && r.saved_report_name ? { id: r.saved_report_id, name: r.saved_report_name } : null,
    recipients: r.recipients.map((userId) => ({ userId, name: people.get(userId) ?? null })),
    createdBy: { userId: r.created_by, name: people.get(r.created_by) ?? null },
    pausedAt: r.paused_at?.toISOString() ?? null, pauseReason: r.pause_reason, nextRunAt: r.next_run_at.toISOString(),
    lastRunId: r.last_run_id, createdAt: r.created_at.toISOString(),
  }));
}

async function loadOne(tx: TenantTransaction, accountId: string, id: string): Promise<ReportSchedule> {
  const rows = await tx.$queryRaw<ScheduleRow[]>(Prisma.sql`SELECT ${SCHEDULE_COLUMNS} FROM report_schedules s
    WHERE s.account_id=${accountId}::uuid AND s.id=${id}::uuid`);
  if (!rows[0]) throw new ScheduleError('not_found', 404);
  return (await toSchedules(tx, rows))[0];
}

// ------------------------------------------------------------------ app (admins and owners)

export async function listSchedules(actor: ScheduleActor): Promise<ReportSchedule[]> {
  assertAdmin(actor);
  return withTenant(actor, async (tx) => toSchedules(tx, await tx.$queryRaw<ScheduleRow[]>(Prisma.sql`SELECT ${SCHEDULE_COLUMNS}
    FROM report_schedules s WHERE s.account_id=${actor.accountId}::uuid ORDER BY s.created_at, s.id LIMIT ${MAX_REPORT_SCHEDULES * 2}`)));
}

export async function createSchedule(actor: ScheduleActor, input: ScheduleInput): Promise<ReportSchedule> {
  assertAdmin(actor);
  if (!isReportKind(input.kind) || !isCadence(input.cadence) || (input.format !== undefined && !isReportFormat(input.format))
    || (input.hourLocal !== undefined && !isHour(input.hourLocal))) throw new ScheduleError('invalid', 400);
  const kind = input.kind, cadence = input.cadence;
  const format: ReportFormat = input.format === 'pdf' ? 'pdf' : 'csv';
  const hour = isHour(input.hourLocal) ? input.hourLocal : 8;
  const recipients = parseRecipients(input.recipients);
  return withTenant(actor, async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`report-schedules:${actor.accountId}`}, 0))`;
    const count = await tx.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM report_schedules WHERE account_id=${actor.accountId}::uuid`;
    if ((count[0]?.n ?? 0) >= MAX_REPORT_SCHEDULES) throw new ScheduleError('too_many', 409);
    await assertAdminRecipients(tx, actor.accountId, recipients);
    const timezone = await workspaceTimezone(tx, actor.accountId);
    const next = nextRunAt(cadence, hour, timezone);
    const inserted = await tx.$queryRaw<{ id: string }[]>`INSERT INTO report_schedules
      (account_id,kind,format,cadence,hour_local,recipients,created_by,next_run_at)
      VALUES(${actor.accountId}::uuid,${kind},${format},${cadence},${hour},${recipients}::uuid[],${actor.userId}::uuid,${next})
      RETURNING id::text AS id`;
    const id = inserted[0].id;
    await audit(tx, actor, 'analytics.report_schedule_created', id, { kind, format, cadence, hour, recipients: recipients.length });
    return loadOne(tx, actor.accountId, id);
  });
}

export interface ScheduleUpdate extends Omit<ScheduleInput, 'kind'> {
  paused?: unknown;
}

/** Pause or resume, and change recipients, hour, cadence or format. Timing changes recompute next_run_at from now. */
export async function updateSchedule(actor: ScheduleActor, id: string, input: ScheduleUpdate): Promise<ReportSchedule> {
  assertAdmin(actor);
  if (!UUID.test(id)) throw new ScheduleError('not_found', 404);
  if ((input.paused !== undefined && typeof input.paused !== 'boolean') || (input.cadence !== undefined && !isCadence(input.cadence))
    || (input.format !== undefined && !isReportFormat(input.format)) || (input.hourLocal !== undefined && !isHour(input.hourLocal)))
    throw new ScheduleError('invalid', 400);
  const recipients = input.recipients === undefined ? undefined : parseRecipients(input.recipients);
  return withTenant(actor, async (tx) => {
    const rows = await tx.$queryRaw<ScheduleRow[]>(Prisma.sql`SELECT ${SCHEDULE_COLUMNS} FROM report_schedules s
      WHERE s.account_id=${actor.accountId}::uuid AND s.id=${id}::uuid FOR UPDATE`);
    const current = rows[0];
    if (!current) throw new ScheduleError('not_found', 404);
    if (recipients) await assertAdminRecipients(tx, actor.accountId, recipients);
    const cadence = (input.cadence as ReportCadence | undefined) ?? current.cadence;
    const hour = (input.hourLocal as number | undefined) ?? current.hour_local;
    const resuming = input.paused === false && current.paused_at !== null;
    if (resuming && current.pause_reason === 'creator_lost_access') {
      // The worker would pause it again at once: the run belongs to its creator, who is no longer an admin.
      const creator = await tx.$queryRaw<{ role: string }[]>`SELECT role FROM account_memberships
        WHERE account_id=${actor.accountId}::uuid AND user_id=${current.created_by}::uuid`;
      if (!creator[0] || !['owner', 'admin'].includes(creator[0].role)) throw new ScheduleError('creator_lost_access', 409);
    }
    const timing = resuming || cadence !== current.cadence || hour !== current.hour_local;
    const next = timing ? nextRunAt(cadence, hour, await workspaceTimezone(tx, actor.accountId), new Date(), current.minute_local ?? 0)
      : current.next_run_at;
    // paused_at and pause_reason are set and cleared together (CHECK in SQL).
    const pausing = input.paused === true && current.paused_at === null;
    const pausedAt = pausing ? new Date() : resuming ? null : current.paused_at;
    const reason: PauseReason | null = pausing ? 'manual' : resuming ? null : current.pause_reason;
    await tx.$executeRaw`UPDATE report_schedules SET recipients=${recipients ?? current.recipients}::uuid[], hour_local=${hour},
      cadence=${cadence}, format=${(input.format as ReportFormat | undefined) ?? current.format}, paused_at=${pausedAt},
      pause_reason=${reason}, next_run_at=${next}, updated_at=now()
      WHERE account_id=${actor.accountId}::uuid AND id=${id}::uuid`;
    await audit(tx, actor, 'analytics.report_schedule_updated', id, {
      paused: pausing ? true : resuming ? false : undefined, cadence, hour, format: input.format, recipients: recipients?.length,
    });
    return loadOne(tx, actor.accountId, id);
  });
}

export async function deleteSchedule(actor: ScheduleActor, id: string): Promise<void> {
  assertAdmin(actor);
  if (!UUID.test(id)) throw new ScheduleError('not_found', 404);
  await withTenant(actor, async (tx) => {
    const deleted = await tx.$executeRaw`DELETE FROM report_schedules WHERE account_id=${actor.accountId}::uuid AND id=${id}::uuid`;
    if (deleted === 0) throw new ScheduleError('not_found', 404);
    await audit(tx, actor, 'analytics.report_schedule_deleted', id, {});
  });
}

// ------------------------------------------------------------------ worker

const worker = (accountId: string) => ({ accountId, role: 'owner' as const });
let lastDiscovery = Number.NEGATIVE_INFINITY;

/** Called from scheduleWork: one 'analytics.report_schedules' job per workspace with a due schedule, every five minutes. */
export async function scheduleReportSchedules(now: number = Date.now(), force = false): Promise<number> {
  if (!force && now - lastDiscovery < SCHEDULE_DISCOVERY_INTERVAL_MS) return 0;
  lastDiscovery = now;
  const accounts = await getWorkerPrisma().$queryRaw<{ account_id: string }[]>`SELECT * FROM crm_accounts_with_due_report_schedules()`;
  const slot = Math.floor(now / SCHEDULE_DISCOVERY_INTERVAL_MS);
  for (const { account_id } of accounts)
    await getWorkerPrisma().$executeRaw`INSERT INTO jobs(type,tenant_id,payload,dedupe_key,max_attempts)
      VALUES(${REPORT_SCHEDULES_JOB},${account_id}::uuid,'{}'::jsonb,${`report-schedules:${account_id}:${slot}`},3)
      ON CONFLICT(dedupe_key) DO NOTHING`;
  return accounts.length;
}

export function resetReportScheduleDiscoveryForTests(): void {
  lastDiscovery = Number.NEGATIVE_INFINITY;
}

export type ScheduleOutcome = 'queued' | 'repeat' | 'paused';

/**
 * Handles one due schedule in its own transaction; null when none is due (or
 * every due one is locked by a concurrent job).
 */
async function runOneDueSchedule(accountId: string, now: Date): Promise<{ id: string; outcome: ScheduleOutcome } | null> {
  return withTenant(worker(accountId), async (tx) => {
    const due = await tx.$queryRaw<{ id: string; kind: string; format: string; cadence: ReportCadence; hour_local: number;
      minute_local: number | null; saved_report_id: string | null; created_by: string }[]>`
      SELECT id::text AS id, kind, format, cadence, hour_local, minute_local, saved_report_id::text AS saved_report_id,
        created_by::text AS created_by FROM report_schedules
      WHERE account_id=${accountId}::uuid AND paused_at IS NULL AND next_run_at <= ${now}
      ORDER BY next_run_at, id LIMIT 1 FOR UPDATE SKIP LOCKED`;
    const s = due[0];
    if (!s) return null;
    const creator = await tx.$queryRaw<{ role: string }[]>`SELECT role FROM account_memberships
      WHERE account_id=${accountId}::uuid AND user_id=${s.created_by}::uuid`;
    if (!creator[0] || !['owner', 'admin'].includes(creator[0].role)) {
      await tx.$executeRaw`UPDATE report_schedules SET paused_at=now(), pause_reason='creator_lost_access', updated_at=now()
        WHERE account_id=${accountId}::uuid AND id=${s.id}::uuid`;
      await tx.$executeRaw`INSERT INTO audit_logs(account_id,user_id,action,resource_id,metadata)
        VALUES(${accountId}::uuid,NULL,'analytics.report_schedule_paused',${s.id},${JSON.stringify({ reason: 'creator_lost_access' })}::jsonb)`;
      return { id: s.id, outcome: 'paused' as const };
    }
    const timezone = await workspaceTimezone(tx, accountId);
    const period = previousCompletePeriod(s.cadence, timezone, now);
    const params: ReportParams = { from: period.startDay, to: period.endDay, timezone };
    if (s.kind === SAVED_REPORT_KIND && s.saved_report_id) {
      // Snapshot the definition now: a later edit never changes a file already queued.
      const saved = await tx.$queryRaw<{ name: string; metrics: string[]; group_by: string; channel: string }[]>`
        SELECT name, metrics::text[] AS metrics, group_by, channel FROM analytics_saved_reports
        WHERE account_id=${accountId}::uuid AND id=${s.saved_report_id}::uuid`;
      const report = saved[0] ? parseSnapshot({ name: saved[0].name, metrics: saved[0].metrics, group: saved[0].group_by, channel: saved[0].channel }) : null;
      if (report) params.report = report;
    }
    let outcome: ScheduleOutcome = 'repeat';
    const runnable = s.kind === SAVED_REPORT_KIND ? Boolean(params.report) : isReportKind(s.kind);
    if (runnable && isRunKind(s.kind) && isReportFormat(s.format)) {
      const inserted = await tx.$queryRaw<{ id: string }[]>`INSERT INTO report_runs
        (account_id,kind,format,params,requested_by,email_requested,schedule_id)
        VALUES(${accountId}::uuid,${s.kind},${s.format},${JSON.stringify(params)}::jsonb,${s.created_by}::uuid,true,${s.id}::uuid)
        ON CONFLICT (account_id, schedule_id, (params->>'from'), (params->>'to')) WHERE schedule_id IS NOT NULL DO NOTHING
        RETURNING id::text AS id`;
      const runId = inserted[0]?.id;
      if (runId) {
        outcome = 'queued';
        await tx.$executeRaw`INSERT INTO jobs(type,tenant_id,payload,dedupe_key,max_attempts)
          VALUES(${REPORT_JOB},${accountId}::uuid,${JSON.stringify({ reportId: runId, scheduled: true })}::jsonb,${`analytics-report:${runId}`},3)
          ON CONFLICT(dedupe_key) DO NOTHING`;
        await tx.$executeRaw`UPDATE report_schedules SET last_run_id=${runId}::uuid WHERE account_id=${accountId}::uuid AND id=${s.id}::uuid`;
      }
    }
    await tx.$executeRaw`UPDATE report_schedules SET next_run_at=${nextRunAt(s.cadence, s.hour_local, timezone, now, s.minute_local ?? 0)}, updated_at=now()
      WHERE account_id=${accountId}::uuid AND id=${s.id}::uuid`;
    return { id: s.id, outcome };
  }, getWorkerPrisma());
}

/** The 'analytics.report_schedules' job: every due schedule of one workspace (bounded per job). */
export async function runReportSchedules(accountId: string, now: Date = new Date()): Promise<{ id: string; outcome: ScheduleOutcome }[]> {
  const results: { id: string; outcome: ScheduleOutcome }[] = [];
  for (let i = 0; i < SCHEDULES_PER_JOB; i++) {
    const result = await runOneDueSchedule(accountId, now);
    if (!result) break;
    results.push(result);
  }
  return results;
}
