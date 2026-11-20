import { withLeaseScope } from './lease';
import { claimJob, finishJob, heartbeat as extendLease, withLaneLock, type Job } from './queue';
import { idleDelayMs, laneIdleMaxMs, laneSlots, workerConnections, workerLanes, type JobLane } from './lanes';
import { startWorkerHeartbeat, type HeartbeatHandle, type HeartbeatState } from './heartbeat';

/**
 * The worker's claim/handle/finish loops (Phase 15: extracted from worker.ts, which keeps the dotenv
 * bootstrap and the process signal wiring). Job slots run side by side, each claiming from one lane
 * (src/lib/jobs/lanes.ts): 'inbound' (messages, AI replies, event fan-out, webhooks), 'timers'
 * (periodic sweeps, flow timers, reminders) and 'bulk' (campaign passes, exports, Graph batches),
 * so no kind of work holds up another. One conversation's jobs still run one at a time and in order
 * (lane_key: the claim skips a busy key, the run holds the key's advisory lock). WORKER_CONCURRENCY=1
 * is the old single lane. An idle slot polls less often (250 ms growing to 2 s inbound, 5 s
 * otherwise) and polls at once again after a job. Scheduling runs on its own timer, not between jobs.
 *
 * Stopping is cooperative: once `signal` aborts, no new job is claimed, in-flight jobs are given up
 * to `drainMs` to finish, and if one does not, the loop returns and that job's 90 s lease covers the
 * rest (it is reclaimed, never lost).
 */
export type JobHandler = (job: Job, assertLease: () => void) => Promise<void>;
export interface WorkerLoopOptions {
  signal: AbortSignal;
  /** First wait when no job is due, doubling per empty claim up to the lane's maximum. Default 250 ms; an abort ends the wait at once. */
  idleMs?: number;
  /** Cap for the idle wait. Default 2 000 ms for inbound and 'all', 5 000 ms for timers and bulk. */
  idleMaxMs?: number;
  /** Upper bound for the in-flight job after abort. Default WORKER_DRAIN_MS or 25 000 ms. */
  drainMs?: number;
  /** Default 30 000 ms, as before. */
  scheduleEveryMs?: number;
  /** One entry per slot. Default workerLanes(): ['all'] when WORKER_CONCURRENCY=1, else the per-lane slot counts. */
  lanes?: JobLane[];
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
    // A keyed job (one conversation) runs under its key's advisory lock.
    await withLaneLock(job.lane_key, () => withLeaseScope(assertLease, () => handleJob(job, assertLease)));
    await finishJob(job);
  } catch (error) {
    console.error('[worker] job failed', { id: job.id, type: job.type, category: error instanceof Error ? error.name : 'Error' });
    await finishJob(job, error);
  } finally { clearInterval(timer); }
}

export async function runWorkerLoop(options: WorkerLoopOptions): Promise<WorkerLoopResult> {
  const idleMs = options.idleMs ?? 250;
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

  const running = new Map<number, { lane: JobLane; type: string }>();
  const state: HeartbeatState = { currentJobType: null, scheduleFailures: 0 };
  // Per lane, e.g. "inbound:inbound.actions,whatsapp.webhook bulk:broadcast.dispatch".
  const showRunning = () => { state.currentJobType = runningByLane(running.values()); };
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
    let misses = 0;
    const maxIdle = options.idleMaxMs ?? laneIdleMaxMs(lane);
    while (!signal.aborted) {
      const job = await claimJob(lane);
      if (!job) { misses += 1; await abortableDelay(idleDelayMs(misses, idleMs, Math.max(idleMs, maxIdle)), signal); continue; }
      misses = 0;
      running.set(index, { lane, type: job.type }); showRunning();
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
    const lanes = options.lanes ?? workerLanes();
    if (!options.lanes && lanes.length > 1) {
      const needed = workerConnections(laneSlots());
      const pool = Number(process.env.DB_POOL_SIZE || '10');
      if (needed > pool) console.error('[worker] lane slots may need more connections than DB_POOL_SIZE', { needed, pool });
    }
    // A scheduling pass in flight shares the same drain bound as the jobs (measured from the abort,
    // not after the slots), and counts toward `drained`: the caller must not wait on the pool for it.
    const scheduler = settleWithinDrain(schedule(), signal, drainMs);
    const slots = lanes.map((lane, index) => slot(lane, index).catch((error: unknown) => { stop.abort(); throw error; }));
    const results = await Promise.allSettled(slots);
    const schedulerSettled = await scheduler;
    const failure = results.find((r): r is PromiseRejectedResult => r.status === 'rejected');
    if (failure) throw failure.reason;
    return { processed, drained: schedulerSettled && results.every((r) => r.status === 'fulfilled' && r.value) };
  } finally {
    options.signal.removeEventListener('abort', forward);
    await beat?.stop();
  }
}

/** The running job types per lane for the heartbeat row, at most 200 characters. */
export function runningByLane(jobs: Iterable<{ lane: JobLane; type: string }>): string | null {
  const byLane = new Map<JobLane, Set<string>>();
  for (const { lane, type } of jobs) {
    if (!byLane.has(lane)) byLane.set(lane, new Set());
    byLane.get(lane)!.add(type);
  }
  if (!byLane.size) return null;
  return [...byLane].map(([lane, types]) => `${lane}:${[...types].sort().join(',')}`).join(' ').slice(0, 200);
}
