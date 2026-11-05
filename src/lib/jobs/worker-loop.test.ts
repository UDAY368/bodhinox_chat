import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Job } from './queue';

const queue = vi.hoisted(() => ({
  pending: [] as Job[],
  finished: [] as { id: string; error: boolean }[],
  claims: 0,
}));
vi.mock('./queue', () => ({
  claimJob: vi.fn(async () => { queue.claims += 1; return queue.pending.shift() ?? null; }),
  finishJob: vi.fn(async (job: Job, error?: unknown) => { queue.finished.push({ id: job.id, error: !!error }); }),
  heartbeat: vi.fn(async () => 1),
}));
vi.mock('./handlers', () => ({ handleJob: vi.fn(), scheduleWork: vi.fn() }));
vi.mock('@/lib/db/prisma', () => ({ getWorkerPrisma: () => { throw new Error('no database in unit tests'); } }));

import { runWorkerLoop, workerDrainMs } from './worker-loop';

const job = (id: string, type = 'automation.resume'): Job =>
  ({ id, type, tenant_id: null, payload: {}, attempts: 1, max_attempts: 5, lease_token: `lease-${id}` });

beforeEach(() => { queue.pending = []; queue.finished = []; queue.claims = 0; });

describe('[OPS-01] worker loop drain (SIGTERM)', () => {
  it('reads WORKER_DRAIN_MS as a bounded positive integer', () => {
    expect(workerDrainMs({})).toBe(25_000);
    expect(workerDrainMs({ WORKER_DRAIN_MS: '5000' })).toBe(5000);
    for (const bad of ['0', '-1', 'abc', '1e3', '999999999']) expect(workerDrainMs({ WORKER_DRAIN_MS: bad })).toBe(25_000);
  });

  it('finishes the in-flight job after abort and claims nothing more', async () => {
    queue.pending = [job('a'), job('b')];
    const controller = new AbortController();
    const result = await runWorkerLoop({ signal: controller.signal, heartbeat: false, scheduleWork: null, idleMs: 10, drainMs: 5000,
      handleJob: async () => { controller.abort(); await new Promise((resolve) => setTimeout(resolve, 50)); } });
    expect(result).toEqual({ processed: 1, drained: true });
    expect(queue.finished).toEqual([{ id: 'a', error: false }]);
    expect(queue.claims).toBe(1);
    expect(queue.pending.map((j) => j.id)).toEqual(['b']);
  });

  it('returns at the drain bound without finishing a job that is still running (its lease covers it)', async () => {
    queue.pending = [job('slow')];
    const controller = new AbortController();
    let release!: () => void;
    const started = Date.now();
    const result = await runWorkerLoop({ signal: controller.signal, heartbeat: false, scheduleWork: null, drainMs: 50,
      handleJob: () => { controller.abort(); return new Promise<void>((resolve) => { release = resolve; }); } });
    expect(result).toEqual({ processed: 0, drained: false });
    expect(Date.now() - started).toBeLessThan(2000);
    expect(queue.finished).toEqual([]);
    release();
  });

  it('an abort ends the idle wait at once', async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 20);
    const started = Date.now();
    const result = await runWorkerLoop({ signal: controller.signal, heartbeat: false, scheduleWork: null, idleMs: 60_000, handleJob: vi.fn() });
    expect(result.drained).toBe(true);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('a failing job is finished with its error; scheduling failures are counted and do not stop the loop', async () => {
    queue.pending = [job('bad')];
    const controller = new AbortController();
    const afterSchedule = vi.fn(async () => { throw new Error('alert failure is swallowed'); });
    const scheduleWork = vi.fn(async () => { throw new Error('scheduling down'); });
    const result = await runWorkerLoop({ signal: controller.signal, heartbeat: false, scheduleWork, afterSchedule, idleMs: 5,
      handleJob: async () => { controller.abort(); throw new Error('handler failed'); } });
    expect(result.processed).toBe(1);
    expect(queue.finished).toEqual([{ id: 'bad', error: true }]);
    expect(scheduleWork).toHaveBeenCalledTimes(1);
    expect(afterSchedule).toHaveBeenCalledTimes(1);
  });

  it('does not claim when aborted before the first pass', async () => {
    const controller = new AbortController();
    controller.abort();
    expect(await runWorkerLoop({ signal: controller.signal, heartbeat: false, scheduleWork: null, handleJob: vi.fn() }))
      .toEqual({ processed: 0, drained: true });
    expect(queue.claims).toBe(0);
  });
});
