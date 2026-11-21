import { randomUUID } from 'node:crypto';
import { config } from 'dotenv';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { disconnectDatabases, getPrisma } from '@/lib/db/prisma';
import { withTenant, type TenantContext } from '@/lib/db/tenant';
import { readDailyRows, rollupDays } from './daily';
import { aiUsageTotals, estimateAiCost } from './ai-cost';
import { parseRange } from './range';
import { analyticsRollupDedupeKey, resetAnalyticsRollupScheduleForTests, runAnalyticsRollup, scheduleAnalyticsRollups } from './rollup-job';
import { loadBusinessCards } from '@/lib/dashboard/business';

const configured = config({ path: '.env.test', quiet: true }).parsed;
const ownerUrl = process.env.TEST_DATABASE_URL;
const appUrl = process.env.TEST_APP_DATABASE_URL || configured?.DATABASE_URL;
const workerUrl = process.env.TEST_WORKER_DATABASE_URL || configured?.WORKER_DATABASE_URL;
if (appUrl) process.env.DATABASE_URL = appUrl;
if (workerUrl) process.env.WORKER_DATABASE_URL = workerUrl;

const A = randomUUID(), B = randomUUID();
const owner = randomUUID(), agent = randomUUID(), ownerB = randomUUID(), viewer = randomUUID();
const [cA, cA2, cB] = [randomUUID(), randomUUID(), randomUUID()];
const [vA, vA2, vB] = [randomUUID(), randomUUID(), randomUUID()];
const seed = `${Date.now()}`.slice(-8);
// Workspace A runs on Kolkata days: 2026-10-10 starts at 2026-10-09T18:30Z.
const DAY = '2026-10-10';
let db: pg.Client;
const q = (sql: string, params: unknown[] = []) => db.query(sql, params);
const msg = (account: string, conversation: string, sender: string, at: string, extra: { senderId?: string; ai?: boolean; contentType?: string } = {}) =>
  q(`INSERT INTO messages(account_id,conversation_id,sender_type,content_type,content_text,status,created_at,sender_id,ai_generated)
     VALUES($1,$2,$3,$4,'body','delivered',$5,$6,$7)`,
  [account, conversation, sender, extra.contentType ?? 'text', at, extra.senderId ?? null, extra.ai ?? false]);
// The day as text: node-postgres turns a date into a local-midnight Date, which shifts with the test machine's zone.
const daily = (account: string) => q(`SELECT d.*, to_char(d.day, 'YYYY-MM-DD') AS day FROM analytics_daily d
  WHERE d.account_id=$1 ORDER BY d.day`, [account]);

