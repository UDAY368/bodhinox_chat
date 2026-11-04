// Reads for the run history and run detail pages (Phase 12, design §3.2).
// Member transactions only (RLS scopes every row to the workspace); the
// contact's number is masked for a masked member by the caller.
import { Prisma } from '@prisma/client';
import type { TenantTransaction } from '@/lib/db/tenant';
import { isUuid } from './versions';

export const RUNS_PAGE_SIZE = 50;
export const RUN_STATUSES = ['active', 'completed', 'handed_off', 'timed_out', 'paused_by_agent', 'cancelled', 'failed'] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

export interface RunListFilter {
  status?: RunStatus;
  /** A version id, or 'none' for runs not pinned to a version. */
  version?: string;
  /** Keyset cursor: runs started before this (started_at, id). */
  before?: { startedAt: string; id: string };
}

/** Parses ?status=&version=&before=<iso>,<uuid>; null when a value is malformed. */
export function parseRunListFilter(params: URLSearchParams): RunListFilter | null {
  const filter: RunListFilter = {};
  const status = params.get('status');
  if (status) {
    if (!(RUN_STATUSES as readonly string[]).includes(status)) return null;
    filter.status = status as RunStatus;
  }
  const version = params.get('version');
  if (version) {
    if (version !== 'none' && !isUuid(version)) return null;
    filter.version = version;
  }
  const before = params.get('before');
  if (before) {
    const [startedAt, id, extra] = before.split(',');
    if (extra !== undefined || !id || !isUuid(id) || !CURSOR_TIME.test(startedAt ?? '') || Number.isNaN(Date.parse(startedAt))) return null;
    filter.before = { startedAt, id };
  }
  return filter;
}

// Microsecond precision: a millisecond cursor would skip runs started within the same millisecond.
const CURSOR_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?Z$/;
export const cursorOf = (row: { cursor_at: string; id: string }): string => `${row.cursor_at},${row.id}`;

export interface RunRow {
  id: string;
  status: string;
  current_node_key: string | null;
  started_at: Date | string;
  last_advanced_at: Date | string;
  ended_at: Date | string | null;
  end_reason: string | null;
  vars: Record<string, unknown>;
  reprompt_count: number;
  transition_seq: number;
  flow_version_id: string | null;
  version: number | null;
  contact: { id: string; name: string | null; phone: string | null } | null;
  /** started_at in UTC with microseconds, for the keyset cursor. */
  cursor_at: string;
}

/** A run row as the browser gets it: without the internal cursor column. */
export function publicRun(run: RunRow): Omit<RunRow, 'cursor_at'> {
  const out: Partial<RunRow> = { ...run };
  delete out.cursor_at;
  return out as Omit<RunRow, 'cursor_at'>;
}

const RUN_COLUMNS = Prisma.sql`r.id::text, r.status, r.current_node_key, r.started_at, r.last_advanced_at, r.ended_at, r.end_reason,
  r.vars, r.reprompt_count, r.transition_seq, r.flow_version_id::text, v.version,
  CASE WHEN c.id IS NULL THEN NULL ELSE jsonb_build_object('id', c.id::text, 'name', c.name, 'phone', c.phone) END AS contact,
  to_char(r.started_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_at`;
const RUN_JOINS = Prisma.sql`LEFT JOIN contacts c ON c.account_id=r.account_id AND c.id=r.contact_id
  LEFT JOIN flow_versions v ON v.account_id=r.account_id AND v.id=r.flow_version_id`;

export async function readFlowSummary(tx: TenantTransaction, accountId: string, flowId: string):
  Promise<{ id: string; name: string; status: string } | null> {
  const rows = await tx.$queryRaw<Array<{ id: string; name: string; status: string }>>(Prisma.sql`SELECT id::text, name, status
    FROM flows WHERE account_id=${accountId}::uuid AND id=${flowId}::uuid`);
  return rows[0] ?? null;
}

/** One page of a flow's runs, newest first, plus the cursor of the next page. */
export async function listRuns(tx: TenantTransaction, accountId: string, flowId: string, filter: RunListFilter):
  Promise<{ runs: RunRow[]; next_cursor: string | null }> {
  const where: Prisma.Sql[] = [Prisma.sql`r.account_id=${accountId}::uuid`, Prisma.sql`r.flow_id=${flowId}::uuid`];
  if (filter.status) where.push(Prisma.sql`r.status=${filter.status}`);
  if (filter.version === 'none') where.push(Prisma.sql`r.flow_version_id IS NULL`);
  else if (filter.version) where.push(Prisma.sql`r.flow_version_id=${filter.version}::uuid`);
  if (filter.before) where.push(Prisma.sql`(r.started_at, r.id) < (${filter.before.startedAt}::timestamptz, ${filter.before.id}::uuid)`);
  const rows = await tx.$queryRaw<RunRow[]>(Prisma.sql`SELECT ${RUN_COLUMNS} FROM flow_runs r ${RUN_JOINS}
    WHERE ${Prisma.join(where, ' AND ')}
    ORDER BY r.started_at DESC, r.id DESC LIMIT ${RUNS_PAGE_SIZE + 1}`);
  const runs = rows.slice(0, RUNS_PAGE_SIZE);
  return { runs, next_cursor: rows.length > RUNS_PAGE_SIZE ? cursorOf(runs[runs.length - 1]) : null };
}

export async function readRunRow(tx: TenantTransaction, accountId: string, flowId: string, runId: string): Promise<RunRow | null> {
  const rows = await tx.$queryRaw<RunRow[]>(Prisma.sql`SELECT ${RUN_COLUMNS} FROM flow_runs r ${RUN_JOINS}
    WHERE r.account_id=${accountId}::uuid AND r.flow_id=${flowId}::uuid AND r.id=${runId}::uuid`);
  return rows[0] ?? null;
}

export interface RunEventRow {
  flow_run_id: string;
  event_type: string;
  node_key: string | null;
  payload: Record<string, unknown>;
  created_at: Date | string;
}

export async function readRunEvents(tx: TenantTransaction, accountId: string, runIds: string[], limit: number): Promise<RunEventRow[]> {
  if (!runIds.length) return [];
  return tx.$queryRaw<RunEventRow[]>(Prisma.sql`SELECT flow_run_id::text, event_type, node_key, payload, created_at
    FROM flow_run_events WHERE account_id=${accountId}::uuid AND flow_run_id = ANY(${runIds}::uuid[])
    ORDER BY created_at, id LIMIT ${limit}`);
}

export async function readVersionNumbers(tx: TenantTransaction, accountId: string, flowId: string): Promise<Array<{ id: string; version: number }>> {
  return tx.$queryRaw<Array<{ id: string; version: number }>>(Prisma.sql`SELECT id::text, version FROM flow_versions
    WHERE account_id=${accountId}::uuid AND flow_id=${flowId}::uuid ORDER BY version DESC`);
}
