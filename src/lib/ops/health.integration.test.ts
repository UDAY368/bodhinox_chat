import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { disconnectDatabases, getAuthPrisma, getPlatformPrisma, getPrisma } from '@/lib/db/prisma';
import { deepHealth, readOpsHealth } from './health';
import { GET } from '@/app/api/health/route';
import { __resetRateLimitForTests } from '@/lib/rate-limit';

// Local Docker test database only (node scripts/test-db-local.cjs run, or the per-file runner); no env file is loaded.
const ownerUrl = process.env.TEST_DATABASE_URL;
const appUrl = process.env.TEST_APP_DATABASE_URL;
const authUrl = process.env.TEST_AUTH_DATABASE_URL;
const platformUrl = process.env.TEST_PLATFORM_DATABASE_URL;
const prefix = `it-ops-health-${process.pid}-${Date.now()}`;
const TOKEN = randomUUID() + randomUUID();
let owner: pg.Client;
let savedBeats: { worker_id: string; started_at: Date; beat_at: Date }[] = [];
const jobKeys: string[] = [];
const receiptKeys: string[] = [];

async function beatAgo(seconds: number) {
  await owner.query('DELETE FROM worker_heartbeats');
  await owner.query(`INSERT INTO worker_heartbeats(worker_id,started_at,beat_at) VALUES($1,NOW()-INTERVAL '1 hour',NOW()-make_interval(secs=>$2))`,
    [`${prefix}-w`, seconds]);
}

describe.skipIf(!ownerUrl || !appUrl || !authUrl || !platformUrl)('[OPS-01] deep health on real PostgreSQL', { timeout: 60_000 }, () => {
  beforeAll(async () => {
    Object.assign(process.env, { DATABASE_URL: appUrl, AUTH_DATABASE_URL: authUrl, PLATFORM_DATABASE_URL: platformUrl, HEALTH_TOKEN: TOKEN });
    owner = new pg.Client({ connectionString: ownerUrl });
    await owner.connect();
    const name = (await owner.query('SELECT current_database() AS name')).rows[0].name as string;
    if (!/test/i.test(name)) throw new Error('Health tests require an isolated test database');
    // Heartbeats are replaced per case; the rows other suites left are restored afterwards.
    savedBeats = (await owner.query('SELECT worker_id,started_at,beat_at FROM worker_heartbeats')).rows;
  });
  afterEach(() => { __resetRateLimitForTests(); });
  afterAll(async () => {
    if (owner) {
      await owner.query('DELETE FROM jobs WHERE dedupe_key = ANY($1::text[])', [jobKeys]);
      await owner.query('DELETE FROM webhook_receipts WHERE dedupe_key = ANY($1::text[])', [receiptKeys]);
      await owner.query('DELETE FROM worker_heartbeats');
      for (const row of savedBeats)
        await owner.query('INSERT INTO worker_heartbeats(worker_id,started_at,beat_at) VALUES($1,$2,$3)', [row.worker_id, row.started_at, row.beat_at]);
      await owner.end();
    }
    delete process.env.HEALTH_TOKEN;
    await disconnectDatabases();
  });

  it('a fresh heartbeat is ok for the worker check; a stale one is down with 503', async () => {
    await beatAgo(2);
    const fresh = await deepHealth();
    expect(fresh.checks.ops).toBe('ok');
    expect(fresh.checks.appDb).toBe(true);
    expect(fresh.checks.worker).toMatchObject({ ok: true });
    expect(fresh.checks.migrations?.latest).toMatch(/^\d{14}_[a-z0-9_]+$/);

    await beatAgo(600);
    const response = await GET(new Request('https://app.example.com/api/health?deep=1', { headers: { authorization: `Bearer ${TOKEN}` } }));
    expect(response.status).toBe(503);
    const body = await response.json();
    expect(body.status).toBe('down');
    expect(body.checks.worker).toEqual({ ageS: expect.any(Number), ok: false });
    expect(body.checks.worker.ageS).toBeGreaterThanOrEqual(599);

    await owner.query('DELETE FROM worker_heartbeats');
    expect((await deepHealth()).checks.worker).toEqual({ ageS: null, ok: false });
  });

  it('an old due job makes it degraded; old unprocessed webhooks are counted', async () => {
    await beatAgo(1);
    const before = await readOpsHealth(getPlatformPrisma());
    const jobKey = `${prefix}-job-${randomUUID()}`;
    jobKeys.push(jobKey);
    await owner.query(`INSERT INTO jobs(type,payload,dedupe_key,run_at,status) VALUES('automation.resume','{}',$1,NOW()-INTERVAL '1 hour','pending')`, [jobKey]);
    const receiptKey = `${prefix}-receipt-${randomUUID()}`;
    receiptKeys.push(receiptKey);
    await owner.query(`INSERT INTO webhook_receipts(provider,dedupe_key,payload,status,created_at) VALUES('meta',$1,'{}','pending',NOW()-INTERVAL '20 minutes')`, [receiptKey]);

    const health = await deepHealth();
    expect(health.status).toBe('degraded');
    expect(health.checks.queue!.oldestDueS).toBeGreaterThanOrEqual(3599);
    expect(health.checks.queue!.pendingDue).toBe(before.pendingDue + 1);
    expect(health.checks.webhooks!.unprocessed15m).toBe(before.unprocessedWebhooks15m + 1);
    expect(JSON.stringify(health)).not.toMatch(new RegExp(`${prefix}|[0-9a-f]{8}-[0-9a-f]{4}-`));
  });

  it('only the platform and worker roles can execute crm_ops_health', async () => {
    await expect(getPrisma().$queryRaw`SELECT * FROM crm_ops_health()`).rejects.toThrow();
    await expect(getAuthPrisma().$queryRaw`SELECT * FROM crm_ops_health()`).rejects.toThrow();
    await expect(readOpsHealth(getPrisma())).rejects.toThrow();
    await expect(readOpsHealth(getPlatformPrisma())).resolves.toMatchObject({ pendingDue: expect.any(Number) });
  });
});
