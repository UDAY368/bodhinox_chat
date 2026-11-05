import { withLeaseScope } from './lease';
import { claimJob, finishJob, heartbeat as extendLease, type Job } from './queue';
import { startWorkerHeartbeat, type HeartbeatHandle, type HeartbeatState } from './heartbeat';

/**
 * The worker's claim/handle/finish loop (Phase 15: extracted from worker.ts, which keeps the dotenv
 * bootstrap and the process signal wiring). Stopping is cooperative: once `signal` aborts, no new
 * job is claimed, the in-flight job is given up to `drainMs` to finish, and if it does not, the
 * loop returns and the job's 90 s lease covers the rest (it is reclaimed, never lost).
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
const LEASE_EXTEND_MS = 20_000;

/** WORKER_DRAIN_MS when it is a positive integer up to 10 minutes, else 25 s. */
export function workerDrainMs(env: Record<string, string | undefined> = process.env): number {
  const raw = env.WORKER_DRAIN_MS?.trim();
  const value = raw && /^\d+$/.test(raw) ? Number(raw) : NaN;
  return value > 0 && value <= 600_000 ? value : DEFAULT_DRAIN_MS;
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
  const { signal } = options;
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

  const state: HeartbeatState = { currentJobType: null, scheduleFailures: 0 };
  const beat: HeartbeatHandle | null = options.heartbeat === false ? null
    : startWorkerHeartbeat({ workerId: options.workerId, everyMs: options.heartbeatEveryMs, state: () => state });
  let processed = 0;
  let nextSchedule = 0;
  try {
    while (!signal.aborted) {
      if (scheduleWork && Date.now() >= nextSchedule) {
        try { await scheduleWork(); } catch { state.scheduleFailures += 1; console.error('[worker] scheduling failed'); }
        nextSchedule = Date.now() + scheduleEveryMs;
        if (options.afterSchedule) await options.afterSchedule().catch(() => undefined);
      }
      if (signal.aborted) break;
      const job = await claimJob();
      if (!job) { await abortableDelay(idleMs, signal); continue; }
      state.currentJobType = job.type;
      const work = runJob(job, handleJob);
      const settled = await settleWithinDrain(work, signal, drainMs);
      if (!settled) {
        console.error('[worker] drain bound reached with a job still running; its lease will expire and it will be reclaimed');
        return { processed, drained: false };
      }
      // runJob rethrows only when finishJob itself fails (database unavailable), as before the extraction.
      await work;
      state.currentJobType = null;
      processed += 1;
    }
    return { processed, drained: true };
  } finally {
    await beat?.stop();
  }
}
