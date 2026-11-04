// Insight runs, member side: request one, list and read them.
//
// A request is recorded (ai_insight_runs, status 'queued', no data) and its
// worker job 'ai.insight_run' is inserted in the same transaction, so it is
// durable before the 202. At most MAX_PENDING_INSIGHTS runs per workspace are
// queued or running at once (advisory lock, as reports do); a run still
// queued or running after STALE_INSIGHT_MINUTES (its job was lost to a worker
// crash on the last attempt) is marked failed ('stale') and no longer counts,
// so orphans never block a workspace. Requesting needs
// agent or above, the 'ai.insights' permission (checked by the route), the
// insight's own minimum role and the workspace's insights switch; the worker
// rechecks the requester's live membership before running. Members see their
// own runs, admins see all (RLS read_own_or_admin).

import { Prisma } from '@prisma/client';
import type { AccountRole } from '@/lib/auth/roles';
import { withTenant, type TenantTransaction } from '@/lib/db/tenant';
import { getWorkerPrisma } from '@/lib/db/prisma';
import { AnalyticsRangeError, parseRange, workspaceTimezone, type RangeInput } from '@/lib/analytics/range';
import { readAiSettings } from '../settings';
import { AI_INSIGHT_JOB, insightJobDedupeKey } from './job';
import {
  insightAllowed, isInsightKey, type CaveatCode, type InsightCoverage, type InsightData, type InsightKey, type Uncertainty,
} from './registry';

export const MAX_PENDING_INSIGHTS = 3;
/** A run queued or running longer than this is an orphan (its job is gone). */
export const STALE_INSIGHT_MINUTES = 30;
export const INSIGHT_LIST_LIMIT = 20;
export const INSIGHT_JOB_MAX_ATTEMPTS = 2;

export type InsightStatus = 'queued' | 'running' | 'done' | 'skipped' | 'failed';
export const TERMINAL_INSIGHT_STATUSES: readonly InsightStatus[] = ['done', 'skipped', 'failed'];

export interface InsightRunView {
  id: string;
  key: InsightKey;
  from: string;
  to: string;
  status: InsightStatus;
  data: InsightData | null;
  coverage: InsightCoverage | null;
  caveats: CaveatCode[];
  uncertainty: Uncertainty | null;
  narrative: string | null;
  narrativeSource: 'model' | 'template' | null;
  guardFlags: string[];
  sourceLinks: { key: string; href: string }[];
  /** Why the model was not used, or why the run was skipped or failed (a reason code, never text). */
  errorCode: string | null;
  mine: boolean;
  createdAt: string;
  completedAt: string | null;
}

export type InsightErrorCode = 'invalid_key' | 'invalid_range' | 'forbidden' | 'feature_off' | 'too_many_pending' | 'not_found';
const STATUS: Record<InsightErrorCode, number> = {
  invalid_key: 400, invalid_range: 400, forbidden: 403, feature_off: 409, too_many_pending: 429, not_found: 404,
};

export class InsightError extends Error {
  readonly status: number;
  constructor(readonly code: InsightErrorCode) {
    super(`Insight request refused: ${code}`);
    this.name = 'InsightError';
    this.status = STATUS[code];
  }
}