describe.skipIf(!ownerUrl || !appUrl || !workerUrl)('analytics daily rollup on PostgreSQL', { timeout: 120_000 }, () => {
  beforeAll(async () => {
    db = new pg.Client({ connectionString: ownerUrl });
    await db.connect();
    if (!/test/i.test((await q('SELECT current_database() AS name')).rows[0].name)) throw new Error('Requires an isolated test database');
    const app = await getPrisma().$queryRaw<{ role: string }[]>`SELECT current_user AS role`;
    if (app[0].role !== 'bodhinox_app') throw new Error('Requires constrained test app credentials');
    await q("INSERT INTO auth_users(id,email,full_name,password_hash) SELECT x, x::text || '@example.invalid', 'Daily', 'test-only-hash' FROM unnest($1::uuid[]) x",
      [[owner, agent, ownerB, viewer]]);
    await q("INSERT INTO accounts(id,name,owner_user_id) VALUES($1,'Daily A',$2),($3,'Daily B',$4)", [A, owner, B, ownerB]);
    await q("INSERT INTO account_memberships(account_id,user_id,role) VALUES($1,$2,'owner'),($1,$3,'agent'),($1,$5,'viewer'),($4,$6,'owner')",
      [A, owner, agent, B, viewer, ownerB]);
    await q("INSERT INTO workspace_inbox_settings(account_id,timezone) VALUES($1,'Asia/Kolkata')", [A]);
    await q("INSERT INTO contacts(id,account_id,user_id,name,phone) VALUES($1,$4,$5,'A','9197'||$7),($2,$4,$5,'A2','9196'||$7),($3,$6,$8,'B','9195'||$7)",
      [cA, cA2, cB, A, owner, B, seed, ownerB]);
    await q(`INSERT INTO conversations(id,account_id,user_id,contact_id,created_at,last_message_at,status) VALUES
      ($1,$4,$5,$6,'2026-10-10T04:00:00Z','2026-10-10T05:00:00Z','open'),
      ($2,$4,$5,$7,'2026-10-10T06:00:00Z','2026-10-10T07:00:00Z','open'),
      ($3,$8,$9,$10,'2026-10-10T04:00:00Z','2026-10-10T05:00:00Z','open')`, [vA, vA2, vB, A, owner, cA, cA2, B, ownerB, cB]);
    // A: one wait answered by a member after 5 minutes, one answered by the AI after 1 minute; a flow bot message is not a reply.
    await msg(A, vA, 'customer', '2026-10-10T04:00:00Z');
    await msg(A, vA, 'bot', '2026-10-10T04:00:30Z');
    await msg(A, vA, 'agent', '2026-10-10T04:05:00Z', { senderId: agent });
    await msg(A, vA2, 'customer', '2026-10-10T06:00:00Z');
    await msg(A, vA2, 'bot', '2026-10-10T06:01:00Z', { ai: true });
    // A message at 2026-10-09T19:00Z is already 2026-10-10 in Kolkata (00:30). It starts vA's wait: the 04:00 message
    // belongs to the same wait, so the member reply at 04:05 answers a wait of 9h05m.
    await msg(A, vA, 'customer', '2026-10-09T19:00:00Z');
    // B: lots of traffic that must never show in A.
    for (let i = 0; i < 5; i++) await msg(B, vB, 'customer', `2026-10-10T04:0${i}:00Z`);
    await q(`INSERT INTO orders(id,account_id,source,currency,subtotal_minor,discount_minor,shipping_minor,tax_minor,tax_inclusive,total_minor,status,priced_at,paid_at,amount_paid_minor)
      VALUES($1,$2,'storefront','INR',50000,0,0,0,true,50000,'paid','2026-10-10T05:00:00Z','2026-10-10T05:00:00Z',50000),
            ($3,$4,'storefront','INR',99900,0,0,0,true,99900,'paid','2026-10-10T05:00:00Z','2026-10-10T05:00:00Z',99900)`,
    [randomUUID(), A, randomUUID(), B]);
    await q(`INSERT INTO ai_usage_log(account_id,mode,provider,model,prompt_tokens,completion_tokens,total_tokens,created_at) VALUES
      ($1,'auto_reply','anthropic','claude-haiku-5-5',1000000,200000,1200000,'2026-10-10T06:01:00Z'),
      ($2,'auto_reply','anthropic','claude-haiku-5-5',5,5,10,'2026-10-10T06:01:00Z')`, [A, B]);
  });

  afterAll(async () => {
    if (db) {
      await q("DELETE FROM jobs WHERE type='analytics.rollup' AND tenant_id = ANY($1::uuid[])", [[A, B]]);
      await q('DELETE FROM accounts WHERE id = ANY($1::uuid[])', [[A, B]]);
      await q('DELETE FROM auth_users WHERE id = ANY($1::uuid[])', [[owner, agent, ownerB, viewer]]);
      await db.end();
    }
    await disconnectDatabases();
  });

  it('rolls a day on the workspace timezone with the one first-reply definition, and a re-run gives the same rows', async () => {
    expect(await rollupDays(A, '2026-10-09', '2026-10-11')).toBe(3);
    const first = (await daily(A)).rows;
    expect(first.map((r) => r.day)).toEqual(['2026-10-09', '2026-10-10', '2026-10-11']);
    const day = first[1];
    expect(day).toMatchObject({
      messages_in: 3, messages_out: 3, conversations_opened: 2,
      first_reply_count: 2, first_reply_unanswered: 0, first_reply_median_seconds: 16380, first_reply_seconds: [60, 32700],
      ai_replies: 1, paid_orders: 1, revenue_minor: { INR: 50000 },
    });
    // A quiet day still gets a zero row, so a missing row means "not rolled yet".
    expect(first[0]).toMatchObject({ messages_in: 0, first_reply_median_seconds: null });

    // Idempotent: the same window again leaves the same figures and no duplicates.
    expect(await rollupDays(A, '2026-10-09', '2026-10-11')).toBe(3);
    const second = (await daily(A)).rows;
    const figures = (rows: Record<string, unknown>[]) => rows.map((r) => { const copy = { ...r }; delete copy.rolled_at; return copy; });
    expect(figures(second)).toEqual(figures(first));
    const usage = await q('SELECT provider, model, calls, prompt_tokens::int AS p FROM analytics_daily_ai_usage WHERE account_id=$1', [A]);
    expect(usage.rows).toEqual([{ provider: 'anthropic', model: 'claude-haiku-5-5', calls: 1, p: 1000000 }]);
  });

  it('writes only the rolled workspace and keeps each workspace to its own rows', async () => {
    expect((await daily(B)).rows).toEqual([]);
    await rollupDays(B, DAY, DAY);
    expect((await daily(B)).rows[0]).toMatchObject({ messages_in: 5, revenue_minor: { INR: 99900 }, first_reply_unanswered: 1 });
    expect((await daily(A)).rows[1]).toMatchObject({ messages_in: 3, revenue_minor: { INR: 50000 } });
    // The app role reads its own workspace only (RLS), even when it names the other workspace.
    const seen = await withTenant({ accountId: A, userId: owner, role: 'owner' }, (tx) =>
      tx.$queryRaw<{ account_id: string }[]>`SELECT account_id::text FROM analytics_daily WHERE account_id IN (${A}::uuid, ${B}::uuid)`);
    expect(new Set(seen.map((r) => r.account_id))).toEqual(new Set([A]));
    // The app role cannot write the summary: only the worker job does.
    await expect(withTenant({ accountId: A, userId: owner, role: 'owner' }, (tx) =>
      tx.$executeRaw`UPDATE analytics_daily SET messages_in=999 WHERE account_id=${A}::uuid`)).rejects.toThrow();
  });

  it('keeps AI token usage (billing-class) to admins', async () => {
    const range = parseRange({ from: DAY, to: DAY }, 'Asia/Kolkata', new Date('2026-11-01T00:00:00Z'));
    const asAdmin = await withTenant({ accountId: A, userId: owner, role: 'owner' }, (tx) => aiUsageTotals(tx, A, range, new Date('2026-11-01T00:00:00Z')));
    expect(estimateAiCost(asAdmin)).toMatchObject({ estimatedUsd: 0.2, unpricedTokens: 0 }); // 1M x $0.10 + 0.2M x $0.50
    const asAgent = await withTenant({ accountId: A, userId: agent, role: 'agent' }, (tx) => aiUsageTotals(tx, A, range, new Date('2026-11-01T00:00:00Z')));
    expect(asAgent).toEqual([]);
  });

  it('reads stored days and computes a day the rollup has not reached live', async () => {
    // Make the stored row recognisably different from a live computation.
    await q("UPDATE analytics_daily SET messages_in=42 WHERE account_id=$1 AND day='2026-10-10'", [A]);
    const ctx: TenantContext = { accountId: A, userId: owner, role: 'owner' };
    const rows = await withTenant(ctx, (tx) => readDailyRows(tx, A, 'Asia/Kolkata', '2026-10-10', '2026-10-12', new Date('2026-11-01T00:00:00Z')));
    expect(rows.map((r) => r.day)).toEqual(['2026-10-10', '2026-10-11', '2026-10-12']);
    expect(rows[0].messagesIn).toBe(42); // stored
    expect(rows[2]).toMatchObject({ messagesIn: 0, firstReplyMedianSeconds: null }); // not rolled: live
    // "Today" is always live, even when a row exists for it.
    const today = await withTenant(ctx, (tx) => readDailyRows(tx, A, 'Asia/Kolkata', DAY, DAY, new Date('2026-10-10T12:00:00Z')));
    expect(today[0].messagesIn).toBe(3);
    await q("UPDATE analytics_daily SET messages_in=3 WHERE account_id=$1 AND day='2026-10-10'", [A]);
  });

  it('schedules one job per workspace per local day and the job rolls its own workspace', async () => {
    resetAnalyticsRollupScheduleForTests();
    const now = new Date('2026-10-13T00:00:00Z').getTime();
    await scheduleAnalyticsRollups(now, true);
    await scheduleAnalyticsRollups(now, true);
    const key = analyticsRollupDedupeKey(A, '2026-10-13');
    expect((await q('SELECT count(*)::int AS n FROM jobs WHERE dedupe_key=$1', [key])).rows[0].n).toBe(1);
    // Rolls 10..12 October on Kolkata days (yesterday and the two before).
    expect(await runAnalyticsRollup(A, new Date(now))).toBe(3);
    await expect(runAnalyticsRollup('not-a-uuid')).rejects.toThrow();
  });

  it('home business cards: money and AI for members, bookings only for viewers', async () => {
    const now = new Date('2026-10-10T12:00:00Z');
    const cards = await loadBusinessCards({ accountId: A, userId: agent, role: 'agent' }, now);
    expect(cards.revenue).toMatchObject({ todayMinor: { INR: 50000 }, paidOrders7Days: 1 });
    expect(cards.aiHandled).toEqual({ today: 0, last7Days: 0 });
    expect(cards.adSpend).toBeNull(); // no Meta ads data
    expect(cards.bookings).toEqual({ today: 0, upcomingToday: 0, next7Days: 0 });
    const forViewer = await loadBusinessCards({ accountId: A, userId: viewer, role: 'viewer' }, now);
    expect(forViewer).toMatchObject({ revenue: null, adSpend: null, aiHandled: null });
    const forB = await loadBusinessCards({ accountId: B, userId: ownerB, role: 'owner' }, now);
    expect(forB.revenue?.todayMinor).toEqual({ INR: 99900 });
  });
});
