import { afterEach, describe, expect, it, vi } from 'vitest';
import { defaultWorkerId, startWorkerHeartbeat, workerRelease, type HeartbeatRow } from './heartbeat';

vi.mock('@/lib/db/prisma', () => ({ getWorkerPrisma: () => { throw new Error('no database in unit tests'); } }));

afterEach(() => { vi.useRealTimers(); });

describe('[OPS-01] worker heartbeat timer', () => {
  it('names the release from Railway, commit first, and clips long values', () => {
    expect(workerRelease({ RAILWAY_GIT_COMMIT_SHA: 'abc123', RAILWAY_DEPLOYMENT_ID: 'dep' })).toBe('abc123');
    expect(workerRelease({ RAILWAY_DEPLOYMENT_ID: ' dep ' })).toBe('dep');
    expect(workerRelease({})).toBeNull();
    expect(workerRelease({ RAILWAY_GIT_COMMIT_SHA: 'x'.repeat(500) })).toHaveLength(200);
    expect(defaultWorkerId({ RAILWAY_REPLICA_ID: 'r1' })).toBe('railway-replica:r1');
    expect(defaultWorkerId({})).toMatch(/^worker:[0-9a-f-]{36}$/);
  });

  it('beats at start and on its interval, independent of job state, with the current state', async () => {
    vi.useFakeTimers();
    const rows: HeartbeatRow[] = [];
    const state = { currentJobType: null as string | null, scheduleFailures: 0 };
    const beat = startWorkerHeartbeat({ workerId: 'w1', release: 'rel', everyMs: 15_000, state: () => state,
      write: async (row) => { rows.push({ ...row }); } });
    await vi.advanceTimersByTimeAsync(0);
    expect(rows).toHaveLength(1);
    state.currentJobType = 'broadcast.dispatch'; state.scheduleFailures = 2;
    await vi.advanceTimersByTimeAsync(15_000);
    expect(rows).toHaveLength(2);
    expect(rows[1]).toMatchObject({ workerId: 'w1', release: 'rel', currentJobType: 'broadcast.dispatch', scheduleFailures: 2 });
    expect(rows[1].startedAt).toEqual(rows[0].startedAt);
    await beat.stop();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(rows).toHaveLength(2);
  });

  it('a failing write never throws, is logged at most once a minute and without error text', async () => {
    vi.useFakeTimers();
    const logs: string[] = [];
    const beat = startWorkerHeartbeat({ workerId: 'w1', release: null, everyMs: 15_000, state: () => ({ currentJobType: null, scheduleFailures: 0 }),
      write: async () => { throw new Error('relation "worker_heartbeats" does not exist postgresql://secret@host'); },
      log: (message) => logs.push(message) });
    await vi.advanceTimersByTimeAsync(0);
    expect(await beat.beat()).toBe(false);
    await vi.advanceTimersByTimeAsync(45_000);
    expect(logs).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(logs).toHaveLength(2);
    expect(logs.join(' ')).not.toMatch(/postgresql|secret|relation/);
    await beat.stop();
  });

  it('does not stack writes behind a slow database', async () => {
    vi.useFakeTimers();
    let calls = 0;
    let release!: () => void;
    const beat = startWorkerHeartbeat({ workerId: 'w1', release: null, everyMs: 1000, state: () => ({ currentJobType: null, scheduleFailures: 0 }),
      write: () => { calls += 1; return new Promise<void>((resolve) => { release = resolve; }); } });
    await vi.advanceTimersByTimeAsync(5000);
    expect(calls).toBe(1);
    release();
    await vi.advanceTimersByTimeAsync(1000);
    expect(calls).toBe(2);
    release();
    await beat.stop();
  });
});
