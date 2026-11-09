// Meta data deletion ledger on PostgreSQL: the worker records a verified request
// once (a repeated delivery gets the same code), stores only a hash of the
// Facebook user id, finds a request by its code, and the app role cannot read
// the table at all.
import { createHash } from 'node:crypto';
import { config } from 'dotenv';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { disconnectDatabases, getPrisma, getWorkerPrisma } from '@/lib/db/prisma';
import { CONFIRMATION_CODE, findDeletionRequest, recordDeletionRequest } from './data-deletion';

const configured = config({ path: '.env.test', quiet: true }).parsed;
const ownerUrl = process.env.TEST_DATABASE_URL;
const appUrl = process.env.TEST_APP_DATABASE_URL || configured?.DATABASE_URL;
const workerUrl = process.env.TEST_WORKER_DATABASE_URL || configured?.WORKER_DATABASE_URL;
if (appUrl) process.env.DATABASE_URL = appUrl;
if (workerUrl) process.env.WORKER_DATABASE_URL = workerUrl;

const userId = `7${String(Date.now()).slice(-12)}`;
const hash = createHash('sha256').update(userId).digest('hex');
let owner: pg.Client;

describe.skipIf(!ownerUrl || !appUrl || !workerUrl)('Meta data deletion requests on PostgreSQL', { timeout: 60_000 }, () => {
  beforeAll(async () => {
    owner = new pg.Client({ connectionString: ownerUrl });
    await owner.connect();
    if (!/test/i.test((await owner.query('SELECT current_database() AS name')).rows[0].name)) throw new Error('Requires an isolated test database');
  });
  afterAll(async () => {
    if (owner) {
      await owner.query('DELETE FROM meta_data_deletion_requests WHERE app_user_hash=$1', [hash]);
      await owner.end();
    }
    await disconnectDatabases();
  });

  it('records a request once, by hash, and finds it by its code', async () => {
    const code = await recordDeletionRequest({ userId, issuedAt: 1_762_700_000 });
    expect(code).toMatch(CONFIRMATION_CODE);
    expect(await recordDeletionRequest({ userId, issuedAt: 1_762_700_000 })).toBe(code);
    const other = await recordDeletionRequest({ userId, issuedAt: 1_762_700_001 });
    expect(other).not.toBe(code);

    const rows = (await owner.query('SELECT app_user_hash, status FROM meta_data_deletion_requests WHERE confirmation_code=$1', [code])).rows;
    expect(rows).toEqual([{ app_user_hash: hash, status: 'completed' }]);
    const raw = await owner.query("SELECT count(*)::int AS n FROM meta_data_deletion_requests WHERE app_user_hash=$1", [userId]);
    expect(raw.rows[0].n).toBe(0);

    expect(await findDeletionRequest(code)).toMatchObject({ status: 'completed' });
    expect(await findDeletionRequest('z'.repeat(48))).toBeNull();
    expect(await findDeletionRequest("x' OR '1'='1")).toBeNull();
  });

  it('is closed to the app role and the worker cannot update or delete rows', async () => {
    await expect(getPrisma().$queryRaw`SELECT 1 FROM meta_data_deletion_requests LIMIT 1`).rejects.toThrow(/permission denied/i);
    await expect(getWorkerPrisma().$executeRaw`UPDATE meta_data_deletion_requests SET status='received' WHERE app_user_hash=${hash}`).rejects.toThrow(/permission denied/i);
    await expect(getWorkerPrisma().$executeRaw`DELETE FROM meta_data_deletion_requests WHERE app_user_hash=${hash}`).rejects.toThrow(/permission denied/i);
  });
});
