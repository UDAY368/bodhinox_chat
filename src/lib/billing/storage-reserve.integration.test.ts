import { randomUUID } from 'node:crypto';
import { config } from 'dotenv';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { disconnectDatabases, getPrisma } from '@/lib/db/prisma';
import { withTenant, type TenantContext } from '@/lib/db/tenant';
import { PlanLimitError } from './entitlements';
import { releaseStorage, reserveStorage, storageBytesUsed } from './limits';

const configured = config({ path: '.env.test', quiet: true }).parsed;
const ownerUrl = process.env.TEST_DATABASE_URL;
const appUrl = process.env.TEST_APP_DATABASE_URL || configured?.DATABASE_URL;
const workerUrl = process.env.TEST_WORKER_DATABASE_URL || configured?.WORKER_DATABASE_URL;
if (appUrl) process.env.DATABASE_URL = appUrl;
if (workerUrl) process.env.WORKER_DATABASE_URL = workerUrl;

const account = randomUUID(), agentId = randomUUID();
const plan = `store_${randomUUID().slice(0, 8)}`;
const agent: TenantContext = { accountId: account, userId: agentId, role: 'agent' };
const key = (name: string) => `account-${account}/library/${name}`;
let owner: pg.Client;

const reserve = (name: string, bytes: number, upsert = false, hold = 0) =>
  withTenant(agent, async (tx) => {
    const r = await reserveStorage(tx, { accountId: account, uploadedBy: agentId, bucket: 'chat-media', objectKey: key(name), contentType: 'image/png', bytes, upsert, enforce: true });
    // Hold the transaction open, as the slowest part of a real upload would, so the other upload overlaps.
    if (hold) await tx.$executeRawUnsafe(`SELECT pg_sleep(${hold})`);
    return r;
  });
const used = () => withTenant(agent, (tx) => storageBytesUsed(tx, account));

describe.skipIf(!ownerUrl || !appUrl || !workerUrl)('storage reservation on PostgreSQL', { timeout: 120_000 }, () => {
  beforeAll(async () => {
    owner = new pg.Client({ connectionString: ownerUrl });
    await owner.connect();
    if (!/test/i.test((await owner.query('SELECT current_database() AS name')).rows[0].name)) throw new Error('Requires an isolated test database');
    const app = await getPrisma().$queryRaw<{ role: string }[]>`SELECT current_user AS role`;
    if (app[0].role !== 'bodhinox_app') throw new Error('Requires constrained test app credentials');
    await owner.query("INSERT INTO auth_users(id,email,full_name,password_hash) VALUES($1,$2,'Storage test','test-only-hash')", [agentId, `${agentId}@example.invalid`]);
    await owner.query("INSERT INTO accounts(id,name,owner_user_id) VALUES($1,'Storage A',$2)", [account, agentId]);
    await owner.query("INSERT INTO account_memberships(account_id,user_id,role) VALUES($1,$2,'agent')", [account, agentId]);
    await owner.query(`INSERT INTO plans(id,name,features,limits) VALUES($1,'Store','{}','{"storage_bytes":1000}')`, [plan]);
    await owner.query("INSERT INTO account_subscriptions(account_id,plan_id,status) VALUES($1,$2,'active')", [account, plan]);
  });

  afterAll(async () => {
    if (owner) {
      await owner.query('DELETE FROM accounts WHERE id=$1', [account]);
      await owner.query('DELETE FROM auth_users WHERE id=$1', [agentId]);
      await owner.query('DELETE FROM plans WHERE id=$1', [plan]);
      await owner.end();
    }
    await disconnectDatabases();
  });

  it('lets only one of two concurrent uploads use the last room', async () => {
    const results = await Promise.allSettled([reserve('a.png', 600, false, 0.3), reserve('b.png', 600, false, 0.3)]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const refused = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(refused.reason).toBeInstanceOf(PlanLimitError);
    expect(await used()).toBe(600);
    // The refused upload recorded nothing.
    expect((await owner.query('SELECT count(*)::int AS n FROM media_objects WHERE account_id=$1', [account])).rows[0].n).toBe(1);
  });

  it('releases a reservation whose upload failed, and keeps an existing key unless replacing', async () => {
    const won = (await owner.query('SELECT object_key FROM media_objects WHERE account_id=$1', [account])).rows[0].object_key as string;
    const name = won.split('/').pop()!;
    await expect(reserve(name, 10)).rejects.toThrow('Object already exists');

    // A replacement keeps the larger size until the put is done, and is restored when it fails.
    const replaced = await reserve(name, 900, true);
    expect(replaced).toMatchObject({ created: false, previousBytes: 600, bytes: 900 });
    expect(await used()).toBe(900);
    await expect(reserve('c.png', 200)).rejects.toBeInstanceOf(PlanLimitError);
    await withTenant(agent, (tx) => releaseStorage(tx, account, replaced));
    expect(await used()).toBe(600);

    // A new key's reservation is removed when its put fails.
    const fresh = await reserve('c.png', 400);
    expect(fresh.created).toBe(true);
    expect(await used()).toBe(1000);
    await withTenant(agent, (tx) => releaseStorage(tx, account, fresh));
    expect(await used()).toBe(600);
  });
});
