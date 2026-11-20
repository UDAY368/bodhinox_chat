import { createHash, randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// The login/sign-up limiter is durable (auth_rate_limits), unlike the in-memory buckets in
// rate-limit.ts that reset on deploy and are per replica. Local Docker test database only.
const ownerUrl = process.env.TEST_DATABASE_URL;
const authUrl = process.env.TEST_AUTH_DATABASE_URL;
const identity = `rate-limit-${randomUUID()}@example.com`;
const key = createHash('sha256').update(`login:${identity}`).digest('hex');
let owner: pg.Client;

async function freshService() {
  // A new module graph and new database clients: what a redeploy or a second replica sees.
  const prisma = await import('@/lib/db/prisma');
  await prisma.disconnectDatabases();
  vi.resetModules();
  return import('@/lib/auth/service');
}

describe.skipIf(!ownerUrl || !authUrl)('[SEC-02] durable auth rate limit', { timeout: 60_000 }, () => {
  beforeAll(async () => {
    process.env.AUTH_DATABASE_URL = authUrl;
    owner = new pg.Client({ connectionString: ownerUrl });
    await owner.connect();
    const name = (await owner.query('SELECT current_database() AS name')).rows[0].name as string;
    if (!/test/i.test(name)) throw new Error('Rate limit tests require an isolated test database');
  });
  afterAll(async () => {
    if (owner) {
      await owner.query('DELETE FROM auth_rate_limits WHERE key=$1', [key]);
      await owner.end();
    }
    const prisma = await import('@/lib/db/prisma');
    await prisma.disconnectDatabases();
  });

  it('the login limit survives a fresh module instance and is stored hashed', async () => {
    const first = await freshService();
    for (let i = 0; i < 10; i++) await first.enforceAuthRateLimit('login', identity);
    const second = await freshService();
    await expect(second.enforceAuthRateLimit('login', identity)).rejects.toMatchObject({ status: 429 });
    const rows = (await owner.query('SELECT key,attempts FROM auth_rate_limits WHERE key=$1', [key])).rows;
    expect(rows).toEqual([{ key, attempts: 11 }]);
    const plain = await owner.query('SELECT 1 FROM auth_rate_limits WHERE key LIKE $1', [`%${identity}%`]);
    expect(plain.rowCount).toBe(0);
  });
});

describe.skipIf(!ownerUrl || !authUrl)('shared request rate limit (checkRateLimit)', { timeout: 60_000 }, () => {
  const callerKey = `two-servers:${randomUUID()}`;
  const options = { limit: 3, windowMs: 60_000 };
  async function freshLimiter() {
    // A new module graph and new database clients: a second web server or the worker.
    const prisma = await import('@/lib/db/prisma');
    await prisma.disconnectDatabases();
    vi.resetModules();
    return import('@/lib/rate-limit');
  }
  beforeAll(async () => {
    process.env.AUTH_DATABASE_URL = authUrl;
    owner = new pg.Client({ connectionString: ownerUrl });
    await owner.connect();
  });
  afterAll(async () => {
    const { rateLimitStorageKey } = await import('@/lib/rate-limit');
    await owner.query('DELETE FROM auth_rate_limits WHERE key=$1', [rateLimitStorageKey(callerKey, options.windowMs)]);
    await owner.end();
    const prisma = await import('@/lib/db/prisma');
    await prisma.disconnectDatabases();
  });

  it('two module instances (two web servers) share one count, stored only as a hash', async () => {
    const serverA = await freshLimiter();
    expect((await serverA.checkRateLimit(callerKey, options)).remaining).toBe(2);
    expect((await serverA.checkRateLimit(callerKey, options)).success).toBe(true);
    const serverB = await freshLimiter();
    expect((await serverB.checkRateLimit(callerKey, options)).success).toBe(true);
    const refused = await serverB.checkRateLimit(callerKey, options);
    expect(refused).toMatchObject({ success: false, remaining: 0, limit: 3 });
    expect(refused.reset).toBeGreaterThan(Date.now() + 50_000);
    // serverA's own memory never counted these: the refusal comes from the shared row.
    expect((await serverA.checkRateLimit(callerKey, options)).success).toBe(false);
    const stored = serverB.rateLimitStorageKey(callerKey, options.windowMs);
    const rows = (await owner.query('SELECT attempts FROM auth_rate_limits WHERE key=$1', [stored])).rows;
    expect(rows).toEqual([{ attempts: 4 }]); // capped at limit + 1
    expect((await owner.query('SELECT 1 FROM auth_rate_limits WHERE key LIKE $1', [`%${callerKey}%`])).rowCount).toBe(0);
  });

  it('a new window starts a fresh count', async () => {
    const limiter = await freshLimiter();
    const key = `window:${randomUUID()}`;
    const short = { limit: 1, windowMs: 200 };
    expect((await limiter.checkRateLimit(key, short)).success).toBe(true);
    expect((await limiter.checkRateLimit(key, short)).success).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect((await limiter.checkRateLimit(key, short)).success).toBe(true);
    await owner.query('DELETE FROM auth_rate_limits WHERE key=$1', [limiter.rateLimitStorageKey(key, short.windowMs)]);
  });
});
