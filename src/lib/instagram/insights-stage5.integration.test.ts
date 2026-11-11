// Stage 5 (5F) Instagram home and Insights on a real PostgreSQL: contacts per
// local day of the workspace timezone (active = an inbound Instagram message
// that day), revenue from paid payment links created by Instagram flow runs
// (agents and above; a viewer gets `visible: false`), and the home summary
// (last 7 days, defaults, next moves), each inside its own workspace.
import { randomUUID } from 'node:crypto';
import { config } from 'dotenv';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runAnalytics } from '@/lib/analytics/queries';
import { parseRange } from '@/lib/analytics/range';
import { disconnectDatabases, getPrisma } from '@/lib/db/prisma';
import type { TenantContext } from '@/lib/db/tenant';
import { instagramContactSeries } from './contact-series';
import { instagramHomeSummary } from './home-summary';
import { instagramRevenue } from './revenue';

const configured = config({ path: '.env.test', quiet: true }).parsed;
const ownerUrl = process.env.TEST_DATABASE_URL;
const appUrl = process.env.TEST_APP_DATABASE_URL || configured?.DATABASE_URL;
if (appUrl) process.env.DATABASE_URL = appUrl;

const A = randomUUID(), B = randomUUID(), agentA = randomUUID(), viewerA = randomUUID(), ownerB = randomUUID();
const c1 = randomUUID(), c2 = randomUUID(), c3 = randomUUID(), cB = randomUUID();
const conv1 = randomUUID(), conv2 = randomUUID(), convB = randomUUID(), convWa = randomUUID();
const flow = randomUUID(), flowB = randomUUID(), run1 = randomUUID(), run2 = randomUUID(), runNow = randomUUID(), runB = randomUUID();
const agent: TenantContext = { accountId: A, userId: agentA, role: 'agent' };
const viewer: TenantContext = { accountId: A, userId: viewerA, role: 'viewer' };
const other: TenantContext = { accountId: B, userId: ownerB, role: 'owner' };
// 1-3 October in India (UTC+5:30), read on 3 November.
const range = parseRange({ from: '2026-10-01', to: '2026-10-03' }, 'Asia/Kolkata', new Date('2026-11-03T00:00:00Z'));
const seed = String(Date.now()).slice(-9);
let db: pg.Client;
const q = (sql: string, params: unknown[] = []) => db.query(sql, params);

