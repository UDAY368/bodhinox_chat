import { randomUUID } from 'node:crypto';
import { config } from 'dotenv';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// The ads module on PostgreSQL: several ad accounts per workspace, the richer
// reports (ad sets, platforms, reach) and ad creation (each Meta object made
// once; an unclear outcome is looked up, never re-sent). Graph is mocked.
const seed = String(Date.now()).slice(-9);
const ID = {
  primary: `81${seed}`, second: `82${seed}`, page: `83${seed}`,
  campA: `84${seed}`, setA: `85${seed}`, adA: `86${seed}`, campB: `87${seed}`,
  newCamp: `91${seed}`, newSet: `92${seed}`, newCreative: `93${seed}`, newAd: `94${seed}`,
};
const graph = vi.hoisted(() => ({
  createCampaign: vi.fn(), createAdSet: vi.fn(), createCreative: vi.fn(), createAd: vi.fn(), find: vi.fn(),
  insights: vi.fn(), platforms: vi.fn(), reach: vi.fn(),
}));
vi.mock('./graph', async (original) => ({
  ...(await original<typeof import('./graph')>()),
  exchangeLoginToken: vi.fn(async () => ({ accessToken: 'user-token' })),
  getGrantedScopes: vi.fn(async () => ['ads_read', 'ads_management', 'pages_manage_ads', 'pages_show_list', 'business_management']),
  listAdAccounts: vi.fn(async () => [
    { id: ID.primary, name: 'Main', currency: 'INR', businessId: null },
    { id: ID.second, name: 'Second', currency: 'USD', businessId: null },
  ]),
  listPages: vi.fn(async () => [{ id: ID.page, name: 'Page', accessToken: 'page-token' }]),
  subscribePageLeadgen: vi.fn(async () => {}),
  listCampaigns: vi.fn(async () => []),
  listAdObjects: vi.fn(async () => []),
  getInsights: graph.insights,
  getPlatformInsights: graph.platforms,
  getReach: graph.reach,
  createCampaign: graph.createCampaign,
  createAdSet: graph.createAdSet,
  createCreative: graph.createCreative,
  createAd: graph.createAd,
  findCreatedByName: graph.find,
  getPageInstagramAccount: vi.fn(async () => '9001'),
}));

import { disconnectDatabases, getPrisma } from '@/lib/db/prisma';
import { MetaApiError } from '@/lib/whatsapp/meta-api';
import { addAdAccount, listAvailableAdAccounts, listLinkedAdAccounts, removeAdAccount } from './accounts';
import { finishConnection, MetaAdsError, startConnection, type MetaAdsActor } from './connection';
import { discardAdDraft, handleAdCreateJob, listAdDrafts, parseAdCreateInput, recheckAdDraft, requestAdCreate } from './create';
import { handleInsightsSyncJob, listAdsWithInsights } from './insights';
import { setBudgetCap } from './manage';
import { getAdsOverview } from './overview';

const configured = config({ path: '.env.test', quiet: true }).parsed;
const ownerUrl = process.env.TEST_DATABASE_URL;
const appUrl = process.env.TEST_APP_DATABASE_URL || configured?.DATABASE_URL;
const workerUrl = process.env.TEST_WORKER_DATABASE_URL || configured?.WORKER_DATABASE_URL;
if (appUrl) process.env.DATABASE_URL = appUrl;
if (workerUrl) process.env.WORKER_DATABASE_URL = workerUrl;

const accountA = randomUUID(), accountB = randomUUID();
const adminA = randomUUID(), viewerA = randomUUID(), adminB = randomUUID();
const asA: MetaAdsActor = { accountId: accountA, userId: adminA, role: 'admin' };
const viewer: MetaAdsActor = { accountId: accountA, userId: viewerA, role: 'viewer' };
const asB: MetaAdsActor = { accountId: accountB, userId: adminB, role: 'admin' };
const attempt = { attempts: 1, maxAttempts: 5 };
let owner: pg.Client;
const env: Record<string, string | undefined> = {};
const DAY_MS = 86_400_000;
const day = (ago: number) => new Date(Date.now() - ago * DAY_MS).toISOString().slice(0, 10);

const failure = async (promise: Promise<unknown>) => promise.then(() => 'resolved', (e) => (e instanceof MetaAdsError ? e.code : e));
const draftRow = async (id: string) => (await owner.query(
  'SELECT status, step, campaign_id, adset_id, creative_id, ad_id, last_error_code, resolved_by FROM meta_ad_drafts WHERE id=$1', [id])).rows[0];
