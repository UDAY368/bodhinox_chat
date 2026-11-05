import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { disconnectDatabases, getPrisma, getWorkerPrisma } from '@/lib/db/prisma';
import { startWorkerHeartbeat, writeWorkerHeartbeat } from './heartbeat';
import { runWorkerLoop } from './worker-loop';

// Local Docker test database only (node scripts/test-db-local.cjs run, or the per-file runner); no env file is loaded.
const ownerUrl = process.env.TEST_DATABASE_URL;
const workerUrl = process.env.TEST_WORKER_DATABASE_URL;
const appUrl = process.env.TEST_APP_DATABASE_URL;
const prefix = `it-heartbeat-${process.pid}-${Date.now()}`;
let owner: pg.Client;

describe.skipIf(!ownerUrl || !workerUrl || !appUrl)('[OPS-01] worker heartbeat on real PostgreSQL', { timeout: 60_000 }, () => {
  beforeAll(async () => {
    process.env.WORKER_DATABASE_URL = workerUrl;
    process.env.DATABASE_URL = appUrl;
    owner = new pg.Client({ connectionString: ownerUrl });
    await owner.connect();
    const name = (await owner.query('SELECT current_database() AS name')).rows[0].name as string;
    if (!/test/i.test(name)) throw new Error('Heartbeat tests require an isolated test database');
  });
  afterAll(async () => {
    if (owner) {
      await owner.query('DELETE FROM worker_heartbeats WHERE worker_id LIKE $1', [`${prefix}%`]);
      await owner.end();
    }
    await disconnectDatabases();
  });

  it('the worker role upserts one row per worker id and crm_ops_health sees a fresh beat', async () => {
    const write = writeWorkerHeartbeat(getWorkerPrisma());
    const startedAt = new Date(Date.now() - 5000);
    await write({ workerId: `${prefix}-a`, startedAt, release: 'abc123', currentJobType: null, scheduleFailures: 0 });
    const first = (await owner.query('SELECT * FROM worker_heartbeats WHERE worker_id=$1', [`${prefix}-a`])).rows[0];
    await new Promise((resolve) => setTimeout(resolve, 20));
    await write({ workerId: `${prefix}-a`, startedAt, release: 'abc123', currentJobType: 'broadcast.dispatch', scheduleFailures: 3 });
    const rows = (await owner.query('SELECT * FROM worker_heartbeats WHERE worker_id=$1', [`${prefix}-a`])).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ release: 'abc123', current_job_type: 'broadcast.dispatch', schedule_failures: 3 });
    expect(rows[0].beat_at.getTime()).toBeGreaterThan(first.beat_at.getTime());
    const health = await getWorkerPrisma().$queryRaw<{ last_beat_age_s: number }[]>`SELECT last_beat_age_s FROM crm_ops_health()`;
    expect(health[0].last_beat_age_s).toBeLessThan(10);
  });

  it('the app role can neither read nor write heartbeats', async () => {
    await expect(getPrisma().$queryRaw`SELECT * FROM worker_heartbeats LIMIT 1`).rejects.toThrow();
    await expect(getPrisma().$executeRaw`INSERT INTO worker_heartbeats(worker_id,started_at,beat_at) VALUES(${`${prefix}-app`},NOW(),NOW())`).rejects.toThrow();
  });

  it('the timer writes at start; the worker loop beats at start and stops beating once it returns', async () => {
    const beat = startWorkerHeartbeat({ workerId: `${prefix}-timer`, release: null, everyMs: 50, state: () => ({ currentJobType: null, scheduleFailures: 0 }) });
    expect(await beat.beat()).toBe(true);
    await beat.stop();
    expect((await owner.query('SELECT 1 FROM worker_heartbeats WHERE worker_id=$1', [`${prefix}-timer`])).rowCount).toBe(1);

    // An already-aborted loop claims nothing (so no real queue row is touched) but still beats at start,
    // and awaits that write before returning.
    const controller = new AbortController();
    controller.abort();
    const result = await runWorkerLoop({ signal: controller.signal, workerId: `${prefix}-loop`, heartbeatEveryMs: 50,
      scheduleWork: null, handleJob: async () => { throw new Error('unexpected job in heartbeat test'); } });
    expect(result).toEqual({ processed: 0, drained: true });
    const row = (await owner.query('SELECT beat_at FROM worker_heartbeats WHERE worker_id=$1', [`${prefix}-loop`])).rows[0];
    expect(row).toBeDefined();
    await new Promise((resolve) => setTimeout(resolve, 200));
    const after = (await owner.query('SELECT beat_at FROM worker_heartbeats WHERE worker_id=$1', [`${prefix}-loop`])).rows[0];
    expect(after.beat_at.getTime()).toBe(row.beat_at.getTime());
  });

  it('a heartbeat write that fails (e.g. table missing before its migration) never throws', async () => {
    const logs: string[] = [];
    const beat = startWorkerHeartbeat({ workerId: 'x'.repeat(300), release: null, everyMs: 60_000, log: (m) => logs.push(m),
      state: () => ({ currentJobType: null, scheduleFailures: -1 }),
      write: async () => { await getWorkerPrisma().$executeRaw`INSERT INTO worker_heartbeats_missing(worker_id) VALUES('x')`; } });
    expect(await beat.beat()).toBe(false);
    await beat.stop();
    expect(logs).toEqual(['[worker] heartbeat write failed; the worker keeps running']);
  });
});
