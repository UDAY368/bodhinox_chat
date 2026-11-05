import { createHash, timingSafeEqual } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { getPlatformPrisma, getPrisma, platformDatabaseConfigured } from '@/lib/db/prisma';

/**
 * Operations health (Phase 15). One row of scalars from crm_ops_health() (SECURITY DEFINER, executable
 * by the platform and worker roles only), turned into ok / degraded / down with env thresholds.
 * Counts and ages only: no ids, tenant data, error messages, hostnames or configuration values.
 */
export interface OpsHealthRow {
  lastBeatAgeS: number | null;
  pendingDue: number;
  oldestDueAgeS: number | null;
  expiredRunningLeases: number;
  failedJobs1h: number;
  unknownIntents: number;
  unprocessedWebhooks15m: number;
  latestMigration: string | null;
}
export interface HealthThresholds {
  /** Newest worker heartbeat older than this (or none) = down. HEALTH_WORKER_DOWN_S, default 90. */
  workerDownS: number;
  /** Oldest due pending job older than this = degraded. HEALTH_OLDEST_DUE_DEGRADED_S, default 300. */
  oldestDueDegradedS: number;
  /** More unknown outbound intents than this = degraded. HEALTH_UNKNOWN_INTENTS_DEGRADED, default 0. */
  unknownIntentsDegraded: number;
}
export type HealthStatus = 'ok' | 'degraded' | 'down';
export interface DeepHealth {
  status: HealthStatus;
  checks: {
    appDb: boolean;
    /** 'unconfigured' = PLATFORM_DATABASE_URL unset; 'unavailable' = the ops query failed or timed out. */
    ops: 'ok' | 'unconfigured' | 'unavailable';
    worker: { ageS: number | null; ok: boolean } | null;
    queue: { pendingDue: number; oldestDueS: number | null; expiredLeases: number; failed1h: number } | null;
    intents: { unknown: number } | null;
    webhooks: { unprocessed15m: number } | null;
    migrations: { latest: string | null } | null;
  };
}

const DEFAULTS: HealthThresholds = { workerDownS: 90, oldestDueDegradedS: 300, unknownIntentsDegraded: 0 };
const STATEMENT_TIMEOUT_MS = 2000;

function nonNegativeInt(raw: string | undefined, fallback: number): number {
  const value = raw?.trim();
  return value && /^\d{1,9}$/.test(value) ? Number(value) : fallback;
}
export function healthThresholds(env: Record<string, string | undefined> = process.env): HealthThresholds {
  return {
    workerDownS: nonNegativeInt(env.HEALTH_WORKER_DOWN_S, DEFAULTS.workerDownS),
    oldestDueDegradedS: nonNegativeInt(env.HEALTH_OLDEST_DUE_DEGRADED_S, DEFAULTS.oldestDueDegradedS),
    unknownIntentsDegraded: nonNegativeInt(env.HEALTH_UNKNOWN_INTENTS_DEGRADED, DEFAULTS.unknownIntentsDegraded),
  };
}

/** The deep check needs HEALTH_TOKEN of at least this many characters; shorter = deep mode off. */
export const MIN_HEALTH_TOKEN_LENGTH = 32;
const digest = (value: string) => createHash('sha256').update(value, 'utf8').digest();
/** Constant-time, length-independent comparison of `Authorization: Bearer <token>` with HEALTH_TOKEN. */
export function deepHealthAuthorized(authorization: string | null | undefined,
  token: string | undefined = process.env.HEALTH_TOKEN): boolean {
  const expected = token?.trim();
  if (!expected || expected.length < MIN_HEALTH_TOKEN_LENGTH || !authorization) return false;
  const match = /^Bearer\s+(\S+)\s*$/i.exec(authorization);
  if (!match) return false;
  return timingSafeEqual(digest(match[1]), digest(expected));
}

const num = (value: unknown): number => (value === null || value === undefined ? 0 : Number(value));
const age = (value: unknown): number | null => (value === null || value === undefined ? null : Math.max(0, Math.round(Number(value))));

/** Reads crm_ops_health() with a 2 s statement timeout. `db` is the platform (web) or worker role. */
export async function readOpsHealth(db: PrismaClient): Promise<OpsHealthRow> {
  const rows = await db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT set_config('statement_timeout', ${String(STATEMENT_TIMEOUT_MS)}, true)`;
    return tx.$queryRaw<Record<string, unknown>[]>`SELECT * FROM crm_ops_health()`;
  }, { maxWait: STATEMENT_TIMEOUT_MS, timeout: STATEMENT_TIMEOUT_MS + 1000 });
  const row = rows[0] ?? {};
  return {
    lastBeatAgeS: age(row.last_beat_age_s),
    pendingDue: num(row.pending_due),
    oldestDueAgeS: age(row.oldest_due_age_s),
    expiredRunningLeases: num(row.expired_running_leases),
    failedJobs1h: num(row.failed_jobs_1h),
    unknownIntents: num(row.unknown_intents),
    unprocessedWebhooks15m: num(row.unprocessed_webhooks_15m),
    latestMigration: typeof row.latest_migration === 'string' ? row.latest_migration.slice(0, 200) : null,
  };
}

export function evaluateOpsHealth(appDb: boolean, ops: OpsHealthRow | 'unconfigured' | 'unavailable',
  thresholds: HealthThresholds = healthThresholds()): DeepHealth {
  if (typeof ops === 'string') {
    return { status: appDb ? 'degraded' : 'down',
      checks: { appDb, ops, worker: null, queue: null, intents: null, webhooks: null, migrations: null } };
  }
  const workerOk = ops.lastBeatAgeS !== null && ops.lastBeatAgeS <= thresholds.workerDownS;
  const backlog = ops.oldestDueAgeS !== null && ops.oldestDueAgeS > thresholds.oldestDueDegradedS;
  const unknown = ops.unknownIntents > thresholds.unknownIntentsDegraded;
  // A webhook receipt still unprocessed after 15 minutes means inbound messages are missing even when
  // its job has already exhausted to `failed` and nothing stays due.
  const webhooks = ops.unprocessedWebhooks15m > 0;
  const status: HealthStatus = !appDb || !workerOk ? 'down' : backlog || unknown || webhooks ? 'degraded' : 'ok';
  return {
    status,
    checks: {
      appDb,
      ops: 'ok',
      worker: { ageS: ops.lastBeatAgeS, ok: workerOk },
      queue: { pendingDue: ops.pendingDue, oldestDueS: ops.oldestDueAgeS, expiredLeases: ops.expiredRunningLeases, failed1h: ops.failedJobs1h },
      intents: { unknown: ops.unknownIntents },
      webhooks: { unprocessed15m: ops.unprocessedWebhooks15m },
      migrations: { latest: ops.latestMigration },
    },
  };
}

/** The application database probe the plain liveness check has always used. */
export async function appDatabaseReachable(db: PrismaClient = getPrisma()): Promise<boolean> {
  try { await db.$queryRaw`SELECT bot_paused FROM conversations LIMIT 0`; return true; } catch { return false; }
}

export async function deepHealth(): Promise<DeepHealth> {
  const [appDb, ops] = await Promise.all([
    appDatabaseReachable(),
    platformDatabaseConfigured()
      ? readOpsHealth(getPlatformPrisma()).catch(() => 'unavailable' as const)
      : Promise.resolve('unconfigured' as const),
  ]);
  return evaluateOpsHealth(appDb, ops);
}
