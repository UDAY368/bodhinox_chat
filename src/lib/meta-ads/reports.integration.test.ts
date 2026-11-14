import { randomUUID } from 'node:crypto';
import { config } from 'dotenv';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// Ads reports on PostgreSQL: chat quality per ad from the workspace's own
// chats and deals; the scheduled "Ads summary" rows (spend, chats, attributed
// revenue per campaign); the Overview's previous period; and the live Meta
// reads (splits, previews) refusing objects the workspace does not own before
// any Meta call. Graph is mocked.
const seed = String(Date.now()).slice(-9);
const ID = { adAccount: `71${seed}`, page: `72${seed}`, camp: `73${seed}`, set: `74${seed}`, ad: `75${seed}` };
const graph = vi.hoisted(() => ({ breakdown: vi.fn(), preview: vi.fn() }));
vi.mock('./graph', async (original) => ({
  ...(await original<typeof import('./graph')>()),
  exchangeLoginToken: vi.fn(async () => ({ accessToken: 'user-token' })),
  getGrantedScopes: vi.fn(async () => ['ads_read', 'ads_management', 'pages_manage_ads', 'pages_show_list', 'business_management']),
  listAdAccounts: vi.fn(async () => [{ id: ID.adAccount, name: 'Main', currency: 'INR', businessId: null }]),
  listPages: vi.fn(async () => [{ id: ID.page, name: 'Page', accessToken: 'page-token' }]),
  subscribePageLeadgen: vi.fn(async () => {}),
  listCampaigns: vi.fn(async () => []),
  getBreakdownInsights: graph.breakdown,
  getAdPreview: graph.preview,
}));

import { disconnectDatabases, getPrisma } from '@/lib/db/prisma';
import { withTenant } from '@/lib/db/tenant';
import { finishConnection, MetaAdsError, startConnection, type MetaAdsActor } from './connection';
import { getAdsOverview } from './overview';
import { adsReportRows, chatQuality, clearBreakdownCache, getBreakdowns, getStoredAdPreview } from './reports';

const configured = config({ path: '.env.test', quiet: true }).parsed;
const ownerUrl = process.env.TEST_DATABASE_URL;
const appUrl = process.env.TEST_APP_DATABASE_URL || configured?.DATABASE_URL;
const workerUrl = process.env.TEST_WORKER_DATABASE_URL || configured?.WORKER_DATABASE_URL;
if (appUrl) process.env.DATABASE_URL = appUrl;
if (workerUrl) process.env.WORKER_DATABASE_URL = workerUrl;

const accountA = randomUUID(), accountB = randomUUID();
const adminA = randomUUID(), adminB = randomUUID();
const asA: MetaAdsActor = { accountId: accountA, userId: adminA, role: 'admin' };
const asB: MetaAdsActor = { accountId: accountB, userId: adminB, role: 'admin' };
let owner: pg.Client;
const env: Record<string, string | undefined> = {};
const day = (ago: number) => new Date(Date.now() - ago * 86_400_000).toISOString().slice(0, 10);
const failure = async (promise: Promise<unknown>) => promise.then(() => 'resolved', (e) => (e instanceof MetaAdsError ? e.code : e));

