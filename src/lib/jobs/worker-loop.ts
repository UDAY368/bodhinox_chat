import { withLeaseScope } from './lease';
import { claimJob, finishJob, heartbeat as extendLease, type Job, type JobLane } from './queue';
import { startWorkerHeartbeat, type HeartbeatHandle, type HeartbeatState } from './heartbeat';

/**
 * The worker's claim/handle/finish loops (Phase 15: extracted from worker.ts, which keeps the dotenv
 * bootstrap and the process signal wiring). WORKER_CONCURRENCY job slots run side by side: one
 * 'main' slot takes every short job one at a time, in run_at order as before (so inbound messages of
 * a conversation are still handled in order), and the other slots take only the long-running
 * BULK_JOB_TYPES, so a campaign pass never holds up inbound work. WORKER_CONCURRENCY=1 is the old
 * single lane. Scheduling runs on its own timer, not between jobs.
 *
 * Stopping is cooperative: once `signal` aborts, no new job is claimed, in-flight jobs are given up
 * to `drainMs` to finish, and if one does not, the loop returns and that job's 90 s lease covers the
 * rest (it is reclaimed, never lost).
 */
export type JobHandler = (job: Job, assertLease: () => void) => Promise<void>;
export interface WorkerLoopOptions {
  signal: AbortSignal;
  /** Wait when no job is due. Default 1000 ms; an abort ends the wait at once. */
  idleMs?: number;
  /** Upper bound for the in-flight job after abort. Default WORKER_DRAIN_MS or 25 000 ms. */
  drainMs?: number;
  /** Default 30 000 ms, as before. */
  scheduleEveryMs?: number;
  /** Job slots. Default WORKER_CONCURRENCY or 3; 1 is a single lane taking every job type. */
  concurrency?: number;
  /** Default: handleJob from ./handlers, imported lazily (after the caller's dotenv load). */
  handleJob?: JobHandler;
  /** Default: scheduleWork from ./handlers. null skips scheduling (tests). */
  scheduleWork?: (() => Promise<void>) | null;
  /** Called after each scheduling pass, e.g. the ops alert check. Errors are swallowed. */
  afterSchedule?: () => Promise<unknown>;
  /** Default true: write worker_heartbeats every heartbeatEveryMs (15 000 ms). */
  heartbeat?: boolean;
  heartbeatEveryMs?: number;
  workerId?: string;
}
export interface WorkerLoopResult {
  /** Jobs claimed and finished (successfully or not) by this loop. */
  processed: number;
  /** false when the drain bound elapsed with a job still running (its lease will expire). */
  drained: boolean;
}

const DEFAULT_DRAIN_MS = 25_000;
const DEFAULT_CONCURRENCY = 3;
const MAX_CONCURRENCY = 16;
const LEASE_EXTEND_MS = 20_000;

/** WORKER_DRAIN_MS when it is a positive integer up to 10 minutes, else 25 s. */
export function workerDrainMs(env: Record<string, string | undefined> = process.env): number {
  const raw = env.WORKER_DRAIN_MS?.trim();
  const value = raw && /^\d+$/.test(raw) ? Number(raw) : NaN;
  return value > 0 && value <= 600_000 ? value : DEFAULT_DRAIN_MS;
}

/**
 * WORKER_CONCURRENCY when it is an integer from 1 to 16, else 3: one main slot plus two for
 * long-running jobs. Each slot holds at most one database connection at a time, so keep it below
 * DB_POOL_SIZE (default 10).
 */
export function workerConcurrency(env: Record<string, string | undefined> = process.env): number {
  const raw = env.WORKER_CONCURRENCY?.trim();
  const value = raw && /^\d+$/.test(raw) ? Number(raw) : NaN;
  return value >= 1 && value <= MAX_CONCURRENCY ? value : DEFAULT_CONCURRENCY;
}

/** One lane for every job at concurrency 1; otherwise one main slot and the rest for bulk jobs. */
export function workerLanes(concurrency: number): JobLane[] {
  if (concurrency <= 1) return ['all'];
  return ['main', ...Array.from({ length: concurrency - 1 }, () => 'bulk' as const)];
}

function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => { clearTimeout(timer); signal.removeEventListener('abort', done); resolve(); };
    const timer = setTimeout(done, ms);
    signal.addEventListener('abort', done, { once: true });
  });
}

