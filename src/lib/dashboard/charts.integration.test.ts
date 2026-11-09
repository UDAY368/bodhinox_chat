import { randomUUID } from 'node:crypto';
import { config } from 'dotenv';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { disconnectDatabases, getPrisma } from '@/lib/db/prisma';
import { loadDashboardCharts } from './charts';

const configured = config({ path: '.env.test', quiet: true }).parsed;
const ownerUrl = process.env.TEST_DATABASE_URL;
const appUrl = process.env.TEST_APP_DATABASE_URL || configured?.DATABASE_URL;
if (appUrl) process.env.DATABASE_URL = appUrl;

const A = randomUUID(), B = randomUUID();
const ownerA = randomUUID(), ownerB = randomUUID();
const contactA = randomUUID(), contactB = randomUUID(), busy = randomUUID(), waited = randomUUID(), convB = randomUUID();
const pipeline = randomUUID(), stage = randomUUID(), pipelineB = randomUUID(), stageB = randomUUID();
const seed = `${Date.now()}`.slice(-8);
let db: pg.Client;
const q = (sql: string, params: unknown[] = []) => db.query(sql, params);
const kolkataToday = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());

describe.skipIf(!ownerUrl || !appUrl)('dashboard charts on PostgreSQL', { timeout: 120_000 }, () => {
  beforeAll(async () => {
    db = new pg.Client({ connectionString: ownerUrl });
    await db.connect();
    if (!/test/i.test((await q('SELECT current_database() AS name')).rows[0].name)) throw new Error('Requires an isolated test database');
    const app = await getPrisma().$queryRaw<{ role: string }[]>`SELECT current_user AS role`;
    if (app[0].role !== 'bodhinox_app') throw new Error('Requires constrained test app credentials');
    await q("INSERT INTO auth_users(id,email,full_name,password_hash) SELECT x, x::text || '@example.invalid', 'Charts', 'test-only-hash' FROM unnest($1::uuid[]) x", [[ownerA, ownerB]]);
    await q("INSERT INTO accounts(id,name,owner_user_id) VALUES($1,'Charts A',$2),($3,'Charts B',$4)", [A, ownerA, B, ownerB]);
    await q("INSERT INTO account_memberships(account_id,user_id,role) VALUES($1,$2,'owner'),($3,$4,'owner')", [A, ownerA, B, ownerB]);
    await q("INSERT INTO workspace_inbox_settings(account_id,timezone) VALUES($1,'Asia/Kolkata')", [A]);
    await q("INSERT INTO contacts(id,account_id,user_id,name,phone) VALUES($1,$2,$3,'A',$4),($5,$6,$7,'B',$8)",
      [contactA, A, ownerA, `9196${seed}`, contactB, B, ownerB, `9195${seed}`]);
    await q(`INSERT INTO conversations(id,account_id,user_id,contact_id) VALUES($1,$4,$5,$6),($2,$4,$5,$6),($3,$7,$8,$9)`,
      [busy, waited, convB, A, ownerA, contactA, B, ownerB, contactB]);
    // 1,200 messages in the last hour: more than the data API's 1,000-row page.
    await q(`INSERT INTO messages(account_id,conversation_id,sender_type,content_type,content_text,status,created_at)
      SELECT $1,$2,CASE WHEN n % 2 = 0 THEN 'customer' ELSE 'bot' END,'text','body','delivered', now() - (n * interval '2 seconds')
      FROM generate_series(1,1200) n`, [A, busy]);
    // One customer wait in the waited conversation: two customer messages, then a reply 20 minutes after the first.
    await q(`INSERT INTO messages(account_id,conversation_id,sender_type,content_type,content_text,status,created_at) VALUES
      ($1,$2,'customer','text','body','delivered', now() - interval '3 hours'),
      ($1,$2,'customer','text','body','delivered', now() - interval '2 hours 55 minutes'),
      ($1,$2,'agent','text','body','delivered', now() - interval '2 hours 40 minutes'),
      ($1,$2,'agent','text','body','delivered', now() - interval '2 hours 30 minutes')`, [A, waited]);
    // Workspace B: must never appear in A's charts.
    await q(`INSERT INTO messages(account_id,conversation_id,sender_type,content_type,content_text,status,created_at)
      SELECT $1,$2,'customer','text','body','delivered', now() - interval '1 minute' FROM generate_series(1,5)`, [B, convB]);
    await q("INSERT INTO pipelines(id,account_id,user_id,name) VALUES($1,$2,$3,'Sales'),($4,$5,$6,'B sales')", [pipeline, A, ownerA, pipelineB, B, ownerB]);
    await q("INSERT INTO pipeline_stages(id,account_id,pipeline_id,name) VALUES($1,$2,$3,'New'),($4,$5,$6,'B new')", [stage, A, pipeline, stageB, B, pipelineB]);
    await q(`INSERT INTO deals(account_id,user_id,pipeline_id,stage_id,title,value,status)
      SELECT $1,$2,$3,$4,'Deal ' || n, 2, CASE WHEN n <= 1100 THEN 'open' ELSE 'won' END FROM generate_series(1,1105) n`, [A, ownerA, pipeline, stage]);
    await q("INSERT INTO deals(account_id,user_id,pipeline_id,stage_id,title,value,status) VALUES($1,$2,$3,$4,'B deal',999,'open')", [B, ownerB, pipelineB, stageB]);
  });
  afterAll(async () => {
    if (db) {
      await q('DELETE FROM accounts WHERE id=ANY($1::uuid[])', [[A, B]]);
      await q('DELETE FROM auth_users WHERE id=ANY($1::uuid[])', [[ownerA, ownerB]]);
      await db.end();
    }
    await disconnectDatabases();
  });

  it('counts every message on the workspace timezone days and totals every open deal', async () => {
    const charts = await loadDashboardCharts({ accountId: A, userId: ownerA, role: 'viewer' }, 7);
    expect(charts.timezone).toBe('Asia/Kolkata');
    expect(charts.series).toHaveLength(7);
    expect(charts.series.at(-1)?.day).toBe(kolkataToday());
    const incoming = charts.series.reduce((sum, d) => sum + d.incoming, 0);
    const outgoing = charts.series.reduce((sum, d) => sum + d.outgoing, 0);
    expect(incoming).toBe(600 + 2);
    expect(outgoing).toBe(600 + 2);
    expect(charts.dealsByStage).toEqual([{ stageId: stage, count: 1100, value: 2200 }]);
  });

  it('times each customer wait from its first message to the next reply', async () => {
    const { responseTime } = await loadDashboardCharts({ accountId: A, userId: ownerA, role: 'agent' }, 30);
    expect(responseTime.buckets).toHaveLength(7);
    // The busy conversation alternates customer/bot: 600 waits of 2 seconds; plus the 20-minute wait.
    const samples = responseTime.buckets.reduce((sum, b) => sum + b.samples, 0);
    expect(samples).toBe(601);
    const total = responseTime.buckets.reduce((sum, b) => sum + (b.avgMinutes ?? 0) * b.samples, 0);
    expect(total).toBeCloseTo(600 * (2 / 60) + 20, 3);
  });

  it('keeps each workspace to its own rows', async () => {
    const charts = await loadDashboardCharts({ accountId: B, userId: ownerB, role: 'owner' }, 7);
    expect(charts.timezone).toBe('UTC');
    expect(charts.series.reduce((sum, d) => sum + d.incoming + d.outgoing, 0)).toBe(5);
    expect(charts.dealsByStage).toEqual([{ stageId: stageB, count: 1, value: 999 }]);
    await expect(loadDashboardCharts({ accountId: A, role: 'owner' }, 14)).rejects.toThrow(RangeError);
  });
});