describe.skipIf(!ownerUrl || !appUrl || !workerUrl)('Ads reports on PostgreSQL', { timeout: 120_000 }, () => {
  beforeAll(async () => {
    for (const key of ['META_ADS_ENABLED', 'META_ADS_MANAGE_ENABLED', 'META_APP_ID', 'META_APP_SECRET', 'META_ADS_LOGIN_CONFIG_ID']) env[key] = process.env[key];
    Object.assign(process.env, {
      META_ADS_ENABLED: 'true', META_ADS_MANAGE_ENABLED: 'true', META_APP_ID: '1234', META_APP_SECRET: 'test-only-secret', META_ADS_LOGIN_CONFIG_ID: '5678',
    });
    owner = new pg.Client({ connectionString: ownerUrl });
    await owner.connect();
    if (!/test/i.test((await owner.query('SELECT current_database() AS name')).rows[0].name)) throw new Error('Requires an isolated test database');
    const app = await getPrisma().$queryRaw<{ role: string }[]>`SELECT current_user AS role`;
    if (app[0].role !== 'bodhinox_app') throw new Error('Requires constrained test app credentials');
    await owner.query("INSERT INTO auth_users(id,email,full_name,password_hash) SELECT x, x::text || '@example.invalid', 'Ads reports test', 'test-only-hash' FROM unnest($1::uuid[]) x", [[adminA, adminB]]);
    await owner.query("INSERT INTO accounts(id,name,owner_user_id) VALUES($1,'Reports A',$2),($3,'Reports B',$4)", [accountA, adminA, accountB, adminB]);
    await owner.query("INSERT INTO account_memberships(account_id,user_id,role) VALUES($1,$2,'admin'),($3,$4,'admin')", [accountA, adminA, accountB, adminB]);
    await startConnection(asA, 'login-token');
    await finishConnection(asA, { adAccountId: ID.adAccount, pageId: ID.page });

    // One ad in one campaign: 250 spent yesterday (this week), 100 eleven days ago (the week before).
    await owner.query(`INSERT INTO meta_ad_objects(account_id, connection_id, ad_account_id, level, object_id, campaign_id, adset_id, name)
      SELECT $1, id, $2, 'ad', $3, $4, $5, 'Diwali ad' FROM meta_ad_connections WHERE account_id=$1 AND status='active'`,
    [accountA, ID.adAccount, ID.ad, ID.camp, ID.set]);
    await owner.query(`INSERT INTO meta_ad_insights(account_id, connection_id, ad_account_id, level, object_id, campaign_id, adset_id, name, day, spend, currency, impressions, clicks, conversations_started)
      SELECT $1, c.id, $2, l.level, l.id, $3, $4, l.name, l.day::date, l.spend, 'INR', 1000, 10, 4 FROM meta_ad_connections c,
        (VALUES ('ad', $5, 'Diwali ad', $6, 250), ('campaign', $3, 'Diwali', $6, 250), ('campaign', $3, 'Diwali', $7, 100)) AS l(level, id, name, day, spend)
      WHERE c.account_id=$1 AND c.status='active'`, [accountA, ID.adAccount, ID.camp, ID.set, ID.ad, day(1), day(11)]);

    // Two chats from the ad two days ago. The first was answered and became a won deal (and paid);
    // the second has only a deal opened before the click, which does not count.
    const contact = async (name: string, phone: string) => (await owner.query(
      'INSERT INTO contacts(account_id,user_id,name,phone) VALUES($1,$2,$3,$4) RETURNING id', [accountA, adminA, name, phone])).rows[0].id as string;
    const c1 = await contact('Buyer', `+9171${seed}`), c2 = await contact('Browser', `+9172${seed}`);
    const conv = async (c: string) => (await owner.query("INSERT INTO conversations(account_id,user_id,contact_id,status) VALUES($1,$2,$3,'open') RETURNING id",
      [accountA, adminA, c])).rows[0].id as string;
    const v1 = await conv(c1), v2 = await conv(c2);
    await owner.query(`INSERT INTO ad_referrals(account_id,contact_id,conversation_id,wa_message_id,source_id,source_type,created_at) VALUES
      ($1,$2,$3,$4,$8,'ad', now() - interval '2 days'), ($1,$5,$6,$7,$8,'ad', now() - interval '2 days')`,
    [accountA, c1, v1, `wamid.r1.${seed}`, c2, v2, `wamid.r2.${seed}`, ID.ad]);
    await owner.query(`INSERT INTO messages(account_id,conversation_id,sender_type,content_type,content_text,status,created_at)
      VALUES($1,$2,'agent','text','Hello','sent', now() - interval '1 day')`, [accountA, v1]);
    const pipeline = (await owner.query("INSERT INTO pipelines(account_id,user_id,name) VALUES($1,$2,'Sales') RETURNING id", [accountA, adminA])).rows[0].id;
    const stage = (await owner.query("INSERT INTO pipeline_stages(account_id,pipeline_id,name) VALUES($1,$2,'Won') RETURNING id", [accountA, pipeline])).rows[0].id;
    await owner.query(`INSERT INTO deals(account_id,user_id,pipeline_id,stage_id,contact_id,title,status,created_at) VALUES
      ($1,$2,$3,$4,$5,'Lamp order','won', now() - interval '1 day'), ($1,$2,$3,$4,$6,'Old deal','open', now() - interval '20 days')`,
    [accountA, adminA, pipeline, stage, c1, c2]);
    await owner.query(`INSERT INTO orders(account_id, source, currency, subtotal_minor, total_minor, contact_id, status, paid_at, amount_paid_minor)
      VALUES ($1,'manual','INR',100000,100000,$2,'paid', now() - interval '1 day', 100000)`, [accountA, c1]);
  });
  beforeEach(() => { vi.clearAllMocks(); clearBreakdownCache(); });
  afterAll(async () => {
    for (const [key, value] of Object.entries(env)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    if (owner) {
      await owner.query('DELETE FROM jobs WHERE tenant_id=ANY($1::uuid[])', [[accountA, accountB]]);
      await owner.query('DELETE FROM accounts WHERE id=ANY($1::uuid[])', [[accountA, accountB]]);
      await owner.query('DELETE FROM auth_users WHERE id=ANY($1::uuid[])', [[adminA, adminB]]);
      await owner.end();
    }
    await disconnectDatabases();
  });

  it('chat quality counts chats, answers, deals opened after the click and wins, per ad', async () => {
    const rows = await chatQuality(asA, { from: day(7), to: day(0), adAccountId: null });
    expect(rows).toEqual([{ adId: ID.ad, name: 'Diwali ad', currency: 'INR', spend: 250, chats: 2, replied: 1, deals: 1, won: 1 }]);
    expect(await chatQuality(asA, { from: day(7), to: day(0), adAccountId: `99${seed}` })).toEqual([]);
    expect(await chatQuality(asB, { from: day(7), to: day(0), adAccountId: null })).toEqual([]);
  });

  it('the Ads summary report has one row per campaign with chats and attributed revenue', async () => {
    const from = new Date(`${day(7)}T00:00:00Z`), to = new Date(`${day(-1)}T00:00:00Z`);
    const range = { preset: 'custom', from, to, startDay: day(7), endDay: day(0), days: 8, timezone: 'UTC', bucket: 'day' } as never;
    const rows = await withTenant({ accountId: accountA, userId: adminA, role: 'owner' }, (tx) => adsReportRows(tx, accountA, range));
    expect(rows).toEqual([expect.objectContaining({
      adAccountId: ID.adAccount, campaignId: ID.camp, campaign: 'Diwali', currency: 'INR', spend: 250, chatsStarted: 4,
      chatsInBodhinox: 2, sales: 1, revenue: '1000.00 INR',
    })]);
    expect(await withTenant({ accountId: accountB, userId: adminB, role: 'owner' }, (tx) => adsReportRows(tx, accountB, range))).toEqual([]);
  });

  it('the Overview carries the same number of days just before the range', async () => {
    const overview = await getAdsOverview({ ...asA, role: 'viewer' }, { from: day(7), to: day(1), adAccountId: null });
    expect(overview.totals.spend).toBe(250);
    expect(overview.previous).toMatchObject({ from: day(14), to: day(8), totals: expect.objectContaining({ spend: 100 }) });
  });

  it('splits and previews are read only for objects the workspace owns, and splits are cached', async () => {
    graph.breakdown.mockResolvedValue([{ dims: ['25-34', 'female'], spend: 10, impressions: 100, clicks: 1, linkClicks: 1, conversationsStarted: 1, leads: 0, purchases: 0 }]);
    const query = { from: day(7), to: day(1), adAccountId: null, objectId: ID.ad, breakdown: 'age_gender' as const };
    expect(await failure(getBreakdowns(asA, { ...query, objectId: `98${seed}` }))).toBe('not_found');
    expect(await failure(getBreakdowns(asB, query))).toBe('not_connected');
    expect(await failure(getBreakdowns(asA, { ...query, objectId: null, adAccountId: `97${seed}` }))).toBe('not_found');
    expect(graph.breakdown).not.toHaveBeenCalled();

    const result = await getBreakdowns({ ...asA, role: 'viewer' }, query);
    expect(result).toEqual({ currency: 'INR', rows: [expect.objectContaining({ dims: ['25-34', 'female'] })] });
    expect(graph.breakdown).toHaveBeenCalledWith({ objectId: ID.ad }, 'user-token', { since: day(7), until: day(1), breakdown: 'age_gender' });
    await getBreakdowns(asA, query);
    expect(graph.breakdown).toHaveBeenCalledTimes(1);
    await getBreakdowns(asA, { ...query, objectId: null });
    expect(graph.breakdown).toHaveBeenLastCalledWith({ adAccountId: ID.adAccount }, 'user-token', expect.anything());

    graph.preview.mockResolvedValue('https://www.facebook.com/ads/api/preview_iframe.php?d=1');
    expect(await failure(getStoredAdPreview(asA, `96${seed}`, 'INSTAGRAM_STORY'))).toBe('not_found');
    expect(await getStoredAdPreview(asA, ID.ad, 'INSTAGRAM_STORY')).toEqual({ src: 'https://www.facebook.com/ads/api/preview_iframe.php?d=1' });
    expect(graph.preview).toHaveBeenCalledTimes(1);
  });
});
