import { randomUUID } from 'node:crypto';
import { config } from 'dotenv';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { disconnectDatabases, getPrisma, getWorkerPrisma } from '@/lib/db/prisma';
import { withTenant, type TenantContext } from '@/lib/db/tenant';
import { parseRange } from './range';
import { agentDayRows } from './reports';
import { agentLeaderboard, aiStats, campaignFunnel, conversationStats, flowStats, runAnalytics, templateDaily } from './queries';
import { estimateCampaignCost, listRateCards, upsertRateCards } from './rate-card';

const configured = config({ path: '.env.test', quiet: true }).parsed;
const ownerUrl = process.env.TEST_DATABASE_URL;
const appUrl = process.env.TEST_APP_DATABASE_URL || configured?.DATABASE_URL;
const workerUrl = process.env.TEST_WORKER_DATABASE_URL || configured?.WORKER_DATABASE_URL;
if (appUrl) process.env.DATABASE_URL = appUrl;
if (workerUrl) process.env.WORKER_DATABASE_URL = workerUrl;

const A = randomUUID(), B = randomUUID();
const owner = randomUUID(), agentX = randomUUID(), agentY = randomUUID(), ownerB = randomUUID();
const team = randomUUID(), number1 = randomUUID(), number2 = randomUUID(), flow = randomUUID();
const runHanded = randomUUID(), runFailed = randomUUID();
const [c1, c2, c3, c4, c5, cb] = Array.from({ length: 6 }, () => randomUUID());
const [v1, v2, v3, v4, v5, vb] = Array.from({ length: 6 }, () => randomUUID());
const [b0, b1, b2, bB] = Array.from({ length: 4 }, () => randomUUID());
const ctxA: TenantContext = { accountId: A, userId: owner, role: 'viewer' };
const ctxB: TenantContext = { accountId: B, userId: ownerB, role: 'owner' };
// Fixed past week (UTC): 2026-10-01 .. 2026-10-07.
const range = parseRange({ from: '2026-10-01', to: '2026-10-07' }, 'UTC', new Date('2026-11-03T00:00:00Z'));
const seed = `${Date.now()}`.slice(-8);
const rateCountry = 'ZW', rateCurrency = 'XTS'; // XTS: ISO 4217 code reserved for testing.
let db: pg.Client;

const q = (sql: string, params: unknown[] = []) => db.query(sql, params);
const msg = (account: string, conversation: string, sender: string, at: string, extra: Record<string, unknown> = {}) =>
  q(`INSERT INTO messages(account_id,conversation_id,sender_type,content_type,content_text,status,created_at,sender_id,ai_generated,template_name)
     VALUES($1,$2,$3,$4,'body',$5,$6,$7,$8,$9)`,
  [account, conversation, sender, extra.contentType ?? 'text', extra.status ?? 'delivered', at, extra.senderId ?? null, extra.ai ?? false, extra.template ?? null]);

