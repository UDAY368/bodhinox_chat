// Stage 5 (5F) tracked links on a real PostgreSQL: a retried send reuses its
// token, a click stamps first_clicked_at once and counts every recorded click,
// a run started from a comment marks the funnel's link_clicked step, CTR per
// flow, the /r/<token> redirect (campaign tokens unchanged, flow tokens, unknown
// tokens 404) and the tenancy boundary (another workspace reads nothing).
import { randomUUID } from 'node:crypto';
import { config } from 'dotenv';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createCampaign } from '@/lib/broadcasts/create-campaign';
import { appOrigin } from '@/lib/broadcasts/tracking';
import { disconnectDatabases, getPrisma, getWorkerPrisma } from '@/lib/db/prisma';
import { withTenant, type TenantContext } from '@/lib/db/tenant';
import { GET as redirect } from '@/app/r/[token]/route';
import { clickThroughRate, flowClickDestination, flowLinkStats, linkClicked, recordFlowClick, trackedUrl, type TrackedLinkRun } from './link-tracking';

const configured = config({ path: '.env.test', quiet: true }).parsed;
const ownerUrl = process.env.TEST_DATABASE_URL;
const appUrl = process.env.TEST_APP_DATABASE_URL || configured?.DATABASE_URL;
const workerUrl = process.env.TEST_WORKER_DATABASE_URL || configured?.WORKER_DATABASE_URL;
if (appUrl) process.env.DATABASE_URL = appUrl;
if (workerUrl) process.env.WORKER_DATABASE_URL = workerUrl;

const A = randomUUID(), B = randomUUID(), userA = randomUUID(), userB = randomUUID();
const flowA = randomUUID(), flowB = randomUUID(), contactA = randomUUID(), contactB = randomUUID();
const runComment = randomUUID(), runPlain = randomUUID(), runOther = randomUUID();
const template = randomUUID();
const ctxA: TenantContext = { accountId: A, userId: userA, role: 'agent' };
const seed = String(Date.now()).slice(-9);
let db: pg.Client;
const q = (sql: string, params: unknown[] = []) => db.query(sql, params);
const run = (id: string, account = A, flow = flowA, contact = contactA): TrackedLinkRun =>
  ({ id, account_id: account, flow_id: flow, contact_id: contact, conversation_id: null });
const tokenOf = (url: string) => /\/r\/([0-9a-f]{32})$/.exec(url)?.[1] ?? '';
const get = (token: string, ip = '198.51.100.7') =>
  redirect(new Request(`https://app.example.test/r/${token}`, { headers: { 'x-forwarded-for': ip } }), { params: Promise.resolve({ token }) });

