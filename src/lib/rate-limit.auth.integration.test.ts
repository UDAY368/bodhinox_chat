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
