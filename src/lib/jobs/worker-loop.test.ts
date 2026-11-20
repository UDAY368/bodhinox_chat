import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Job } from './queue';

const queue = vi.hoisted(() => ({
  pending: [] as Job[],
  finished: [] as { id: string; error: boolean }[],
  claims: 0,
}));
vi.mock('./queue', () => ({
  // Lanes as in claimJob: 'bulk' takes only campaign passes here, 'timers' flow timers, 'inbound' the rest, 'all' any.
  claimJob: vi.fn(async (lane: string = 'all') => {
    queue.claims += 1;
    const laneOf = (type: string) => (type === 'broadcast.dispatch' ? 'bulk' : type === 'flow.timer' ? 'timers' : 'inbound');
    const index = queue.pending.findIndex((j) => lane === 'all' || laneOf(j.type) === lane);
    return index < 0 ? null : queue.pending.splice(index, 1)[0];
  }),
  finishJob: vi.fn(async (job: Job, error?: unknown) => { queue.finished.push({ id: job.id, error: !!error }); }),
  heartbeat: vi.fn(async () => 1),
  withLaneLock: vi.fn((_key: unknown, work: () => Promise<unknown>) => work()),
}));
vi.mock('./handlers', () => ({ handleJob: vi.fn(), scheduleWork: vi.fn() }));
vi.mock('@/lib/db/prisma', () => ({ getWorkerPrisma: () => { throw new Error('no database in unit tests'); } }));

