// The ad drawer's daily series on PostgreSQL: one object's last 14 days, zero-filled,
// read in the member's own workspace only (another workspace with the same Meta id
// is never mixed in).
import { randomUUID } from 'node:crypto';
import { config } from 'dotenv';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { disconnectDatabases, getPrisma } from '@/lib/db/prisma';
import { adDailySeries, dailyWindow } from './daily';

const configured = config({ path: '.env.test', quiet: true }).parsed;
const ownerUrl = process.env.TEST_DATABASE_URL;
const appUrl = process.env.TEST_APP_DATABASE_URL || configured?.DATABASE_URL;
const workerUrl = process.env.TEST_WORKER_DATABASE_URL || configured?.WORKER_DATABASE_URL;
if (appUrl) process.env.DATABASE_URL = appUrl;
if (workerUrl) process.env.WORKER_DATABASE_URL = workerUrl;

const A = randomUUID(), B = randomUUID(), userA = randomUUID(), userB = randomUUID();
const connA = randomUUID(), connB = randomUUID();
const AD = `1202${String(Date.now()).slice(-9)}`;
let owner: pg.Client;

describe.skipIf(!ownerUrl || !appUrl || !workerUrl)('ad daily series on PostgreSQL', { timeout: 60_000 }, () => {
  beforeAll(async () => {
    owner = new pg.Client({ connectionString: ownerUrl });
    await owner.connect();
    if (!/test/i.test((await owner.query('SELECT current_database() AS name')).rows[0].name)) throw new Error('Requires an isolated test database');
    const app = await getPrisma().$queryRaw<{ name: string }[]>`SELECT current_database() AS name`;
    if (!/test/i.test(app[0].name)) throw new Error('Requires constrained test app credentials');
    await owner.query("INSERT INTO auth_users(id,email,full_name,password_hash) SELECT x, x::text || '@example.invalid', 'Ads daily', 'test-only-hash' FROM unnest($1::uuid[]) x", [[userA, userB]]);
    await owner.query("INSERT INTO accounts(id,name,owner_user_id) VALUES($1,'Daily A',$2),($3,'Daily B',$4)", [A, userA, B, userB]);
    await owner.query("INSERT INTO account_memberships(account_id,user_id,role) VALUES($1,$2,'viewer'),($3,$4,'owner')", [A, userA, B, userB]);
    await owner.query("INSERT INTO meta_ad_connections(id,account_id,connected_by,status) VALUES($1,$2,$3,'active'),($4,$5,$6,'active')", [connA, A, userA, connB, B, userB]);
    const days = dailyWindow();
    await owner.query(`INSERT INTO meta_ad_insights(account_id,connection_id,level,object_id,day,spend,clicks,conversations_started,currency)
      VALUES($1,$2,'ad',$3,$4,12.5,40,6,'INR'),($1,$2,'ad',$3,$5,7.25,10,2,'INR'),
            ($6,$7,'ad',$3,$4,999,999,999,'USD')`, [A, connA, AD, days[13], days[10], B, connB]);
    // Outside the window: never returned.
    await owner.query(`INSERT INTO meta_ad_insights(account_id,connection_id,level,object_id,day,spend) VALUES($1,$2,'ad',$3,(current_date - 40),50)`, [A, connA, AD]);
  });
  afterAll(async () => {
    if (owner) {
      await owner.query('DELETE FROM accounts WHERE id = ANY($1::uuid[])', [[A, B]]);
      await owner.query('DELETE FROM auth_users WHERE id = ANY($1::uuid[])', [[userA, userB]]);
      await owner.end();
    }
    await disconnectDatabases();
  });

  it('returns 14 zero-filled days of this workspace only', async () => {
    const series = await adDailySeries({ accountId: A, userId: userA, role: 'viewer' }, 'ad', AD);
    expect(series.currency).toBe('INR');
    expect(series.points).toHaveLength(14);
    expect(series.points[13]).toMatchObject({ spend: 12.5, clicks: 40, conversations: 6 });
    expect(series.points[10]).toMatchObject({ spend: 7.25, clicks: 10, conversations: 2 });
    expect(series.points.reduce((sum, p) => sum + p.spend, 0)).toBeCloseTo(19.75);
    const other = await adDailySeries({ accountId: B, userId: userB, role: 'owner' }, 'ad', AD);
    expect(other.points[13].spend).toBe(999);
    expect(other.points.reduce((sum, p) => sum + p.clicks, 0)).toBe(999);
  });
});