describe.skipIf(!ownerUrl || !appUrl || !workerUrl)('analytics reports on PostgreSQL', { timeout: 120_000 }, () => {
  beforeAll(async () => {
    db = new pg.Client({ connectionString: ownerUrl });
    await db.connect();
    if (!/test/i.test((await q('SELECT current_database() AS name')).rows[0].name)) throw new Error('Requires an isolated test database');
    const app = await getPrisma().$queryRaw<{ role: string }[]>`SELECT current_user AS role`;
    if (app[0].role !== 'bodhinox_app') throw new Error('Requires constrained test app credentials');
    await q("INSERT INTO auth_users(id,email,full_name,password_hash) SELECT x, x::text || '@example.invalid', 'Analytics', 'test-only-hash' FROM unnest($1::uuid[]) x",
      [[owner, agentX, agentY, ownerB]]);
    await q("INSERT INTO accounts(id,name,owner_user_id) VALUES($1,'Analytics A',$2),($3,'Analytics B',$4)", [A, owner, B, ownerB]);
    await q("INSERT INTO account_memberships(account_id,user_id,role) VALUES($1,$2,'owner'),($1,$3,'agent'),($1,$4,'agent'),($5,$6,'owner')", [A, owner, agentX, agentY, B, ownerB]);
    await q(`INSERT INTO profiles(user_id,full_name,email,account_id,account_role) VALUES($1,'Olu','o@example.invalid',$4,'owner'),($2,'Xia','x@example.invalid',$4,'agent'),($3,'Yan','y@example.invalid',$4,'agent')
      ON CONFLICT (user_id) DO UPDATE SET full_name=EXCLUDED.full_name`, [owner, agentX, agentY, A]);
    await q("INSERT INTO teams(id,account_id,name) VALUES($1,$2,'Support')", [team, A]);
    await q('INSERT INTO team_members(account_id,team_id,user_id) VALUES($1,$2,$3)', [A, team, agentX]);
    await q("INSERT INTO whatsapp_config(id,account_id,user_id,phone_number_id,access_token,status) VALUES($1,$3,$4,$5,'unused','disconnected'),($2,$3,$4,$6,'unused','disconnected')",
      [number1, number2, A, owner, `81${seed}`, `82${seed}`]);
    await q(`INSERT INTO contacts(id,account_id,user_id,name,phone) SELECT id, $1, $2, 'C', '9198' || lpad(n::text, 8, '0') FROM unnest($3::uuid[]) WITH ORDINALITY t(id, n)`,
      [A, owner, [c1, c2, c3, c4, c5]]);
    await q("INSERT INTO contacts(id,account_id,user_id,name,phone) VALUES($1,$2,$3,'B','14155550199')", [cb, B, ownerB]);
    const conv = (id: string, contact: string, created: string, extra: Record<string, unknown>) =>
      q(`INSERT INTO conversations(id,account_id,user_id,contact_id,created_at,last_message_at,inbound_created_meta_id,assigned_agent_id,whatsapp_config_id,status,ai_handoff_summary,ai_handoff_at)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [id, extra.account ?? A, extra.user ?? owner, contact, created, extra.last ?? created, extra.meta ?? null, extra.agent ?? null, extra.number ?? null, extra.status ?? 'open', extra.handoff ?? null, extra.handoffAt ?? null]);
    await conv(v1, c1, '2026-10-02T10:00:00Z', { meta: `wamid.v1.${seed}`, agent: agentX, number: number1, status: 'closed' });
    await conv(v2, c2, '2026-10-03T09:00:00Z', { agent: agentY, number: number2, handoff: 'needs a person', handoffAt: '2026-10-03T10:03:00Z' });
    await conv(v3, c3, '2026-10-04T08:00:00Z', { meta: `wamid.v3.${seed}`, number: number2 });
    await conv(v4, c4, '2026-09-01T08:00:00Z', { agent: agentX, last: '2026-10-05T10:10:00Z', number: number2 });
    await conv(v5, c5, '2026-10-06T10:00:00Z', { meta: `wamid.v5.${seed}`, status: 'closed', number: number2 });
    await conv(vb, cb, '2026-10-02T10:00:00Z', { account: B, user: ownerB, meta: `wamid.vb.${seed}`, status: 'closed' });
    // The lifecycle trigger stamps resolved_at with now(); set the real times (that update does not fire it).
    await q("UPDATE conversations SET resolved_at = CASE id WHEN $1 THEN '2026-10-02T12:00:00Z'::timestamptz WHEN $2 THEN '2026-10-06T11:00:00Z'::timestamptz ELSE '2026-10-02T11:00:00Z'::timestamptz END WHERE id = ANY($3::uuid[])",
      [v1, v5, [v1, v5, vb]]);

    await msg(A, v1, 'customer', '2026-10-02T10:00:00Z');
    await msg(A, v1, 'customer', '2026-10-02T10:01:00Z');
    await msg(A, v1, 'agent', '2026-10-02T10:05:00Z', { senderId: agentX });
    await msg(A, v2, 'agent', '2026-10-03T09:00:00Z', { contentType: 'template', template: 'promo', status: 'read' });
    await msg(A, v2, 'customer', '2026-10-03T10:00:00Z');
    await msg(A, v2, 'bot', '2026-10-03T10:02:00Z', { ai: true });
    await msg(A, v3, 'customer', '2026-10-04T08:00:00Z');
    await msg(A, v4, 'customer', '2026-10-05T10:00:00Z');
    await msg(A, v4, 'agent', '2026-10-05T10:10:00Z');
    await msg(A, v5, 'customer', '2026-10-06T10:00:00Z');
    await msg(A, v5, 'bot', '2026-10-06T10:01:00Z', { ai: true });
    // Workspace B: busy, and must never show up in A's numbers.
    await msg(B, vb, 'customer', '2026-10-02T10:00:00Z');
    await msg(B, vb, 'agent', '2026-10-02T10:00:30Z', { contentType: 'template', template: 'promo' });
    await msg(B, vb, 'bot', '2026-10-02T10:00:40Z', { ai: true });

    // Click-to-WhatsApp referrals on the creating messages: v3 (also a campaign reply; ad wins) and v5
    // from ads, v1 from a boosted post (stays a plain inbound start), and B's conversation from an ad.
    // A re-click later in v4 (created before the range) changes nothing.
    await q(`UPDATE messages m SET message_id = c.inbound_created_meta_id FROM conversations c
      WHERE c.id = m.conversation_id AND c.id = ANY($1::uuid[]) AND m.sender_type = 'customer'
        AND m.created_at = c.created_at`, [[v1, v3, v5, vb]]);
    await q(`INSERT INTO ad_referrals(account_id,contact_id,conversation_id,message_id,wa_message_id,source_id,source_type,ctwa_clid)
      SELECT c.account_id, c.contact_id, c.id, m.id, COALESCE(m.message_id, 'wamid.later.' || c.id), x.source_id, x.source_type, x.clid
      FROM (VALUES ($1::uuid,'1201','ad','clid-v3'), ($2::uuid,'1202','ad',NULL), ($3::uuid,'55_66','post',NULL),
        ($4::uuid,'1203','ad','clid-vb'), ($5::uuid,'1204','ad','clid-v4')) x(conversation_id, source_id, source_type, clid)
      JOIN conversations c ON c.id = x.conversation_id
      JOIN LATERAL (SELECT id, message_id FROM messages WHERE conversation_id = c.id AND sender_type = 'customer'
        ORDER BY created_at LIMIT 1) m ON true`, [v3, v5, v1, vb, v4]);

    await q(`INSERT INTO broadcasts(id,account_id,user_id,name,template_name,status,scheduled_at,created_at) VALUES
      ($1,$5,$6,'Old','promo','sent','2026-09-01T07:00:00Z','2026-09-01T06:00:00Z'),
      ($2,$5,$6,'October','promo','sent','2026-10-04T07:00:00Z','2026-10-03T06:00:00Z'),
      ($3,$5,$6,'Empty','promo','draft',NULL,'2026-10-05T06:00:00Z'),
      ($4,$7,$8,'B launch','promo','sent','2026-10-04T07:00:00Z','2026-10-04T06:00:00Z')`, [b0, b1, b2, bB, A, owner, B, ownerB]);
    // October goes out from number2, where c3's reply (v3) arrives.
    await q('UPDATE broadcasts SET whatsapp_config_id=$1 WHERE id=$2', [number2, b1]);
    await q(`INSERT INTO broadcast_recipients(account_id,broadcast_id,contact_id,status,sent_at,delivered_at,read_at,clicked_at) VALUES
      ($1,$2,$4,'read','2026-10-04T07:00:00Z','2026-10-04T07:01:00Z','2026-10-04T07:02:00Z',NULL),
      ($1,$2,$5,'delivered','2026-10-04T07:00:00Z','2026-10-04T07:01:00Z',NULL,'2026-10-04T07:30:00Z'),
      ($1,$2,$6,'failed',NULL,NULL,NULL,NULL),
      ($1,$3,$4,'delivered','2026-09-01T07:00:00Z','2026-09-01T07:01:00Z',NULL,NULL),
      ($7,$8,$9,'read','2026-10-04T07:00:00Z','2026-10-04T07:01:00Z','2026-10-04T07:02:00Z','2026-10-04T07:03:00Z')`,
    [A, b1, b0, c3, c1, c2, B, bB, cb]);

    await q("INSERT INTO flows(id,account_id,user_id,name,trigger_type,status) VALUES($1,$2,$3,'Welcome','keyword','active')", [flow, A, owner]);
    await q(`INSERT INTO flow_nodes(account_id,flow_id,node_key,node_type) VALUES($1,$2,'start','start'),($1,$2,'ask','send_buttons'),
      ($1,$2,'human','handoff'),($1,$2,'send','send_message')`, [A, flow]);
    // current_node_key moves only at waiting points, so the handed-off and
    // failed runs still name the question / start node; their events say where
    // they really stopped. The timed-out run has no events and falls back.
    await q(`INSERT INTO flow_runs(id,account_id,flow_id,user_id,contact_id,status,current_node_key,started_at) VALUES
      (gen_random_uuid(),$1,$2,$3,$4,'completed','end','2026-10-02T10:00:00Z'), ($6,$1,$2,$3,$4,'handed_off','ask','2026-10-03T10:00:00Z'),
      (gen_random_uuid(),$1,$2,$3,$4,'timed_out','ask','2026-10-04T10:00:00Z'), ($7,$1,$2,$3,$4,'failed','start','2026-10-05T10:00:00Z'),
      (gen_random_uuid(),$1,$2,$3,$5,'active','ask','2026-10-06T10:00:00Z'), (gen_random_uuid(),$1,$2,$3,$5,'failed','start','2026-09-05T10:00:00Z')`,
    [A, flow, owner, c1, c2, runHanded, runFailed]);
    await q(`INSERT INTO flow_run_events(account_id,flow_run_id,event_type,node_key,created_at) VALUES
      ($1,$2,'started','start','2026-10-03T10:00:00Z'), ($1,$2,'node_entered','ask','2026-10-03T10:00:01Z'),
      ($1,$2,'reply_received','ask','2026-10-03T10:05:00Z'), ($1,$2,'node_entered','human','2026-10-03T10:05:01Z'),
      ($1,$2,'handoff','human','2026-10-03T10:05:02Z'),
      ($1,$3,'started','start','2026-10-05T10:00:00Z'), ($1,$3,'node_entered','start','2026-10-05T10:00:01Z'),
      ($1,$3,'error','send','2026-10-05T10:00:02Z'), ($1,$3,'node_entered','send','2026-10-05T10:00:02Z'),
      ($1,$3,'error',NULL,'2026-10-05T10:00:03Z')`, [A, runHanded, runFailed]);
    await q(`INSERT INTO ai_unanswered_questions(account_id,question,normalized_question,created_at) VALUES
      ($1,'q1','q1','2026-10-03T10:00:00Z'), ($1,'q2','q2','2026-09-03T10:00:00Z'), ($2,'q3','q3','2026-10-03T10:00:00Z')`, [A, B]);
  });

  afterAll(async () => {
    if (db) {
      await q('DELETE FROM rate_cards WHERE currency=$1', [rateCurrency]);
      await q('DELETE FROM accounts WHERE id = ANY($1::uuid[])', [[A, B]]);
      await q('DELETE FROM auth_users WHERE id = ANY($1::uuid[])', [[owner, agentX, agentY, ownerB]]);
      await db.end();
    }
    await disconnectDatabases();
  });

  it('counts conversations by source and lifecycle with response and resolution times', async () => {
    const stats = await runAnalytics(ctxA, (tx) => conversationStats(tx, A, range));
    expect(stats).toEqual({
      started: { total: 4, inbound: 1, business: 1, campaignReply: 0, ad: 2 },
      byLifecycle: { bot: 0, requesting: 1, assigned: 2, resolved: 2 },
      firstResponse: { count: 4, unanswered: 1, medianSeconds: 210, p90Seconds: 510 },
      // Only the member replies in v1 and v4: the AI replies in v2 and v5 do not count.
      humanFirstResponse: { count: 2, medianSeconds: 450, p90Seconds: 570 },
      resolution: { resolved: 2, count: 2, medianSeconds: 5400, p90Seconds: 6840 },
    });
  });

  it('filters conversations by number and by team', async () => {
    const byNumber = await runAnalytics(ctxA, (tx) => conversationStats(tx, A, range, { whatsappConfigId: number1 }));
    expect(byNumber.started.total).toBe(1);
    expect(byNumber.firstResponse).toEqual({ count: 1, unanswered: 0, medianSeconds: 300, p90Seconds: 300 });
    const byTeam = await runAnalytics(ctxA, (tx) => conversationStats(tx, A, range, { teamId: team }));
    expect(byTeam.started.total).toBe(1);
    expect(byTeam.firstResponse.count).toBe(2);
    expect(byTeam.byLifecycle).toEqual({ bot: 0, requesting: 0, assigned: 1, resolved: 1 });
  });

  it('ranks agents, attributing unstamped replies to the assignee', async () => {
    const board = await runAnalytics(ctxA, (tx) => agentLeaderboard(tx, A, range));
    expect(board.map((r) => r.userId)).toEqual([agentX, owner, agentY]);
    expect(board[0]).toEqual({ userId: agentX, name: 'Xia', role: 'agent', conversationsHandled: 2, repliesSent: 2,
      firstResponseCount: 2, medianFirstResponseSeconds: 450, resolved: 1 });
    expect(board[2]).toMatchObject({ name: 'Yan', repliesSent: 0, medianFirstResponseSeconds: null, resolved: 0 });
  });

  it('credits a stamped reply to its sender, not the assignee, and falls back to the assignee for older rows', async () => {
    // A later, separate week so the fixtures above are untouched.
    const later = parseRange({ from: '2026-10-20', to: '2026-10-21' }, 'UTC', new Date('2026-11-03T00:00:00Z'));
    const contact = randomUUID(), stamped = randomUUID(), legacy = randomUUID();
    await q("INSERT INTO contacts(id,account_id,user_id,name,phone) VALUES($1,$2,$3,'D','919811112222')", [contact, A, owner]);
    await q(`INSERT INTO conversations(id,account_id,user_id,contact_id,created_at,last_message_at,assigned_agent_id,whatsapp_config_id) VALUES
      ($1,$3,$4,$5,'2026-10-20T09:00:00Z','2026-10-20T09:00:00Z',$6,$7), ($2,$3,$4,$5,'2026-10-20T09:00:00Z','2026-10-20T09:00:00Z',$6,$8)`,
    [stamped, legacy, A, owner, contact, agentY, number1, number2]);
    // agentX answers in agentY's conversation; the other reply predates sender_id stamping.
    await msg(A, stamped, 'customer', '2026-10-20T09:00:00Z');
    await msg(A, stamped, 'agent', '2026-10-20T09:02:00Z', { senderId: agentX });
    await msg(A, legacy, 'customer', '2026-10-20T10:00:00Z');
    await msg(A, legacy, 'agent', '2026-10-20T10:04:00Z');
    // A bot reply never counts for a member.
    await msg(A, legacy, 'bot', '2026-10-20T10:05:00Z');
    const board = await runAnalytics(ctxA, (tx) => agentLeaderboard(tx, A, later));
    const row = (id: string) => board.find((r) => r.userId === id);
    expect(row(agentX)).toMatchObject({ conversationsHandled: 1, repliesSent: 1, firstResponseCount: 1, medianFirstResponseSeconds: 120 });
    expect(row(agentY)).toMatchObject({ conversationsHandled: 1, repliesSent: 1, firstResponseCount: 1, medianFirstResponseSeconds: 240 });
    expect(row(owner)).toMatchObject({ conversationsHandled: 0, repliesSent: 0 });
  });

  it("does not credit public-API sends to the assignee and counts only each conversation's first wait", async () => {
    // After AGENT_ATTRIBUTION_CUTOFF, an agent row without sender_id is a public-API or integration send.
    const later = parseRange({ from: '2026-11-10', to: '2026-11-11' }, 'UTC', new Date('2026-12-01T00:00:00Z'));
    const contact = randomUUID(), api = randomUUID(), twoWaits = randomUUID();
    await q("INSERT INTO contacts(id,account_id,user_id,name,phone) VALUES($1,$2,$3,'E','919811113333')", [contact, A, owner]);
    await q(`INSERT INTO conversations(id,account_id,user_id,contact_id,created_at,last_message_at,assigned_agent_id,whatsapp_config_id) VALUES
      ($1,$3,$4,$5,'2026-11-10T09:00:00Z','2026-11-10T13:00:00Z',$6,$7), ($2,$3,$4,$5,'2026-11-10T09:00:00Z','2026-11-10T13:00:00Z',NULL,$8)`,
    [api, twoWaits, A, owner, contact, agentY, number1, number2]);
    await msg(A, api, 'customer', '2026-11-10T09:00:00Z');
    await msg(A, api, 'agent', '2026-11-10T09:01:00Z');
    await msg(A, api, 'agent', '2026-11-10T09:02:00Z');
    // Agent X answers the first wait; agent Y answers a later wait in the same conversation.
    await msg(A, twoWaits, 'customer', '2026-11-10T10:00:00Z');
    await msg(A, twoWaits, 'agent', '2026-11-10T10:05:00Z', { senderId: agentX });
    await msg(A, twoWaits, 'customer', '2026-11-10T11:00:00Z');
    await msg(A, twoWaits, 'agent', '2026-11-10T13:00:00Z', { senderId: agentY });
    const board = await runAnalytics(ctxA, (tx) => agentLeaderboard(tx, A, later));
    const row = (id: string) => board.find((r) => r.userId === id);
    expect(row(agentX)).toMatchObject({ conversationsHandled: 1, repliesSent: 1, firstResponseCount: 1, medianFirstResponseSeconds: 300 });
    expect(row(agentY)).toMatchObject({ conversationsHandled: 1, repliesSent: 1, firstResponseCount: 0, medianFirstResponseSeconds: null });
    expect(row(owner)).toMatchObject({ conversationsHandled: 0, repliesSent: 0, firstResponseCount: 0 });
    // The leaderboard agrees with the overview's first-response count (the API reply answered one wait).
    const overview = await runAnalytics(ctxA, (tx) => conversationStats(tx, A, later));
    expect(overview.firstResponse.count).toBe(2);
    // The agent_performance report uses the same attribution.
    const days = await runAnalytics(ctxA, (tx) => agentDayRows(tx, A, later));
    expect(days.map((d) => [d.userId, d.repliesSent, d.firstResponses]).sort()).toEqual([[agentX, 1, 1], [agentY, 1, 0]].sort());
  });

  it('times the team reply after a bot answered first and resolutions of reopened conversations', async () => {
    const days = parseRange({ from: '2026-10-16', to: '2026-10-17' }, 'UTC', new Date('2026-11-03T00:00:00Z'));
    const contact = randomUUID(), botFirst = randomUUID(), reopened = randomUUID(), legacy = randomUUID();
    await q("INSERT INTO contacts(id,account_id,user_id,name,phone) VALUES($1,$2,$3,'H','919811118888')", [contact, A, owner]);
    await q(`INSERT INTO conversations(id,account_id,user_id,contact_id,created_at,last_message_at,assigned_agent_id,status,ai_handoff_at) VALUES
      ($1,$4,$5,$6,'2026-10-16T09:00:00Z','2026-10-16T09:30:00Z',$7,'open','2026-10-16T09:20:00Z'),
      ($2,$4,$5,$6,'2026-10-15T08:00:00Z','2026-10-15T08:00:00Z',NULL,'closed',NULL),
      ($3,$4,$5,$6,'2026-10-16T07:00:00Z','2026-10-16T07:00:00Z',NULL,'closed',NULL)`,
    [botFirst, reopened, legacy, A, owner, contact, agentY]);
    // The AI answers in a minute, hands off at 09:20, and agent Y replies at 09:30.
    await msg(A, botFirst, 'customer', '2026-10-16T09:00:00Z');
    await msg(A, botFirst, 'bot', '2026-10-16T09:01:00Z', { ai: true });
    await msg(A, botFirst, 'agent', '2026-10-16T09:30:00Z', { senderId: agentY });
    // Created on the 15th, reopened (the trigger stamps reopened_at) and resolved again on the 16th.
    await q("UPDATE conversations SET status='open' WHERE id=$1", [reopened]);
    expect((await q('SELECT reopened_count, reopened_at FROM conversations WHERE id=$1', [reopened])).rows[0])
      .toMatchObject({ reopened_count: 1, reopened_at: expect.any(Date) });
    await q("UPDATE conversations SET status='closed' WHERE id=$1", [reopened]);
    // Real cycle times (an update of these columns does not fire the lifecycle trigger).
    await q("UPDATE conversations SET reopened_at='2026-10-16T10:00:00Z', resolved_at='2026-10-16T10:45:00Z' WHERE id=$1", [reopened]);
    // Reopened before reopened_at existed: counted as resolved, never timed.
    await q("UPDATE conversations SET reopened_count=2, resolved_at='2026-10-16T12:00:00Z' WHERE id=$1", [legacy]);

    const stats = await runAnalytics(ctxA, (tx) => conversationStats(tx, A, days));
    expect(stats.firstResponse).toEqual({ count: 1, unanswered: 0, medianSeconds: 60, p90Seconds: 60 });
    // Timed from the handoff (09:20), not from the customer's first message.
    expect(stats.humanFirstResponse).toEqual({ count: 1, medianSeconds: 600, p90Seconds: 600 });
    // 45 minutes from the reopen, not a day from creation.
    expect(stats.resolution).toEqual({ resolved: 2, count: 1, medianSeconds: 2700, p90Seconds: 2700 });

    // The member who answered after the bot gets the sample on the leaderboard and in the report.
    const board = await runAnalytics(ctxA, (tx) => agentLeaderboard(tx, A, days));
    expect(board.find((r) => r.userId === agentY)).toMatchObject({ firstResponseCount: 1, medianFirstResponseSeconds: 600 });
    const report = await runAnalytics(ctxA, (tx) => agentDayRows(tx, A, days));
    expect(report.filter((r) => r.userId === agentY).map((r) => [r.day, r.firstResponses, r.medianFirstResponseSeconds]))
      .toEqual([['2026-10-16', 1, 600]]);
  });

  it('counts lifecycle only for conversations with activity inside the range', async () => {
    const contact = randomUUID(), idle = randomUUID();
    await q("INSERT INTO contacts(id,account_id,user_id,name,phone) VALUES($1,$2,$3,'F','919811114444')", [contact, A, owner]);
    // Created in September, silent until a customer writes on 2026-10-30.
    await q(`INSERT INTO conversations(id,account_id,user_id,contact_id,created_at,last_message_at) VALUES($1,$2,$3,$4,'2026-09-15T09:00:00Z','2026-10-30T09:00:00Z')`,
      [idle, A, owner, contact]);
    await msg(A, idle, 'customer', '2026-10-30T09:00:00Z');
    const lifecycle = async (fromDay: string, toDay: string) => {
      const r = parseRange({ from: fromDay, to: toDay }, 'UTC', new Date('2026-11-03T00:00:00Z'));
      const { byLifecycle } = await runAnalytics(ctxA, (tx) => conversationStats(tx, A, r));
      return byLifecycle.bot + byLifecycle.requesting + byLifecycle.assigned + byLifecycle.resolved;
    };
    expect(await lifecycle('2026-10-08', '2026-10-14')).toBe(0);
    expect(await lifecycle('2026-10-29', '2026-10-31')).toBe(1);
  });

  it('counts an AI handoff in the range it happened, keeps it after AI resumes, and never as an AI resolution', async () => {
    const day = parseRange({ from: '2026-10-25', to: '2026-10-26' }, 'UTC', new Date('2026-11-03T00:00:00Z'));
    const after = parseRange({ from: '2026-11-01', to: '2026-11-02' }, 'UTC', new Date('2026-11-03T00:00:00Z'));
    const contact = randomUUID(), handed = randomUUID();
    await q("INSERT INTO contacts(id,account_id,user_id,name,phone) VALUES($1,$2,$3,'G','919811115555')", [contact, A, owner]);
    await q(`INSERT INTO conversations(id,account_id,user_id,contact_id,created_at,last_message_at,status,bot_paused,ai_handoff_summary,ai_handoff_at)
      VALUES($1,$2,$3,$4,'2026-10-25T09:00:00Z','2026-11-01T09:00:00Z','closed',true,'needs a person','2026-10-25T09:02:00Z')`, [handed, A, owner, contact]);
    await q("UPDATE conversations SET resolved_at='2026-10-25T09:30:00Z' WHERE id=$1", [handed]);
    await msg(A, handed, 'customer', '2026-10-25T09:00:00Z');
    await msg(A, handed, 'bot', '2026-10-25T09:01:00Z', { ai: true });
    // The customer writes again in November: that is not a November handoff.
    await msg(A, handed, 'customer', '2026-11-01T09:00:00Z');
    const stats = (r: typeof day) => runAnalytics({ ...ctxA, role: 'agent' }, (tx) => aiStats(tx, A, r));
    expect(await stats(day)).toMatchObject({ aiConversations: 1, handoffs: 1, resolvedByAi: 0, resolutionRate: 0 });
    expect((await stats(after)).handoffs).toBe(0);
    // Resuming AI clears the note and the pause but keeps the handoff time.
    await q('UPDATE conversations SET ai_handoff_summary=NULL, bot_paused=false, ai_autoreply_disabled=false WHERE id=$1', [handed]);
    expect(await stats(day)).toMatchObject({ handoffs: 1, resolvedByAi: 0 });
  });

  it('builds the campaign funnel for a range and for one campaign', async () => {
    const funnel = await runAnalytics(ctxA, (tx) => campaignFunnel(tx, A, { range }));
    expect(funnel.totals).toEqual({ recipients: 3, sent: 2, delivered: 2, read: 1, replied: 1, clicked: 1, failed: 1 });
    expect(funnel.broadcasts.map((b) => [b.name, b.recipients])).toEqual([['Empty', 0], ['October', 3]]);
    const old = await runAnalytics(ctxA, (tx) => campaignFunnel(tx, A, { broadcastId: b0 }));
    expect(old.totals).toMatchObject({ recipients: 1, delivered: 1, replied: 0 });
    // Another workspace's campaign id reads as empty.
    expect((await runAnalytics(ctxA, (tx) => campaignFunnel(tx, A, { broadcastId: bB }))).totals.recipients).toBe(0);
  });

  it('counts a campaign reply only on the number the campaign was sent from, NULL meaning the default', async () => {
    // A separate week. number1 is the default (the first number added).
    const week = parseRange({ from: '2026-10-12', to: '2026-10-13' }, 'UTC', new Date('2026-11-03T00:00:00Z'));
    const k = randomUUID(), l = randomUUID(), kTwo = randomUUID(), lOne = randomUUID(), bn = randomUUID(), bl = randomUUID();
    await q("INSERT INTO contacts(id,account_id,user_id,name,phone) VALUES($1,$3,$4,'K','919811116666'),($2,$3,$4,'L','919811117777')", [k, l, A, owner]);
    await q(`INSERT INTO broadcasts(id,account_id,user_id,name,template_name,status,scheduled_at,created_at,whatsapp_config_id) VALUES
      ($1,$3,$4,'Per number','number_promo','sent','2026-10-12T07:00:00Z','2026-10-12T06:00:00Z',$5),
      ($2,$3,$4,'Legacy','legacy_promo','sent','2026-10-12T07:00:00Z','2026-10-12T06:00:00Z',NULL)`, [bn, bl, A, owner, number1]);
    await q(`INSERT INTO broadcast_recipients(account_id,broadcast_id,contact_id,status,sent_at,delivered_at)
      SELECT $1, b, c, 'delivered', '2026-10-12T07:00:00Z', '2026-10-12T07:01:00Z' FROM unnest($2::uuid[]) b CROSS JOIN unnest($3::uuid[]) c`,
    [A, [bn, bl], [k, l]]);
    // K answers on number2 (not the campaigns' number); L on number1.
    await q(`INSERT INTO conversations(id,account_id,user_id,contact_id,created_at,last_message_at,inbound_created_meta_id,whatsapp_config_id) VALUES
      ($1,$3,$4,$5,'2026-10-12T08:00:00Z','2026-10-12T08:00:00Z',$7,$9), ($2,$3,$4,$6,'2026-10-12T09:00:00Z','2026-10-12T09:00:00Z',$8,$10)`,
    [kTwo, lOne, A, owner, k, l, `wamid.k.${seed}`, `wamid.l.${seed}`, number2, number1]);
    await msg(A, kTwo, 'customer', '2026-10-12T08:00:00Z');
    await msg(A, lOne, 'customer', '2026-10-12T09:00:00Z');

    const funnel = (id: string) => runAnalytics(ctxA, (tx) => campaignFunnel(tx, A, { broadcastId: id }));
    expect((await funnel(bn)).totals).toMatchObject({ recipients: 2, replied: 1 });
    expect((await funnel(bl)).totals).toMatchObject({ recipients: 2, replied: 1 });
    expect((await runAnalytics(ctxA, (tx) => templateDaily(tx, A, week))).map((r) => [r.templateName, r.sent, r.replied])).toEqual([
      ['legacy_promo', 2, 1], ['number_promo', 2, 1],
    ]);
    const stats = await runAnalytics(ctxA, (tx) => conversationStats(tx, A, week));
    expect(stats.started).toEqual({ total: 2, inbound: 1, business: 0, campaignReply: 1, ad: 0 });
    const onNumber2 = await runAnalytics(ctxA, (tx) => conversationStats(tx, A, week, { whatsappConfigId: number2 }));
    expect(onNumber2.started).toEqual({ total: 1, inbound: 1, business: 0, campaignReply: 0, ad: 0 });

    // Once K also answers on number1, both campaigns count it.
    const kOne = randomUUID();
    await q(`INSERT INTO conversations(id,account_id,user_id,contact_id,created_at,last_message_at,whatsapp_config_id)
      VALUES($1,$2,$3,$4,'2026-10-12T07:00:00Z','2026-10-12T10:00:00Z',$5)`, [kOne, A, owner, k, number1]);
    await msg(A, kOne, 'customer', '2026-10-12T10:00:00Z');
    expect((await funnel(bn)).totals.replied).toBe(2);
    expect((await funnel(bl)).totals.replied).toBe(2);
  });

  it('reports flow outcomes and where runs stopped', async () => {
    const stats = await runAnalytics(ctxA, (tx) => flowStats(tx, A, range, flow));
    expect(stats).toEqual({ started: 5, completed: 1, handedOff: 1, timedOut: 1, failed: 1, cancelled: 0, active: 1,
      dropOff: [{ flowId: flow, nodeKey: 'ask', nodeType: 'send_buttons', runs: 1 }, { flowId: flow, nodeKey: 'human', nodeType: 'handoff', runs: 1 },
        { flowId: flow, nodeKey: 'send', nodeType: 'send_message', runs: 1 }] });
  });

  it('reports AI replies, handoffs, unanswered questions and AI resolution', async () => {
    expect(await runAnalytics({ ...ctxA, role: 'agent' }, (tx) => aiStats(tx, A, range))).toEqual({
      aiReplies: 2, aiConversations: 2, handoffs: 1, unansweredRecorded: 1, resolvedByAi: 1, resolutionRate: 0.5,
    });
    // Unanswered questions hold customer text, so RLS hides them (and their count) from viewers.
    expect((await runAnalytics(ctxA, (tx) => aiStats(tx, A, range))).unansweredRecorded).toBe(0);
  });

  it('reports template sends per day from campaigns and the inbox', async () => {
    expect(await runAnalytics(ctxA, (tx) => templateDaily(tx, A, range))).toEqual([
      { day: '2026-10-03', templateName: 'promo', sent: 1, delivered: 1, read: 1, replied: 1, clicked: 0, failed: 0 },
      { day: '2026-10-04', templateName: 'promo', sent: 2, delivered: 2, read: 1, replied: 1, clicked: 1, failed: 0 },
    ]);
    expect(await runAnalytics(ctxA, (tx) => templateDaily(tx, A, range, 'other'))).toEqual([]);
  });

  it('keeps workspaces apart even when a caller passes another account id', async () => {
    const b = await runAnalytics(ctxB, async (tx) => ({
      conversations: await conversationStats(tx, B, range), ai: await aiStats(tx, B, range), templates: await templateDaily(tx, B, range),
    }));
    expect(b.conversations.started).toEqual({ total: 1, inbound: 0, business: 0, campaignReply: 0, ad: 1 });
    expect(b.ai).toMatchObject({ aiReplies: 1, unansweredRecorded: 1, handoffs: 0 });
    expect(b.templates.map((r) => [r.day, r.sent])).toEqual([['2026-10-02', 1], ['2026-10-04', 1]]);
    // RLS: inside A's tenant transaction, B's account id finds nothing.
    const leak = await runAnalytics(ctxA, async (tx) => ({
      conversations: await conversationStats(tx, B, range), funnel: await campaignFunnel(tx, B, { range }),
      flows: await flowStats(tx, B, range), board: await agentLeaderboard(tx, B, range),
    }));
    expect(leak.conversations.started.total).toBe(0);
    expect(leak.funnel.totals.recipients).toBe(0);
    expect(leak.flows.started).toBe(0);
    expect(leak.board).toEqual([]);
  });

  it('keeps the rate card platform-wide: worker writes, members read', async () => {
    await upsertRateCards([{ category: 'marketing', countryCode: rateCountry, currency: rateCurrency, priceMinor: 1.0725 }]);
    await upsertRateCards([{ category: 'marketing', countryCode: rateCountry, currency: rateCurrency, priceMinor: 1.5 },
      { category: 'utility', countryCode: rateCountry, currency: rateCurrency, priceMinor: 0.5 }]);
    await upsertRateCards([{ category: 'utility', countryCode: rateCountry, currency: rateCurrency, priceMinor: null }]);
    const cards = await withTenant(ctxA, (tx) => listRateCards({ currency: rateCurrency }, tx));
    expect(cards).toEqual([{ category: 'marketing', countryCode: rateCountry, currency: rateCurrency, priceMinor: 1.5 }]);
    expect(estimateCampaignCost({ category: 'marketing', currency: rateCurrency, recipientsByCountry: { ZW: 3, IN: 1 } }, cards))
      .toMatchObject({ total: 4.5, missingCountries: [{ countryCode: 'IN', recipients: 1 }] });
    // The app role (any browser-facing request) cannot write it.
    await expect(getPrisma().$executeRaw`INSERT INTO rate_cards(category,country_code,currency,price_minor) VALUES('service','ZW','XTS',1)`).rejects.toThrow();
    await expect(getPrisma().$executeRaw`UPDATE rate_cards SET price_minor=0 WHERE currency='XTS'`).rejects.toThrow();
    await expect(getWorkerPrisma().$executeRaw`INSERT INTO rate_cards(category,country_code,currency,price_minor) VALUES('promo','ZW','XTS',1)`).rejects.toThrow();
  });
});