const jobs = async (type: string) => (await owner.query('SELECT payload, dedupe_key FROM jobs WHERE tenant_id=$1 AND type=$2', [accountA, type])).rows;
const input = (over: Record<string, unknown> = {}) => parseAdCreateInput({
  adAccountId: ID.primary, kind: 'whatsapp', name: `Ad ${randomUUID().slice(0, 6)}`, dailyBudgetMinor: 50000, countries: ['IN'],
  primaryText: 'Chat with us', imageHash: 'abcdef0123456789abcdef0123456789', publish: false, ...over,
})!;

describe.skipIf(!ownerUrl || !appUrl || !workerUrl)('Ads module on PostgreSQL', { timeout: 120_000 }, () => {
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
    await owner.query("INSERT INTO auth_users(id,email,full_name,password_hash) SELECT x, x::text || '@example.invalid', 'Ads module test', 'test-only-hash' FROM unnest($1::uuid[]) x", [[adminA, viewerA, adminB]]);
    await owner.query("INSERT INTO accounts(id,name,owner_user_id) VALUES($1,'Ads A',$2),($3,'Ads B',$4)", [accountA, adminA, accountB, adminB]);
    await owner.query("INSERT INTO account_memberships(account_id,user_id,role) VALUES($1,$2,'admin'),($1,$3,'viewer'),($4,$5,'admin')", [accountA, adminA, viewerA, accountB, adminB]);
    await startConnection(asA, 'login-token');
    await finishConnection(asA, { adAccountId: ID.primary, pageId: ID.page });
  });
  afterAll(async () => {
    for (const [key, value] of Object.entries(env)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    if (owner) {
      await owner.query('DELETE FROM jobs WHERE tenant_id=ANY($1::uuid[])', [[accountA, accountB]]);
      await owner.query('DELETE FROM outbound_intents WHERE account_id=ANY($1::uuid[])', [[accountA, accountB]]);
      await owner.query('DELETE FROM accounts WHERE id=ANY($1::uuid[])', [[accountA, accountB]]);
      await owner.query('DELETE FROM auth_users WHERE id=ANY($1::uuid[])', [[adminA, viewerA, adminB]]);
      await owner.end();
    }
    await disconnectDatabases();
  });

  describe('ad accounts', () => {
    it('connecting makes the chosen ad account the primary one; admins add another the login can see', async () => {
      expect((await listLinkedAdAccounts(viewer)).map((a) => [a.adAccountId, a.isPrimary])).toEqual([[ID.primary, true]]);
      expect((await listAvailableAdAccounts(asA)).map((a) => a.adAccountId)).toEqual([ID.second]);
      expect(await failure(addAdAccount(viewer, ID.second))).toBe('forbidden');
      expect(await failure(addAdAccount(asA, '999999'))).toBe('invalid_choice');
      const linked = await addAdAccount(asA, ID.second);
      expect(linked.map((a) => [a.adAccountId, a.currency, a.isPrimary])).toEqual([[ID.primary, 'INR', true], [ID.second, 'USD', false]]);
      // A full sync of the new account is queued with the add.
      expect((await jobs('meta.insights_sync')).some((j) => j.payload.full === true)).toBe(true);
      // Another workspace sees none of it, and cannot touch it.
      expect(await listLinkedAdAccounts(asB)).toEqual([]);
      expect(await failure(removeAdAccount(asB, ID.second))).toBe('not_found');
      expect(await failure(removeAdAccount(asA, ID.primary))).toBe('invalid_choice');
    });
  });

  describe('reports', () => {
    it('syncs every linked ad account and filters reports by one of them', async () => {
      graph.insights.mockImplementation(async (account: string, _t: string, o: { level: 'campaign' | 'adset' | 'ad' }) => {
        const primary = account === ID.primary;
        const campaign = primary ? ID.campA : ID.campB;
        const object = o.level === 'campaign' ? campaign : o.level === 'adset' ? ID.setA : ID.adA;
        if (!primary && o.level !== 'campaign') return [];
        return [{ level: o.level, objectId: object, campaignId: campaign, adsetId: o.level === 'campaign' ? null : ID.setA, name: `${o.level} ${account}`,
          objective: primary ? 'OUTCOME_ENGAGEMENT' : 'OUTCOME_LEADS', day: day(1), spend: primary ? 100 : 7, currency: primary ? 'INR' : 'USD',
          impressions: 1000, clicks: 40, linkClicks: 30, conversationsStarted: primary ? 12 : 0, leads: primary ? 0 : 3, purchases: 0 }];
      });
      graph.platforms.mockImplementation(async (account: string) => account === ID.primary ? [
        { campaignId: ID.campA, day: day(1), platform: 'instagram', spend: 60, impressions: 600, clicks: 20, linkClicks: 15, conversationsStarted: 8, leads: 0 },
        { campaignId: ID.campA, day: day(1), platform: 'facebook', spend: 40, impressions: 400, clicks: 20, linkClicks: 15, conversationsStarted: 4, leads: 0 },
      ] : []);
      graph.reach.mockImplementation(async (account: string, _t: string, level: string) =>
        level === 'account' ? [{ objectId: account, reach: account === ID.primary ? 700 : 50, frequency: 1.5 }] : []);
      await handleInsightsSyncJob(accountA, {});

      const range = { from: day(7), to: day(1) };
      const all = await listAdsWithInsights(viewer, { level: 'campaign', ...range });
      expect(all.rows.map((r) => r.id).sort()).toEqual([ID.campA, ID.campB].sort());
      expect(all.reachPreset).toBe('last_7d');
      const one = await listAdsWithInsights(viewer, { level: 'campaign', ...range, adAccountId: ID.second });
      expect(one.rows.map((r) => [r.id, r.adAccountId, r.leads])).toEqual([[ID.campB, ID.second, 3]]);
      const sets = await listAdsWithInsights(viewer, { level: 'adset', ...range, adAccountId: ID.primary });
      expect(sets.rows.map((r) => [r.id, r.conversationsStarted, r.linkClicks])).toEqual([[ID.setA, 12, 30]]);

      const overview = await getAdsOverview(viewer, { ...range, adAccountId: ID.primary });
      expect(overview.totals).toMatchObject({ spend: 100, impressions: 1000, conversationsStarted: 12 });
      expect(overview.reach).toBe(700);
      expect(overview.platforms.map((p) => [p.platform, p.impressions])).toEqual([['facebook', 400], ['instagram', 600]]);
      // Two currencies across accounts: spend is reported per currency, never added up.
      const mixed = await getAdsOverview(viewer, range);
      expect(mixed.spendByCurrency.map((c) => [c.currency, c.spend]).sort()).toEqual([['INR', 100], ['USD', 7]]);
      // Reach of two accounts would double-count people reached by both: not shown.
      expect(mixed.reach).toBeNull();
      // Another workspace reads nothing.
      expect((await listAdsWithInsights(asB, { level: 'campaign', ...range })).rows).toEqual([]);
      expect((await getAdsOverview(asB, range)).totals.spend).toBe(0);
    });

    it('removing a secondary ad account drops what was synced for it', async () => {
      await removeAdAccount(asA, ID.second);
      const left = await owner.query('SELECT count(*)::int AS n FROM meta_ad_insights WHERE account_id=$1 AND ad_account_id=$2', [accountA, ID.second]);
      expect(left.rows[0].n).toBe(0);
      expect((await listLinkedAdAccounts(viewer)).map((a) => a.adAccountId)).toEqual([ID.primary]);
    });
  });

  describe('creating ads', () => {
    it('records the draft and its job together; refuses viewers, unlinked accounts and budgets over the cap', async () => {
      expect(await failure(requestAdCreate(viewer, input()))).toBe('forbidden');
      expect(await failure(requestAdCreate(asA, input({ adAccountId: '123456' })))).toBe('invalid_choice');
      await setBudgetCap(asA, 40000);
      expect(await failure(requestAdCreate(asA, input()))).toBe('over_budget_cap');
      await setBudgetCap(asA, null);
      const draft = await requestAdCreate(asA, input());
      expect(draft).toMatchObject({ status: 'queued', step: 'campaign', currency: 'INR' });
      expect((await jobs('meta.ad_create')).map((j) => j.payload)).toContainEqual({ draftId: draft.id });
      expect((await listAdDrafts(asB))).toEqual([]);
    });

    it('makes the campaign, ad set, creative and ad once each, in order', async () => {
      graph.createCampaign.mockResolvedValueOnce({ id: ID.newCamp });
      graph.createAdSet.mockResolvedValueOnce({ id: ID.newSet });
      graph.createCreative.mockResolvedValueOnce({ id: ID.newCreative });
      graph.createAd.mockResolvedValueOnce({ id: ID.newAd });
      const draft = await requestAdCreate(asA, input({ kind: 'instagram_direct' }));
      await handleAdCreateJob(accountA, { draftId: draft.id }, attempt);
      expect(await draftRow(draft.id)).toMatchObject({ status: 'created', step: 'done', campaign_id: ID.newCamp, adset_id: ID.newSet,
        creative_id: ID.newCreative, ad_id: ID.newAd });
      // The creative carried the Page's Instagram account; everything was made paused (not published).
      expect(graph.createCreative.mock.calls[0][2]).toMatchObject({ instagramUserId: '9001' });
      expect(graph.createCampaign.mock.calls[0][2]).toMatchObject({ status: 'PAUSED' });
      // Running the job again sends nothing.
      await handleAdCreateJob(accountA, { draftId: draft.id }, attempt);
      expect(graph.createCampaign).toHaveBeenCalledTimes(1);
      expect((await jobs('meta.ad_objects_sync')).some((j) => j.dedupe_key === `meta-ad-objects-created:${draft.id}`)).toBe(true);
    });

    it('after an unclear send it looks the object up and adopts one match, never sending again', async () => {
      graph.createCampaign.mockClear(); graph.createAdSet.mockClear(); graph.find.mockReset();
      graph.createCampaign.mockResolvedValueOnce({ id: `95${seed}` });
      graph.createAdSet.mockRejectedValueOnce(new Error('socket hang up'));
      graph.find.mockResolvedValueOnce([`96${seed}`]);
      graph.createCreative.mockResolvedValueOnce({ id: `97${seed}` });
      graph.createAd.mockResolvedValueOnce({ id: `98${seed}` });
      const draft = await requestAdCreate(asA, input());
      await handleAdCreateJob(accountA, { draftId: draft.id }, attempt);
      expect(await draftRow(draft.id)).toMatchObject({ status: 'created', adset_id: `96${seed}`, ad_id: `98${seed}` });
      expect(graph.createAdSet).toHaveBeenCalledTimes(1);
      expect(graph.find.mock.calls[0].slice(0, 2)).toEqual(['adsets', `95${seed}`]);
    });

    it('leaves it unknown when the lookup is not conclusive; an admin re-checks or discards', async () => {
      graph.find.mockReset();
      graph.createCampaign.mockRejectedValueOnce(new Error('timeout'));
      graph.find.mockResolvedValueOnce([]);
      const draft = await requestAdCreate(asA, input());
      await handleAdCreateJob(accountA, { draftId: draft.id }, attempt);
      expect(await draftRow(draft.id)).toMatchObject({ status: 'unknown', step: 'campaign' });
      // A later run of the job leaves an unknown draft alone: no send, no lookup.
      const lookups = graph.find.mock.calls.length;
      await handleAdCreateJob(accountA, { draftId: draft.id }, attempt);
      expect(graph.find.mock.calls.length).toBe(lookups);
      expect(graph.createCampaign.mock.calls.filter((c) => c[2].name === draft.name)).toHaveLength(1);

      expect(await failure(recheckAdDraft(asB, draft.id))).toBe('not_found');
      expect(await failure(recheckAdDraft(viewer, draft.id))).toBe('forbidden');
      graph.find.mockResolvedValueOnce([`99${seed}`]);
      const found = await recheckAdDraft(asA, draft.id);
      expect(found).toMatchObject({ status: 'queued', step: 'adset', campaignId: `99${seed}` });
      expect((await jobs('meta.ad_create')).some((j) => j.dedupe_key === `adcreate:${draft.id}:resume:campaign`)).toBe(true);
    });

    it('settles a rejected step as failed with only Meta\'s code; an admin discards it', async () => {
      graph.createCampaign.mockRejectedValueOnce(new MetaApiError('secret detail', { code: 100, subcode: 1487390, httpStatus: 400 }));
      const draft = await requestAdCreate(asA, input());
      await handleAdCreateJob(accountA, { draftId: draft.id }, attempt);
      expect(await draftRow(draft.id)).toMatchObject({ status: 'failed', last_error_code: '100:1487390' });
      const discarded = await discardAdDraft(asA, draft.id);
      expect(discarded.status).toBe('discarded');
      expect((await draftRow(draft.id)).resolved_by).toBe(adminA);
    });

    it('members read drafts only through their workspace (FORCE RLS)', async () => {
      const app = getPrisma();
      const rows = await app.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.account_id', ${accountB}, true)`;
        return tx.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM meta_ad_drafts`;
      });
      expect(rows[0].n).toBe(0);
    });
  });
});