describe.skipIf(!ownerUrl || !appUrl || !workerUrl)('flow link tracking on PostgreSQL', { timeout: 120_000 }, () => {
  beforeAll(async () => {
    db = new pg.Client({ connectionString: ownerUrl });
    await db.connect();
    if (!/test/i.test((await q('SELECT current_database() AS name')).rows[0].name)) throw new Error('Requires an isolated test database');
    const app = await getPrisma().$queryRaw<{ role: string }[]>`SELECT current_user AS role`;
    if (app[0].role !== 'bodhinox_app') throw new Error('Requires constrained test app credentials');
    await getWorkerPrisma().$queryRaw`SELECT 1`;
    await q("INSERT INTO auth_users(id,email,full_name,password_hash) SELECT x, x::text || '@example.invalid', 'Links', 'test-only-hash' FROM unnest($1::uuid[]) x", [[userA, userB]]);
    await q("INSERT INTO accounts(id,name,owner_user_id) VALUES($1,'Links A',$2),($3,'Links B',$4)", [A, userA, B, userB]);
    await q("INSERT INTO account_memberships(account_id,user_id,role) VALUES($1,$2,'agent'),($3,$4,'owner')", [A, userA, B, userB]);
    await q("INSERT INTO contacts(id,account_id,user_id,name,phone) VALUES($1,$2,$3,'C','919800000011'),($4,$5,$6,'D','919800000012')",
      [contactA, A, userA, contactB, B, userB]);
    await q(`INSERT INTO flows(id,account_id,user_id,name,trigger_type,status,channel_scope) VALUES
      ($1,$2,$3,'Reel link','ig_comment','active','instagram'),($4,$5,$6,'Other','keyword','active','instagram')`,
    [flowA, A, userA, flowB, B, userB]);
    await q(`INSERT INTO flow_runs(id,account_id,flow_id,user_id,contact_id,status,started_at) VALUES
      ($1,$4,$5,$6,$7,'completed',now()),($2,$4,$5,$6,$7,'completed',now()),($3,$8,$9,$10,$11,'completed',now())`,
    [runComment, runPlain, runOther, A, flowA, userA, contactA, B, flowB, userB, contactB]);
    const ig = (await q(`INSERT INTO instagram_accounts(account_id,ig_user_id,username,access_token_enc,scopes,connected_by_user_id)
      VALUES($1,$2,'shop','x',ARRAY['instagram_business_basic'],$3) RETURNING id`, [A, `73${seed}`, userA])).rows[0].id;
    await q(`INSERT INTO instagram_comment_events(account_id,instagram_account_id,comment_id,media_id,received_at,private_reply_status,flow_run_id)
      VALUES($1,$2,$3,'500',now(),'sent',$4)`, [A, ig, `18${seed}0001`, runComment]);
  });
  afterAll(async () => {
    if (db) {
      await q('DELETE FROM jobs WHERE tenant_id = ANY($1::uuid[])', [[A, B]]);
      await q('DELETE FROM accounts WHERE id=ANY($1::uuid[])', [[A, B]]);
      await q('DELETE FROM auth_users WHERE id=ANY($1::uuid[])', [[userA, userB]]);
      await db.end();
    }
    await disconnectDatabases();
  });

  it('reuses the token of a retried send and gives each slot its own', async () => {
    const first = await trackedUrl(run(runComment), 'card', 'button:0', 'https://shop.example/reel');
    const retry = await trackedUrl(run(runComment), 'card', 'button:0', 'https://shop.example/changed');
    const other = await trackedUrl(run(runComment), 'card', 'button:1', 'https://shop.example/more');
    expect(first).toBe(`${appOrigin()}/r/${tokenOf(first)}`);
    expect(retry).toBe(first);
    expect(other).not.toBe(first);
    const rows = (await q('SELECT slot, url, click_count FROM flow_tracked_links WHERE flow_run_id=$1 ORDER BY slot', [runComment])).rows;
    // The first attempt's destination stays: a retry never rewrites a link already sent.
    expect(rows).toEqual([{ slot: 'button:0', url: 'https://shop.example/reel', click_count: 0 }, { slot: 'button:1', url: 'https://shop.example/more', click_count: 0 }]);
  });

  it('writes nothing for a destination that is not http(s), and sends it untracked', async () => {
    expect(await trackedUrl(run(runPlain), 'card', 'button:0', 'mailto:a@b.example')).toBe('mailto:a@b.example');
    expect((await q('SELECT count(*)::int AS n FROM flow_tracked_links WHERE flow_run_id=$1', [runPlain])).rows[0].n).toBe(0);
  });

  it('stamps the first click once, counts each recorded click and marks the comment funnel', async () => {
    const token = tokenOf(await trackedUrl(run(runComment), 'card', 'button:0', 'https://shop.example/reel'));
    expect(await linkClicked(A, runComment, 'card')).toBe(false);
    expect(await flowClickDestination(token)).toBe('https://shop.example/reel');
    expect((await q('SELECT click_count FROM flow_tracked_links WHERE token=$1', [token])).rows[0].click_count).toBe(0);

    expect(await recordFlowClick(token)).toBe('https://shop.example/reel');
    const firstAt = (await q('SELECT first_clicked_at FROM flow_tracked_links WHERE token=$1', [token])).rows[0].first_clicked_at;
    expect(firstAt).toBeTruthy();
    expect(await recordFlowClick(token)).toBe('https://shop.example/reel');
    const after = (await q('SELECT first_clicked_at, click_count FROM flow_tracked_links WHERE token=$1', [token])).rows[0];
    expect(after.click_count).toBe(2);
    expect(after.first_clicked_at.getTime()).toBe(firstAt.getTime());
    expect(await linkClicked(A, runComment, 'card')).toBe(true);
    expect((await q('SELECT link_clicked_at FROM instagram_comment_events WHERE flow_run_id=$1', [runComment])).rows[0].link_clicked_at).toBeTruthy();
  });

  it('computes CTR as runs with a click over runs sent a tracked link', async () => {
    await trackedUrl(run(runPlain), 'card', 'button:0', 'https://shop.example/plain');
    const stats = await withTenant(ctxA, (tx) => flowLinkStats(tx, A, [flowA, flowB]));
    expect(stats.get(flowA)).toEqual({ sent: 2, clicked: 1 });
    expect(clickThroughRate(stats.get(flowA))).toBe(50);
    // Another workspace's flow is invisible from this workspace.
    expect(stats.has(flowB)).toBe(false);
  });

  it('keeps every workspace to its own links', async () => {
    const theirs = tokenOf(await trackedUrl(run(runOther, B, flowB, contactB), 'msg', 'button:0', 'https://other.example/'));
    expect(theirs).toMatch(/^[0-9a-f]{32}$/);
    // A run id of another workspace never reads as clicked here, even after a click.
    await recordFlowClick(theirs);
    expect(await linkClicked(A, runOther, 'msg')).toBe(false);
    expect(await linkClicked(B, runOther, 'msg')).toBe(true);
    const visible = await withTenant(ctxA, (tx) => tx.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM flow_tracked_links`);
    expect(visible[0].n).toBe(3);
    // The app role reads links for CTR but never the token.
    await expect(withTenant(ctxA, (tx) => tx.$queryRaw`SELECT token FROM flow_tracked_links LIMIT 1`)).rejects.toThrow(/permission denied/i);
  });

  it('redirects flow tokens, leaves campaign tokens counted as before and 404s unknown tokens', async () => {
    const flowToken = tokenOf(await trackedUrl(run(runPlain), 'card', 'button:0', 'https://shop.example/plain'));
    const res = await get(flowToken);
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('https://shop.example/plain');
    expect(res.headers.get('Referrer-Policy')).toBe('no-referrer');

    // A campaign link (Phase 9 click tracking) resolves and counts exactly as before.
    const buttons = JSON.stringify([{ type: 'URL', text: 'Shop now', url: `${appOrigin()}/r/{{1}}`, example: 'abc' }]);
    await q(`INSERT INTO message_templates(id,account_id,user_id,name,body_text,status,buttons)
      VALUES($1,$2,$3,'tracked_template','Sale is live','APPROVED',$4::jsonb)`, [template, A, userA, buttons]);
    await q("INSERT INTO whatsapp_config(account_id,user_id,phone_number_id,access_token) VALUES($1,$2,$3,'not-used-in-tests')", [A, userA, `pn-${seed}`]);
    const { id } = await createCampaign(ctxA, { name: 'Sale', templateId: template, audience: { type: 'all' }, variables: {}, trackedUrl: 'https://shop.example/sale' });
    const campaignToken = (await q('SELECT click_token FROM broadcast_recipients WHERE broadcast_id=$1 LIMIT 1', [id])).rows[0].click_token;
    const campaign = await get(campaignToken, '198.51.100.8');
    expect(campaign.status).toBe(302);
    expect(campaign.headers.get('location')).toBe('https://shop.example/sale');
    expect((await q('SELECT click_count FROM broadcasts WHERE id=$1', [id])).rows[0].click_count).toBe(1);
    expect((await q('SELECT count(*)::int AS n FROM broadcast_clicks WHERE broadcast_id=$1', [id])).rows[0].n).toBe(1);

    expect((await get('f'.repeat(32))).status).toBe(404);
    expect((await get('not-a-token')).status).toBe(404);
  });
});