describe.skipIf(!ownerUrl || !appUrl)('Instagram home and Insights (Stage 5) on PostgreSQL', { timeout: 120_000 }, () => {
  beforeAll(async () => {
    db = new pg.Client({ connectionString: ownerUrl });
    await db.connect();
    if (!/test/i.test((await q('SELECT current_database() AS name')).rows[0].name)) throw new Error('Requires an isolated test database');
    const app = await getPrisma().$queryRaw<{ role: string }[]>`SELECT current_user AS role`;
    if (app[0].role !== 'bodhinox_app') throw new Error('Requires constrained test app credentials');
    await q("INSERT INTO auth_users(id,email,full_name,password_hash) SELECT x, x::text || '@example.invalid', 'IG home', 'test-only-hash' FROM unnest($1::uuid[]) x", [[agentA, viewerA, ownerB]]);
    await q("INSERT INTO accounts(id,name,owner_user_id) VALUES($1,'Home A',$2),($3,'Home B',$4)", [A, agentA, B, ownerB]);
    await q("INSERT INTO account_memberships(account_id,user_id,role) VALUES($1,$2,'agent'),($1,$3,'viewer'),($4,$5,'owner')", [A, agentA, viewerA, B, ownerB]);
    const igA = (await q(`INSERT INTO instagram_accounts(account_id,ig_user_id,username,access_token_enc,scopes,connected_by_user_id,ice_breakers)
      VALUES($1,$2,'shop','x',ARRAY['instagram_business_basic'],$3,'[{"question":"Prices?"}]'::jsonb) RETURNING id`, [A, `74${seed}`, agentA])).rows[0].id;
    const igB = (await q(`INSERT INTO instagram_accounts(account_id,ig_user_id,username,access_token_enc,scopes,connected_by_user_id)
      VALUES($1,$2,'other','x',ARRAY['instagram_business_basic'],$3) RETURNING id`, [B, `75${seed}`, ownerB])).rows[0].id;
    await q(`INSERT INTO contacts(id,account_id,user_id,name,phone) VALUES
      ($1,$5,$6,'One','919800000031'),($2,$5,$6,'Two','919800000032'),($3,$5,$6,'Three','919800000033'),($4,$7,$8,'B','919800000034')`,
    [c1, c2, c3, cB, A, agentA, B, ownerB]);
    // Identities: one before the range, one on 1 October local (19:00 UTC on 30 September), one on 3 October; B's on 1 October.
    await q(`INSERT INTO contact_channel_identities(account_id,contact_id,instagram_account_id,external_id,created_at) VALUES
      ($1,$2,$5,$6,'2026-09-20T10:00:00Z'),($1,$3,$5,$7,'2026-09-30T19:00:00Z'),($1,$4,$5,$8,'2026-10-03T08:00:00Z'),
      ($9,$10,$11,$12,'2026-10-01T08:00:00Z')`,
    [A, c1, c2, c3, igA, `1${seed}1`, `1${seed}2`, `1${seed}3`, B, cB, igB, `1${seed}4`]);
    await q(`INSERT INTO conversations(id,account_id,user_id,contact_id,channel,instagram_account_id) VALUES
      ($1,$4,$5,$6,'instagram',$7),($2,$4,$5,$8,'instagram',$7),($3,$9,$10,$11,'instagram',$12)`,
    [conv1, conv2, convB, A, agentA, c1, igA, c2, B, ownerB, cB, igB]);
    await q('INSERT INTO conversations(id,account_id,user_id,contact_id) VALUES($1,$2,$3,$4)', [convWa, A, agentA, c3]);
    // Inbound messages: c1 at 20:00 UTC on 1 October (2 October in India), twice; c2 on 1 October local; a WhatsApp one and B's never count.
    await q(`INSERT INTO messages(account_id,conversation_id,sender_type,content_type,content_text,status,created_at) VALUES
      ($1,$2,'customer','text','hi','delivered','2026-10-01T20:00:00Z'),($1,$2,'customer','text','hi','delivered','2026-10-01T21:00:00Z'),
      ($1,$3,'customer','text','hi','delivered','2026-10-01T05:00:00Z'),($1,$4,'customer','text','hi','delivered','2026-10-01T05:00:00Z'),
      ($5,$6,'customer','text','hi','delivered','2026-10-01T05:00:00Z')`, [A, conv1, conv2, convWa, B, convB]);
    await q(`INSERT INTO flows(id,account_id,user_id,name,trigger_type,status,channel_scope) VALUES
      ($1,$3,$4,'Reel shop','ig_comment','active','instagram'),($2,$5,$6,'B shop','ig_comment','active','instagram')`, [flow, flowB, A, agentA, B, ownerB]);
    await q(`INSERT INTO flow_runs(id,account_id,flow_id,user_id,contact_id,conversation_id,status,started_at) VALUES
      ($1,$5,$6,$7,$8,$9,'completed','2026-10-02T06:00:00Z'),($2,$5,$6,$7,$10,$11,'completed','2026-10-02T06:00:00Z'),
      ($3,$5,$6,$7,$8,$9,'completed',now()),($4,$12,$13,$14,$15,$16,'completed',now())`,
    [run1, run2, runNow, runB, A, flow, agentA, c1, conv1, c2, conv2, B, flowB, ownerB, cB, convB]);
    const ref = () => `ref_${randomUUID().replace(/-/g, '').slice(0, 24)}`;
    await q(`INSERT INTO payment_links(account_id,provider,reference_id,amount_minor,currency,contact_id,conversation_id,flow_run_id,status,paid_at) VALUES
      ($1,'razorpay',$2,50000,'INR',$7,$8,$9,'paid','2026-10-02T07:00:00Z'),
      ($1,'razorpay',$3,25000,'INR',$10,$11,$12,'paid','2026-10-02T19:00:00Z'),
      ($1,'razorpay',$4,99900,'INR',$7,$8,$9,'created',NULL),
      ($1,'razorpay',$5,10000,'INR',$7,$8,NULL,'paid','2026-10-02T07:00:00Z'),
      ($13,'razorpay',$6,70000,'INR',$14,$15,$16,'paid','2026-10-02T07:00:00Z')`,
    [A, ref(), ref(), ref(), ref(), ref(), c1, conv1, run1, c2, conv2, run2, B, cB, convB, runB]);
    // The last 7 days: one Instagram run, two automated messages (one failed), one comment with a lead.
    await q(`INSERT INTO messages(account_id,conversation_id,sender_type,content_type,content_text,status,created_at) VALUES
      ($1,$2,'bot','text','link','sent',now()),($1,$2,'bot','text','link','delivered',now()),($1,$2,'bot','text','x','failed',now())`, [A, conv1]);
    await q(`INSERT INTO instagram_comment_events(account_id,instagram_account_id,comment_id,media_id,received_at,private_reply_status,flow_run_id,lead_captured_at)
      VALUES($1,$2,$3,'900',now(),'sent',$4,now())`, [A, igA, `17${seed}0001`, runNow]);
  });
  afterAll(async () => {
    if (db) {
      await q('DELETE FROM accounts WHERE id=ANY($1::uuid[])', [[A, B]]);
      await q('DELETE FROM auth_users WHERE id=ANY($1::uuid[])', [[agentA, viewerA, ownerB]]);
      await db.end();
    }
    await disconnectDatabases();
  });

  it('counts contacts per local day of the workspace timezone', async () => {
    const series = await runAnalytics(viewer, (tx) => instagramContactSeries(tx, A, range));
    expect(series).toEqual([
      { day: '2026-10-01', active: 1, inactive: 1, total: 2 },
      { day: '2026-10-02', active: 1, inactive: 1, total: 2 },
      { day: '2026-10-03', active: 0, inactive: 3, total: 3 },
    ]);
    // Another workspace's id from this session reads as empty under RLS.
    const crossed = await runAnalytics(viewer, (tx) => instagramContactSeries(tx, B, range));
    expect(crossed.every((point) => point.total === 0)).toBe(true);
  });

  it('adds up revenue from paid links that Instagram flow runs created, for agents and above', async () => {
    const revenue = await runAnalytics(agent, (tx) => instagramRevenue(tx, A, range, 3));
    expect(revenue.visible).toBe(true);
    expect(revenue.currencies).toHaveLength(1);
    expect(revenue.currencies[0]).toMatchObject({ currency: 'INR', earned: 75000, sales: 2, buyers: 2, perBuyer: 37500, perContact: 25000 });
    // 19:00 UTC on 2 October is 3 October in India.
    expect(revenue.currencies[0].series).toEqual([
      { day: '2026-10-01', earned: 0 }, { day: '2026-10-02', earned: 50000 }, { day: '2026-10-03', earned: 25000 },
    ]);
    expect(revenue.currencies[0].byFlow).toEqual([{ id: flow, name: 'Reel shop', earned: 75000, sales: 2 }]);
  });

  it('shows a viewer no revenue rather than zeros', async () => {
    expect(await runAnalytics(viewer, (tx) => instagramRevenue(tx, A, range, 3))).toEqual({ visible: false, currencies: [] });
  });

  it('summarises the last 7 days, the defaults and the next moves inside the workspace', async () => {
    const summary = await instagramHomeSummary(viewer);
    expect(summary.lastDays.topFlows).toEqual([{ id: flow, name: 'Reel shop', runs: 1, ctr: null }]);
    expect(summary.lastDays.topPosts).toEqual([{ id: '900', comments: 1, leads: 1 }]);
    expect(summary.lastDays.leads).toBe(1);
    expect(summary.lastDays.topLeadFlow).toEqual({ id: flow, name: 'Reel shop', leads: 1 });
    expect(summary.lastDays.automatedMessages).toBe(2);
    expect(summary.lastDays.timeSaved).toEqual({ seconds: 60, hours: 0, minutes: 1 });
    expect(Object.fromEntries(summary.defaults.map((d) => [d.key, d.on]))).toEqual({
      defaultReply: false, conversationStarters: true, menu: false, storyMentions: false, keywords: true,
    });
    expect(Object.fromEntries(summary.nextMoves.map((m) => [m.key, m.done]))).toEqual({
      conversationStarters: true, menu: false, defaultReply: false, refLink: false, aiComments: false, leadCapture: false,
    });

    const theirs = await instagramHomeSummary(other);
    expect(theirs.lastDays.topFlows).toEqual([{ id: flowB, name: 'B shop', runs: 1, ctr: null }]);
    expect(theirs.lastDays.leads).toBe(0);
    expect(theirs.lastDays.automatedMessages).toBe(0);
    expect(theirs.nextMoves.find((m) => m.key === 'conversationStarters')?.done).toBe(false);
  });
});
