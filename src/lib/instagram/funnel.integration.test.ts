// Instagram › Insights on a real PostgreSQL (Stage 3, 3F): the comment funnel
// counts per post and per flow from seeded comment events, the date range, the
// tenancy boundary (a second workspace's comments never appear), and the
// channel filter on the conversation report (legacy NULL channel = WhatsApp).
import { randomUUID } from 'node:crypto';
import { config } from 'dotenv';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { conversationStats, runAnalytics } from '@/lib/analytics/queries';
import { parseRange } from '@/lib/analytics/range';
import { disconnectDatabases, getPrisma } from '@/lib/db/prisma';
import type { TenantContext } from '@/lib/db/tenant';
import { commentFunnel } from './funnel';

const configured = config({ path: '.env.test', quiet: true }).parsed;
const ownerUrl = process.env.TEST_DATABASE_URL;
const appUrl = process.env.TEST_APP_DATABASE_URL || configured?.DATABASE_URL;
const workerUrl = process.env.TEST_WORKER_DATABASE_URL || configured?.WORKER_DATABASE_URL;
if (appUrl) process.env.DATABASE_URL = appUrl;
if (workerUrl) process.env.WORKER_DATABASE_URL = workerUrl;

const A = randomUUID(), B = randomUUID(), ownerA = randomUUID(), ownerB = randomUUID();
const flow = randomUUID(), runX = randomUUID(), runY = randomUUID();
const contactA = randomUUID(), contactB = randomUUID();
const convWa = randomUUID(), convSecond = randomUUID(), convIg = randomUUID(), convOther = randomUUID();
const ctxA: TenantContext = { accountId: A, userId: ownerA, role: 'viewer' };
const range = parseRange({ from: '2026-10-01', to: '2026-10-07' }, 'UTC', new Date('2026-11-03T00:00:00Z'));
const seed = String(Date.now()).slice(-9);
let db: pg.Client;
let igA = '', igB = '';
let n = 0;
const q = (sql: string, params: unknown[] = []) => db.query(sql, params);