/** Resolves true when `work` settles, false when the drain bound passes after an abort first. */
function settleWithinDrain(work: Promise<void>, signal: AbortSignal, drainMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const startDrain = () => { timer = setTimeout(() => resolve(false), drainMs); };
    if (signal.aborted) startDrain(); else signal.addEventListener('abort', startDrain, { once: true });
    void work.then(() => resolve(true), () => resolve(true)).finally(() => {
      if (timer) clearTimeout(timer);
      signal.removeEventListener('abort', startDrain);
    });
  });
}

async function runJob(job: Job, handleJob: JobHandler): Promise<void> {
  let leaseLost = false;
  const timer = setInterval(() => {
    void extendLease(job).then((count) => { if (!count) leaseLost = true; }).catch(() => { leaseLost = true; });
  }, LEASE_EXTEND_MS);
  try {
    const assertLease = () => { if (leaseLost) throw new Error('Job lease lost'); };
    await withLeaseScope(assertLease, () => handleJob(job, assertLease));
    await finishJob(job);
  } catch (error) {
    console.error('[worker] job failed', { id: job.id, type: job.type, category: error instanceof Error ? error.name : 'Error' });
    await finishJob(job, error);
  } finally { clearInterval(timer); }
}

export async function runWorkerLoop(options: WorkerLoopOptions): Promise<WorkerLoopResult> {
  const idleMs = options.idleMs ?? 1000;
  const drainMs = options.drainMs ?? workerDrainMs();
  const scheduleEveryMs = options.scheduleEveryMs ?? 30_000;
  let handleJob = options.handleJob;
  let scheduleWork = options.scheduleWork;
  if (!handleJob || scheduleWork === undefined) {
    // Modules that capture provider settings load only now, after the caller's dotenv load.
    const handlers = await import('./handlers');
    handleJob ??= handlers.handleJob;
    if (scheduleWork === undefined) scheduleWork = handlers.scheduleWork;
  }
  const handle = handleJob;
  // Stops every slot when the caller aborts, or when one slot fails (database unavailable).
  const stop = new AbortController();
  const signal = stop.signal;
  const forward = () => stop.abort();
  if (options.signal.aborted) stop.abort(); else options.signal.addEventListener('abort', forward, { once: true });

  const running = new Map<number, string>();
  const state: HeartbeatState = { currentJobType: null, scheduleFailures: 0 };
  const showRunning = () => { state.currentJobType = running.size ? [...new Set(running.values())].join(',').slice(0, 200) : null; };
  const beat: HeartbeatHandle | null = options.heartbeat === false ? null
    : startWorkerHeartbeat({ workerId: options.workerId, everyMs: options.heartbeatEveryMs, state: () => state });
  let processed = 0;

  const schedule = async () => {
    if (!scheduleWork) return;
    while (!signal.aborted) {
      try { await scheduleWork(); } catch { state.scheduleFailures += 1; console.error('[worker] scheduling failed'); }
      if (options.afterSchedule) await options.afterSchedule().catch(() => undefined);
      await abortableDelay(scheduleEveryMs, signal);
    }
  };

  /** Resolves false when the drain bound passed with a job still running. */
  const slot = async (lane: JobLane, index: number): Promise<boolean> => {
    while (!signal.aborted) {
      const job = await claimJob(lane);
      if (!job) { await abortableDelay(idleMs, signal); continue; }
      running.set(index, job.type); showRunning();
      const work = runJob(job, handle);
      const settled = await settleWithinDrain(work, signal, drainMs);
      if (!settled) {
        console.error('[worker] drain bound reached with a job still running; its lease will expire and it will be reclaimed');
        return false;
      }
      // runJob rethrows only when finishJob itself fails (database unavailable), as before the extraction.
      await work;
      running.delete(index); showRunning();
      processed += 1;
    }
    return true;
  };

  try {
    const lanes = workerLanes(options.concurrency ?? workerConcurrency());
    // A scheduling pass is short; after an abort it is awaited only up to the drain bound.
    const scheduler = schedule();
    const slots = lanes.map((lane, index) => slot(lane, index).catch((error: unknown) => { stop.abort(); throw error; }));
    const results = await Promise.allSettled(slots);
    await settleWithinDrain(scheduler, signal, drainMs);
    const failure = results.find((r): r is PromiseRejectedResult => r.status === 'rejected');
    if (failure) throw failure.reason;
    return { processed, drained: results.every((r) => r.status === 'fulfilled' && r.value) };
  } finally {
    options.signal.removeEventListener('abort', forward);
    await beat?.stop();
  }
}
