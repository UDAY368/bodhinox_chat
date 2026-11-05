import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { getWorkerPrisma } from '@/lib/db/prisma';

/**
 * Worker liveness (Phase 15). One worker_heartbeats row per worker process, written at start and
 * every 15 s from a timer that does not depend on job execution, so a long job never looks like a
 * dead worker. crm_ops_health() reports the newest beat's age to the deep health check and alerts.
 * The row holds no tenant data: a process id, the deployed release and the running job's type.
 */
export interface HeartbeatState { currentJobType: string | null; scheduleFailures: number }
export interface HeartbeatRow extends HeartbeatState { workerId: string; startedAt: Date; release: string | null }
export type HeartbeatWriter = (row: HeartbeatRow) => Promise<void>;

const MAX_TEXT = 200;
const clip = (value: string | null | undefined) => (value ? value.slice(0, MAX_TEXT) : null);

/** The deployed release Railway exposes (commit first), or null outside Railway. */
export function workerRelease(env: Record<string, string | undefined> = process.env): string | null {
  return clip(env.RAILWAY_GIT_COMMIT_SHA?.trim() || env.RAILWAY_DEPLOYMENT_ID?.trim() || null);
}

/** A stable id per Railway replica (so restarts reuse one row), else a random id per process. */
export function defaultWorkerId(env: Record<string, string | undefined> = process.env): string {
  const replica = env.RAILWAY_REPLICA_ID?.trim();
  return clip(replica ? `railway-replica:${replica}` : `worker:${randomUUID()}`)!;
}

export function writeWorkerHeartbeat(db: PrismaClient = getWorkerPrisma()): HeartbeatWriter {
  return async (row) => {
    await db.$executeRaw`
      INSERT INTO worker_heartbeats(worker_id,started_at,beat_at,release,current_job_type,schedule_failures)
      VALUES(${row.workerId},${row.startedAt},NOW(),${clip(row.release)},${clip(row.currentJobType)},${Math.max(0, Math.trunc(row.scheduleFailures))})
      ON CONFLICT(worker_id) DO UPDATE SET started_at=EXCLUDED.started_at,beat_at=NOW(),release=EXCLUDED.release,
        current_job_type=EXCLUDED.current_job_type,schedule_failures=EXCLUDED.schedule_failures`;
  };
}

export interface HeartbeatOptions {
  workerId?: string;
  release?: string | null;
  everyMs?: number;
  state: () => HeartbeatState;
  write?: HeartbeatWriter;
  now?: () => number;
  log?: (message: string) => void;
}
export interface HeartbeatHandle { beat(): Promise<boolean>; stop(): Promise<void>; readonly workerId: string }

const FAILURE_LOG_EVERY_MS = 60_000;

/**
 * Starts the heartbeat timer. A failed write (database down, or code running before its migration)
 * is logged at most once a minute, without the error text, and never stops the worker.
 */
export function startWorkerHeartbeat(options: HeartbeatOptions): HeartbeatHandle {
  const workerId = options.workerId ?? defaultWorkerId();
  const release = options.release === undefined ? workerRelease() : options.release;
  const write = options.write ?? writeWorkerHeartbeat();
  const now = options.now ?? Date.now;
  const log = options.log ?? ((message: string) => console.error(message));
  const startedAt = new Date(now());
  let lastFailureLog = -Infinity;
  let inFlight: Promise<boolean> | null = null;
  let stopped = false;

  const beat = (): Promise<boolean> => {
    if (inFlight) return inFlight; // never stack writes behind a slow database
    const state = options.state();
    inFlight = write({ workerId, startedAt, release, currentJobType: state.currentJobType, scheduleFailures: state.scheduleFailures })
      .then(() => true, () => {
        if (now() - lastFailureLog >= FAILURE_LOG_EVERY_MS) {
          lastFailureLog = now();
          log('[worker] heartbeat write failed; the worker keeps running');
        }
        return false;
      })
      .finally(() => { inFlight = null; });
    return inFlight;
  };

  void beat();
  const timer = setInterval(() => { if (!stopped) void beat(); }, options.everyMs ?? 15_000);
  // The heartbeat must never keep a stopping or crashed worker process alive.
  timer.unref?.();
  return {
    workerId,
    beat,
    async stop() {
      stopped = true;
      clearInterval(timer);
      if (inFlight) await inFlight;
    },
  };
}