async function comment(account: string, ig: string, media: string | null, at: string, extra: Record<string, unknown> = {}) {
  await q(`INSERT INTO instagram_comment_events(account_id,instagram_account_id,comment_id,media_id,received_at,private_reply_status,flow_run_id,
      opted_in_at,link_clicked_at,lead_captured_at,followed_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
  [account, ig, `19${seed}${String(++n).padStart(4, '0')}`, media, at, extra.status ?? 'none', extra.run ?? null,
    extra.optIn ?? null, extra.click ?? null, extra.lead ?? null, extra.follow ?? null]);
}

describe.skipIf(!ownerUrl || !appUrl || !workerUrl)('Instagram insights on PostgreSQL', { timeout: 120_000 }, () => {
  beforeAll(async () => {
    db = new pg.Client({ connectionString: ownerUrl });
    await db.connect();
    if (!/test/i.test((await q('SELECT current_database() AS name')).rows[0].name)) throw new Error('Requires an isolated test database');
    const app = await getPrisma().$queryRaw<{ role: string }[]>`SELECT current_user AS role`;
    if (app[0].role !== 'bodhinox_app') throw new Error('Requires constrained test app credentials');
    await q("INSERT INTO auth_users(id,email,full_name,password_hash) SELECT x, x::text || '@example.invalid', 'Insights', 'test-only-hash' FROM unnest($1::uuid[]) x", [[ownerA, ownerB]]);
    await q("INSERT INTO accounts(id,name,owner_user_id) VALUES($1,'Insights A',$2),($3,'Insights B',$4)", [A, ownerA, B, ownerB]);
    await q("INSERT INTO account_memberships(account_id,user_id,role) VALUES($1,$2,'owner'),($3,$4,'owner')", [A, ownerA, B, ownerB]);
    const addAccount = async (account: string, user: string, igUser: string) => (await q(
      `INSERT INTO instagram_accounts(account_id,ig_user_id,username,access_token_enc,scopes,connected_by_user_id)
       VALUES($1,$2,'shop','x',ARRAY['instagram_business_basic'],$3) RETURNING id`, [account, igUser, user])).rows[0].id as string;
    igA = await addAccount(A, ownerA, `71${seed}`);
    igB = await addAccount(B, ownerB, `72${seed}`);
    await q("INSERT INTO contacts(id,account_id,user_id,name,phone) VALUES($1,$2,$3,'C','919800000001'),($4,$5,$6,'D','919800000002')", [contactA, A, ownerA, contactB, B, ownerB]);
    await q("INSERT INTO flows(id,account_id,user_id,name,trigger_type,status) VALUES($1,$2,$3,'Price flow','keyword','active')", [flow, A, ownerA]);
    await q(`INSERT INTO flow_runs(id,account_id,flow_id,user_id,contact_id,status,started_at) VALUES
      ($1,$3,$4,$5,$6,'completed','2026-10-02T10:00:00Z'),($2,$3,$4,$5,$6,'completed','2026-10-03T10:00:00Z')`, [runX, runY, A, flow, ownerA, contactA]);
    // Post 100: three comments, two DMs sent (one ambiguous), one opened, one click, one lead, one follow.
    await comment(A, igA, '100', '2026-10-02T10:00:00Z', { status: 'sent', run: runX, optIn: '2026-10-02T10:01:00Z', click: '2026-10-02T10:02:00Z', lead: '2026-10-02T10:03:00Z', follow: '2026-10-02T10:04:00Z' });
    await comment(A, igA, '100', '2026-10-03T10:00:00Z', { status: 'unknown', run: runY });
    await comment(A, igA, '100', '2026-10-04T10:00:00Z', { status: 'rejected' });
    // Post 200: one comment, no flow.
    await comment(A, igA, '200', '2026-10-05T10:00:00Z');
    // Outside the range (both sides).
    await comment(A, igA, '100', '2026-09-30T23:59:59Z', { status: 'sent' });
    await comment(A, igA, '100', '2026-10-08T00:00:00Z', { status: 'sent' });
    // Another workspace.
    await comment(B, igB, '100', '2026-10-02T10:00:00Z', { status: 'sent', optIn: '2026-10-02T10:01:00Z' });
    // Channel filter: two WhatsApp and one Instagram conversation (and another workspace's Instagram one).
    const [c2, c3] = [randomUUID(), randomUUID()];
    await q("INSERT INTO contacts(id,account_id,user_id,name,phone) VALUES($1,$3,$4,'E','919800000003'),($2,$3,$4,'F','919800000004')", [c2, c3, A, ownerA]);
    await q(`INSERT INTO conversations(id,account_id,user_id,contact_id,created_at,last_message_at) VALUES
      ($1,$3,$4,$5,'2026-10-02T10:00:00Z','2026-10-02T10:00:00Z'),($2,$3,$4,$6,'2026-10-03T10:00:00Z','2026-10-03T10:00:00Z')`,
    [convWa, convSecond, A, ownerA, contactA, c2]);
    await q(`INSERT INTO conversations(id,account_id,user_id,contact_id,channel,instagram_account_id,created_at,last_message_at) VALUES
      ($1,$3,$4,$5,'instagram',$6,'2026-10-04T10:00:00Z','2026-10-04T10:00:00Z'),
      ($2,$7,$8,$9,'instagram',$10,'2026-10-04T10:00:00Z','2026-10-04T10:00:00Z')`,
    [convIg, convOther, A, ownerA, c3, igA, B, ownerB, contactB, igB]);
  });
  afterAll(async () => {
    if (db) {
      await q('DELETE FROM accounts WHERE id=ANY($1::uuid[])', [[A, B]]);
      await q('DELETE FROM auth_users WHERE id=ANY($1::uuid[])', [[ownerA, ownerB]]);
      await db.end();
    }
    await disconnectDatabases();
  });

  it('counts each step once per comment, per post, inside the range and the workspace', async () => {
    const funnel = await runAnalytics(ctxA, (tx) => commentFunnel(tx, A, range, 'post'));
    expect(funnel.totals).toEqual({ comments: 4, dms: 2, optIns: 1, clicks: 1, leads: 1, follows: 1 });
    expect(funnel.rows).toEqual([
      { id: '100', name: null, comments: 3, dms: 2, optIns: 1, clicks: 1, leads: 1, follows: 1 },
      { id: '200', name: null, comments: 1, dms: 0, optIns: 0, clicks: 0, leads: 0, follows: 0 },
    ]);
  });

  it('groups by the flow that handled the comment and leaves out comments no flow took', async () => {
    const funnel = await runAnalytics(ctxA, (tx) => commentFunnel(tx, A, range, 'flow'));
    expect(funnel.rows).toEqual([{ id: flow, name: 'Price flow', comments: 2, dms: 2, optIns: 1, clicks: 1, leads: 1, follows: 1 }]);
    expect(funnel.totals.comments).toBe(4);
  });

  it('shows another workspace nothing of this one', async () => {
    const other = await runAnalytics({ accountId: B, userId: ownerB, role: 'viewer' }, (tx) => commentFunnel(tx, B, range, 'post'));
    expect(other.totals).toEqual({ comments: 1, dms: 1, optIns: 1, clicks: 0, leads: 0, follows: 0 });
    // Naming the other workspace's id from this workspace's session reads as empty under RLS.
    const crossed = await runAnalytics(ctxA, (tx) => commentFunnel(tx, B, range, 'post'));
    expect(crossed.totals.comments).toBe(0);
  });

  it('filters the conversation report by channel and never counts another workspace', async () => {
    const started = (channel?: 'whatsapp' | 'instagram') =>
      runAnalytics(ctxA, (tx) => conversationStats(tx, A, range, { channel })).then((s) => s.started.total);
    expect(await started()).toBe(3);
    expect(await started('instagram')).toBe(1);
    expect(await started('whatsapp')).toBe(2);
  });
});