export interface InsightActor {
  accountId: string;
  userId: string;
  role: AccountRole;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type RunRow = {
  id: string; insight_key: InsightKey; range_from: string; range_to: string; status: InsightStatus;
  data: InsightData | null; coverage: InsightCoverage | null; caveats: string[]; uncertainty: Uncertainty | null;
  narrative: string | null; narrative_source: 'model' | 'template' | null; guard_flags: string[];
  source_links: unknown; error_code: string | null; requested_by: string; created_at: Date; completed_at: Date | null;
};

const RUN_COLUMNS = Prisma.sql`id::text AS id, insight_key, range_from::text AS range_from, range_to::text AS range_to, status,
  data, coverage, caveats, uncertainty, narrative, narrative_source, guard_flags, source_links, error_code,
  requested_by::text AS requested_by, created_at, completed_at`;

function sourceLinks(value: unknown): { key: string; href: string }[] {
  if (!Array.isArray(value)) return [];
  // Only same-site paths are ever stored; anything else is dropped.
  return value.filter((l): l is { key: string; href: string } =>
    !!l && typeof l === 'object' && typeof (l as { key?: unknown }).key === 'string'
    && typeof (l as { href?: unknown }).href === 'string' && /^\/[a-z0-9/_?=&-]*$/i.test((l as { href: string }).href));
}

export function toInsightRunView(row: RunRow, userId: string): InsightRunView {
  return {
    id: row.id, key: row.insight_key, from: row.range_from, to: row.range_to, status: row.status,
    data: row.data, coverage: row.coverage, caveats: (row.caveats ?? []) as CaveatCode[], uncertainty: row.uncertainty,
    narrative: row.narrative, narrativeSource: row.narrative_source, guardFlags: row.guard_flags ?? [],
    sourceLinks: sourceLinks(row.source_links), errorCode: row.error_code, mine: row.requested_by === userId,
    createdAt: row.created_at.toISOString(), completedAt: row.completed_at ? row.completed_at.toISOString() : null,
  };
}

async function readRun(tx: TenantTransaction, accountId: string, id: string): Promise<RunRow | null> {
  const rows = await tx.$queryRaw<RunRow[]>(Prisma.sql`SELECT ${RUN_COLUMNS} FROM ai_insight_runs
    WHERE account_id=${accountId}::uuid AND id=${id}::uuid`);
  return rows[0] ?? null;
}

/**
 * Marks this workspace's orphaned runs failed ('stale'). Members cannot
 * update runs, so this runs on the worker role in the workspace's tenant
 * scope. Best-effort: the pending count ignores stale rows anyway.
 */
async function expireStaleInsightRuns(accountId: string): Promise<void> {
  try {
    await withTenant({ accountId, role: 'owner' }, (tx) => tx.$executeRaw`UPDATE ai_insight_runs
      SET status='failed', error_code='stale', completed_at=now()
      WHERE account_id=${accountId}::uuid AND status IN ('queued','running')
        AND created_at < now() - make_interval(mins => ${STALE_INSIGHT_MINUTES})`, getWorkerPrisma());
  } catch {
    // The count below already ignores stale runs.
  }
}

/**
 * Records a request and queues its job in one transaction. The range is
 * resolved now in the workspace timezone (at most 366 days). Throws InsightError.
 */
export async function requestInsight(actor: InsightActor, input: { key: unknown; range: RangeInput }): Promise<InsightRunView> {
  if (!isInsightKey(input.key)) throw new InsightError('invalid_key');
  const key = input.key;
  if (!insightAllowed(actor.role, key)) throw new InsightError('forbidden');
  await expireStaleInsightRuns(actor.accountId);
  return withTenant(actor, async (tx) => {
    if (!(await readAiSettings(tx, actor.accountId)).insights_enabled) throw new InsightError('feature_off');
    const timezone = await workspaceTimezone(tx, actor.accountId);
    let from: string, to: string;
    try {
      const range = parseRange(input.range, timezone);
      from = range.startDay;
      to = range.endDay;
    } catch (error) {
      if (error instanceof AnalyticsRangeError) throw new InsightError('invalid_range');
      throw error;
    }
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`ai-insights:${actor.accountId}`}, 0))`;
    const pending = await tx.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM ai_insight_runs
      WHERE account_id=${actor.accountId}::uuid AND status IN ('queued','running')
        AND created_at >= now() - make_interval(mins => ${STALE_INSIGHT_MINUTES})`;
    if ((pending[0]?.n ?? 0) >= MAX_PENDING_INSIGHTS) throw new InsightError('too_many_pending');
    const inserted = await tx.$queryRaw<{ id: string }[]>`INSERT INTO ai_insight_runs(account_id, requested_by, insight_key, range_from, range_to)
      VALUES (${actor.accountId}::uuid, ${actor.userId}::uuid, ${key}, ${from}::date, ${to}::date) RETURNING id::text AS id`;
    const id = inserted[0].id;
    await tx.$executeRaw`INSERT INTO jobs(type, tenant_id, payload, dedupe_key, max_attempts)
      VALUES (${AI_INSIGHT_JOB}, ${actor.accountId}::uuid, ${JSON.stringify({ runId: id })}::jsonb, ${insightJobDedupeKey(id)}, ${INSIGHT_JOB_MAX_ATTEMPTS})`;
    await tx.$executeRaw`INSERT INTO audit_logs(account_id, user_id, action, resource_id, metadata)
      VALUES (${actor.accountId}::uuid, ${actor.userId}::uuid, 'ai.insight_requested', ${id}, ${JSON.stringify({ key, from, to })}::jsonb)`;
    const row = await readRun(tx, actor.accountId, id);
    if (!row) throw new InsightError('not_found');
    return toInsightRunView(row, actor.userId);
  });
}

/** The caller's latest runs (an admin sees everyone's), newest first. */
export async function listInsightRuns(actor: InsightActor, limit = INSIGHT_LIST_LIMIT): Promise<InsightRunView[]> {
  const n = Math.max(1, Math.min(INSIGHT_LIST_LIMIT, Math.floor(limit)));
  const rows = await withTenant(actor, (tx) => tx.$queryRaw<RunRow[]>(Prisma.sql`SELECT ${RUN_COLUMNS} FROM ai_insight_runs
    WHERE account_id=${actor.accountId}::uuid ORDER BY created_at DESC, id LIMIT ${n}`));
  return rows.map((r) => toInsightRunView(r, actor.userId));
}

/** One run the caller may read (RLS: their own, or any for an admin). */
export async function getInsightRun(actor: InsightActor, id: string): Promise<InsightRunView> {
  if (!UUID.test(id)) throw new InsightError('not_found');
  const row = await withTenant(actor, (tx) => readRun(tx, actor.accountId, id));
  if (!row) throw new InsightError('not_found');
  return toInsightRunView(row, actor.userId);
}

/** Whether the workspace's insights switch is on (any member may know). */
export async function insightsEnabled(actor: InsightActor): Promise<boolean> {
  return withTenant(actor, async (tx) => (await readAiSettings(tx, actor.accountId)).insights_enabled);
}