import { runningByLane, runWorkerLoop, workerDrainMs } from './worker-loop';
import { workerLanes } from './lanes';

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
    const result = await runWorkerLoop({ signal: controller.signal, heartbeat: false, lanes: ['all'], scheduleWork: null, idleMs: 10, drainMs: 5000,
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
    const result = await runWorkerLoop({ signal: controller.signal, heartbeat: false, lanes: ['all'], scheduleWork: null, drainMs: 50,
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
    const result = await runWorkerLoop({ signal: controller.signal, heartbeat: false, lanes: ['all'], scheduleWork: null, idleMs: 60_000, handleJob: vi.fn() });
    expect(result.drained).toBe(true);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('a failing job is finished with its error; scheduling failures are counted and do not stop the loop', async () => {
    queue.pending = [job('bad')];
    const controller = new AbortController();
    const afterSchedule = vi.fn(async () => { throw new Error('alert failure is swallowed'); });
    const scheduleWork = vi.fn(async () => { throw new Error('scheduling down'); });
    const result = await runWorkerLoop({ signal: controller.signal, heartbeat: false, lanes: ['all'], scheduleWork, afterSchedule, idleMs: 5,
      handleJob: async () => { controller.abort(); throw new Error('handler failed'); } });
    expect(result.processed).toBe(1);
    expect(queue.finished).toEqual([{ id: 'bad', error: true }]);
    expect(scheduleWork).toHaveBeenCalledTimes(1);
    expect(afterSchedule).toHaveBeenCalledTimes(1);
  });

  it('does not claim when aborted before the first pass', async () => {
    const controller = new AbortController();
    controller.abort();
    expect(await runWorkerLoop({ signal: controller.signal, heartbeat: false, lanes: ['all'], scheduleWork: null, handleJob: vi.fn() }))
      .toEqual({ processed: 0, drained: true });
    expect(queue.claims).toBe(0);
  });
});

const LANES = workerLanes({});

describe('[audit-10/37] concurrent job slots', () => {
  it('runs the default lanes, or one lane for every job at WORKER_CONCURRENCY=1', () => {
    expect(LANES).toEqual(['inbound', 'inbound', 'timers', 'bulk', 'bulk']);
    expect(workerLanes({ WORKER_CONCURRENCY: '1' })).toEqual(['all']);
  });

  it('reports the running job types per lane to the heartbeat, bounded', () => {
    expect(runningByLane([])).toBeNull();
    expect(runningByLane([{ lane: 'inbound', type: 'whatsapp.webhook' }, { lane: 'bulk', type: 'broadcast.dispatch' }, { lane: 'inbound', type: 'inbound.actions' }, { lane: 'inbound', type: 'inbound.actions' }]))
      .toBe('inbound:inbound.actions,whatsapp.webhook bulk:broadcast.dispatch');
    expect(runningByLane(Array.from({ length: 40 }, (_, i) => ({ lane: 'inbound' as const, type: `type.number_${i}` })))!.length).toBe(200);
  });

  it('a flow timer runs in its own lane while inbound and campaign slots are busy', async () => {
    queue.pending = [job('campaign', 'broadcast.dispatch'), job('in-1', 'inbound.actions'), job('timer', 'flow.timer')];
    const controller = new AbortController();
    const started: string[] = [];
    let release!: () => void;
    const hold = new Promise<void>((resolve) => { release = resolve; });
    await runWorkerLoop({ signal: controller.signal, heartbeat: false, scheduleWork: null, idleMs: 5, drainMs: 5000, lanes: ['inbound', 'timers', 'bulk'],
      // Each job waits until all three have started: they only finish if the lanes run side by side.
      handleJob: async (j) => {
        started.push(j.id);
        if (started.length === 3) { release(); controller.abort(); }
        await hold;
      } });
    expect(started.sort()).toEqual(['campaign', 'in-1', 'timer']);
    expect(queue.finished.map((f) => f.id).sort()).toEqual(['campaign', 'in-1', 'timer']);
  });

  it('runs a keyed job under its lane lock', async () => {
    const { withLaneLock } = await import('./queue');
    queue.pending = [{ ...job('keyed', 'inbound.actions'), lane_key: 'conversation:c1' }];
    const controller = new AbortController();
    await runWorkerLoop({ signal: controller.signal, heartbeat: false, scheduleWork: null, idleMs: 5, lanes: ['inbound'], handleJob: async () => { controller.abort(); } });
    expect(withLaneLock).toHaveBeenCalledWith('conversation:c1', expect.any(Function));
  });

  it('backs off polling while idle and polls at once again after a job', async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 300);
    await runWorkerLoop({ signal: controller.signal, heartbeat: false, scheduleWork: null, idleMs: 10, idleMaxMs: 80, lanes: ['inbound'], handleJob: vi.fn() });
    // 10, 20, 40, 80, 80 ms...: about 6 claims in 300 ms, far fewer than the 30 a fixed 10 ms wait makes.
    expect(queue.claims).toBeGreaterThanOrEqual(4);
    expect(queue.claims).toBeLessThanOrEqual(9);
  });

  it('handles inbound work in order on one inbound slot while a campaign pass is still running', async () => {
    queue.pending = [job('campaign', 'broadcast.dispatch'), job('in-1', 'whatsapp.webhook'), job('in-2', 'inbound.actions')];
    const controller = new AbortController();
    const order: string[] = [];
    let mainRunning = 0; let maxMainRunning = 0;
    let finishCampaign!: () => void;
    const campaignDone = new Promise<void>((resolve) => { finishCampaign = resolve; });
    const result = await runWorkerLoop({ signal: controller.signal, heartbeat: false, scheduleWork: null, idleMs: 5, drainMs: 5000, lanes: ['inbound', 'bulk', 'bulk'],
      handleJob: async (j) => {
        if (j.type === 'broadcast.dispatch') { order.push('campaign:start'); await campaignDone; order.push('campaign:end'); controller.abort(); return; }
        mainRunning += 1; maxMainRunning = Math.max(maxMainRunning, mainRunning);
        await new Promise((resolve) => setTimeout(resolve, 10));
        order.push(j.id); mainRunning -= 1;
        if (j.id === 'in-2') finishCampaign();
      } });
    expect(order).toEqual(['campaign:start', 'in-1', 'in-2', 'campaign:end']);
    expect(maxMainRunning).toBe(1);
    expect(result).toEqual({ processed: 3, drained: true });
    expect(queue.finished.map((f) => f.id).sort()).toEqual(['campaign', 'in-1', 'in-2']);
  });

  it('schedules on its own timer while a long job runs', async () => {
    queue.pending = [job('long', 'broadcast.dispatch')];
    const controller = new AbortController();
    const scheduleWork = vi.fn(async () => {});
    await runWorkerLoop({ signal: controller.signal, heartbeat: false, scheduleWork, scheduleEveryMs: 10, idleMs: 5, drainMs: 5000, lanes: ['all'],
      handleJob: async () => { await new Promise((resolve) => setTimeout(resolve, 120)); controller.abort(); } });
    expect(scheduleWork.mock.calls.length).toBeGreaterThanOrEqual(3);
  });

  it('bounds a scheduling pass still in flight by the same drain and reports it as not drained', async () => {
    const controller = new AbortController();
    let release!: () => void;
    const scheduleWork = vi.fn(() => { controller.abort(); return new Promise<void>((resolve) => { release = resolve; }); });
    const started = Date.now();
    const result = await runWorkerLoop({ signal: controller.signal, heartbeat: false, scheduleWork, idleMs: 5, drainMs: 50, lanes: LANES, handleJob: vi.fn() });
    expect(result).toEqual({ processed: 0, drained: false });
    expect(Date.now() - started).toBeLessThan(2000);
    release();
  });

  it('stops every slot when one cannot finish its job (database unavailable)', async () => {
    const { finishJob } = await import('./queue');
    vi.mocked(finishJob).mockRejectedValueOnce(new Error('database down')).mockRejectedValueOnce(new Error('database down'));
    queue.pending = [job('a', 'whatsapp.webhook')];
    const controller = new AbortController();
    await expect(runWorkerLoop({ signal: controller.signal, heartbeat: false, scheduleWork: null, idleMs: 5, lanes: LANES, handleJob: async () => {} }))
      .rejects.toThrow('database down');
  });
});
