import { randomUUID } from 'node:crypto';
import { config } from 'dotenv';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// Ads gaps on PostgreSQL: targeting and formats stored with a draft and sent
// to Meta; a video waits until Meta has processed it; duplicates and A/B
// variants; rejected ads alerted once with Meta's reason; automated rules that
// pause through the change pipeline once a day, or alert. Graph is mocked.
const seed = String(Date.now()).slice(-9);
const ID = { adAccount: `51${seed}`, page: `53${seed}`, camp: `54${seed}`, set: `55${seed}`, ad: `56${seed}`, video: `57${seed}` };
const graph = vi.hoisted(() => ({
  createCampaign: vi.fn(), createAdSet: vi.fn(), createCreative: vi.fn(), createAd: vi.fn(), video: vi.fn(), objects: vi.fn(),
}));
vi.mock('./graph', async (original) => ({
  ...(await original<typeof import('./graph')>()),
  exchangeLoginToken: vi.fn(async () => ({ accessToken: 'user-token' })),
  getGrantedScopes: vi.fn(async () => ['ads_read', 'ads_management', 'pages_manage_ads', 'pages_show_list', 'business_management']),
  listAdAccounts: vi.fn(async () => [{ id: ID.adAccount, name: 'Main', currency: 'INR', businessId: null }]),
  listPages: vi.fn(async () => [{ id: ID.page, name: 'Page', accessToken: 'page-token' }]),
  subscribePageLeadgen: vi.fn(async () => {}),
  listCampaigns: vi.fn(async () => []),
  listAdObjects: graph.objects,
  createCampaign: graph.createCampaign,
  createAdSet: graph.createAdSet,
  createCreative: graph.createCreative,
  createAd: graph.createAd,
  getVideoStatus: graph.video,
  findCreatedByName: vi.fn(async () => []),
}));

import { disconnectDatabases, getPrisma } from '@/lib/db/prisma';
import { finishConnection, MetaAdsError, startConnection, type MetaAdsActor } from './connection';
import { duplicateAdDraft, handleAdCreateJob, parseAdCreateInput, requestAdCreate, requestAdVariant } from './create';
import { handleAdObjectsSyncJob } from './manage';
import { createAdRule, deleteAdRule, handleAdRulesJob, listAdRules, setAdRuleEnabled } from './rules';

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
const HASH = 'abcdef0123456789abcdef0123456789';
let owner: pg.Client;
const env: Record<string, string | undefined> = {};
let n = 0;
const nextId = () => `6${seed}${String(++n).padStart(3, '0')}`;

const failure = async (promise: Promise<unknown>) => promise.then(() => 'resolved', (e) => (e instanceof MetaAdsError ? e.code : e));
const draftRow = async (id: string) => (await owner.query(
  'SELECT status, step, campaign_id, adset_id, ad_id, publish, variant_of::text AS variant_of FROM meta_ad_drafts WHERE id=$1', [id])).rows[0];
const notes = async () => (await owner.query("SELECT title, body FROM notifications WHERE account_id=$1 ORDER BY created_at", [accountA])).rows;
const input = (over: Record<string, unknown> = {}) => parseAdCreateInput({
  adAccountId: ID.adAccount, kind: 'whatsapp', name: `Ad ${randomUUID().slice(0, 6)}`, dailyBudgetMinor: 50000, countries: ['IN'],
  primaryText: 'Chat with us', imageHash: HASH, ...over,
})!;
const makeAll = () => {
  graph.createCampaign.mockImplementation(async () => ({ id: nextId() }));
  graph.createAdSet.mockImplementation(async () => ({ id: nextId() }));
  graph.createCreative.mockImplementation(async () => ({ id: nextId() }));
  graph.createAd.mockImplementation(async () => ({ id: nextId() }));
};

describe.skipIf(!ownerUrl || !appUrl || !workerUrl)('Ads gaps on PostgreSQL', { timeout: 120_000 }, () => {
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
    await owner.query("INSERT INTO auth_users(id,email,full_name,password_hash) SELECT x, x::text || '@example.invalid', 'Ads gaps test', 'test-only-hash' FROM unnest($1::uuid[]) x", [[adminA, viewerA, adminB]]);
    await owner.query("INSERT INTO accounts(id,name,owner_user_id) VALUES($1,'Gaps A',$2),($3,'Gaps B',$4)", [accountA, adminA, accountB, adminB]);
    await owner.query("INSERT INTO account_memberships(account_id,user_id,role) VALUES($1,$2,'admin'),($1,$3,'viewer'),($4,$5,'admin')", [accountA, adminA, viewerA, accountB, adminB]);
    await startConnection(asA, 'login-token');
    await finishConnection(asA, { adAccountId: ID.adAccount, pageId: ID.page });
  });
  beforeEach(() => { vi.clearAllMocks(); graph.objects.mockResolvedValue([]); });
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

  let created: string;

  it('stores targeting and the video with the draft; the creative waits until Meta has processed the video', async () => {
    makeAll();
    const draft = await requestAdCreate(asA, input({
      format: 'video', videoId: ID.video, placements: ['whatsapp_status'], interests: [{ id: '600', name: 'Yoga' }],
      places: [{ type: 'city', key: '2295424', name: 'Mumbai', countryCode: 'IN' }], locales: [6],
    }));
    created = draft.id;
    graph.video.mockResolvedValueOnce('processing');
    await expect(handleAdCreateJob(accountA, { draftId: draft.id }, attempt)).rejects.toThrow(/processing/);
    expect(graph.createCreative).not.toHaveBeenCalled();
    expect(await draftRow(draft.id)).toMatchObject({ status: 'queued', step: 'creative' });
    expect(graph.createAdSet.mock.calls[0][2]).toMatchObject({
      placements: ['whatsapp_status'], interests: [{ id: '600', name: 'Yoga' }], locales: [6],
      places: [{ type: 'city', key: '2295424', name: 'Mumbai', countryCode: 'IN' }],
    });
    graph.video.mockResolvedValueOnce('ready');
    await handleAdCreateJob(accountA, { draftId: draft.id }, attempt);
    expect(graph.createCreative.mock.calls[0][2]).toMatchObject({ format: 'video', videoId: ID.video, imageHash: HASH });
    expect(await draftRow(draft.id)).toMatchObject({ status: 'created', step: 'done' });
    // A video Meta could not process fails the draft without a creative.
    const broken = await requestAdCreate(asA, input({ format: 'video', videoId: ID.video }));
    graph.video.mockResolvedValueOnce('error');
    await handleAdCreateJob(accountA, { draftId: broken.id }, attempt);
    expect((await owner.query('SELECT status, last_error_code FROM meta_ad_drafts WHERE id=$1', [broken.id])).rows[0])
      .toEqual({ status: 'failed', last_error_code: 'video_error' });
  });

  it('duplicates as a paused new campaign, and adds an A/B variant inside the source ad set', async () => {
    makeAll();
    graph.video.mockResolvedValue('ready');
    expect(await failure(duplicateAdDraft(viewer, created))).toBe('forbidden');
    // Another workspace (not connected) is refused before anything of A's is read.
    expect(await failure(duplicateAdDraft(asB, created))).toBe('not_connected');
    const copy = await duplicateAdDraft(asA, created);
    expect(await draftRow(copy.id)).toMatchObject({ status: 'queued', step: 'campaign', publish: false, campaign_id: null });
    await handleAdCreateJob(accountA, { draftId: copy.id }, attempt);
    expect(graph.createCampaign).toHaveBeenCalledTimes(1);
    expect((await draftRow(copy.id)).status).toBe('created');

    const source = await draftRow(created);
    const variant = await requestAdVariant(asA, { sourceId: created, name: null, primaryText: 'Variant text', headline: null, description: null, imageHash: HASH, imageUrl: null });
    expect(variant.variantOf).toBe(created);
    expect(await draftRow(variant.id)).toMatchObject({ step: 'creative', campaign_id: source.campaign_id, adset_id: source.adset_id });
    vi.clearAllMocks();
    makeAll();
    await handleAdCreateJob(accountA, { draftId: variant.id }, attempt);
    expect(graph.createCampaign).not.toHaveBeenCalled();
    expect(graph.createAdSet).not.toHaveBeenCalled();
    expect(graph.createCreative.mock.calls[0][2]).toMatchObject({ primaryText: 'Variant text', format: 'image' });
    expect(graph.createAd.mock.calls[0][2]).toMatchObject({ adsetId: source.adset_id });
    // Only a made ad can get a variant.
    const queued = await requestAdCreate(asA, input());
    expect(await failure(requestAdVariant(asA, { sourceId: queued.id, name: null, primaryText: 'x', headline: null, description: null, imageHash: HASH, imageUrl: null })))
      .toBe('invalid_choice');
  });

  const object = (over: Record<string, unknown> = {}) => ({
    level: 'ad', id: ID.ad, campaignId: ID.camp, adsetId: ID.set, name: 'Lamp offer', status: 'ACTIVE', effectiveStatus: 'ACTIVE',
    objective: null, dailyBudgetMinor: null, lifetimeBudgetMinor: null, startTime: null, endTime: null, destinationType: null,
    optimizationGoal: null, thumbnailUrl: null, imageUrl: null, creativeTitle: null, creativeBody: null, ctaType: null, reviewFeedback: null, ...over,
  });
  const tree = (adOver: Record<string, unknown> = {}) => [
    object({ level: 'campaign', id: ID.camp, adsetId: null, name: 'Diwali' }),
    object({ level: 'adset', id: ID.set, name: 'India 18-35', dailyBudgetMinor: 80000 }),
    object(adOver),
  ];

  it("stores Meta's reason for a rejected ad and alerts the admins once", async () => {
    graph.objects.mockResolvedValue(tree());
    await handleAdObjectsSyncJob(accountA);
    expect(await notes()).toEqual([]);
    graph.objects.mockResolvedValue(tree({ effectiveStatus: 'DISAPPROVED', reviewFeedback: 'Ads may not make health claims.' }));
    await handleAdObjectsSyncJob(accountA);
    await handleAdObjectsSyncJob(accountA);
    const rejected = (await notes()).filter((r) => r.title.includes('rejected'));
    expect(rejected).toEqual([{ title: 'Meta rejected the ad "Lamp offer"', body: "Meta's reason: Ads may not make health claims." }]);
    expect((await owner.query('SELECT review_feedback FROM meta_ad_objects WHERE account_id=$1 AND object_id=$2', [accountA, ID.ad])).rows[0].review_feedback)
      .toBe('Ads may not make health claims.');
    graph.objects.mockResolvedValue(tree());
    await handleAdObjectsSyncJob(accountA);
  });

  it('a rule pauses a costly ad set through the change pipeline once a day; alert rules alert; a demoted creator cannot pause', async () => {
    const day = (ago: number) => new Date(Date.now() - ago * 86_400_000).toISOString().slice(0, 10);
    for (const ago of [0, 1, 2]) {
      await owner.query(`INSERT INTO meta_ad_insights(account_id, connection_id, ad_account_id, level, object_id, campaign_id, adset_id, name, day,
          spend, currency, impressions, clicks, conversations_started, leads)
        SELECT $1, id, $2, 'adset', $3, $4, $3, 'India 18-35', $5::date, 300, 'INR', 10000, 50, 0, 0 FROM meta_ad_connections WHERE account_id=$1 AND status='active'`,
      [accountA, ID.adAccount, ID.set, ID.camp, day(ago)]);
    }
    const rule = { name: 'Stop costly', level: 'adset' as const, metric: 'cost_per_result' as const, operator: 'gt' as const, threshold: 100, windowDays: 3, minSpend: 500 };
    expect(await failure(createAdRule(viewer, { ...rule, action: 'pause' }))).toBe('forbidden');
    const pause = await createAdRule(asA, { ...rule, action: 'pause' });
    await handleAdRulesJob(accountA);
    const changes = async () => (await owner.query("SELECT field, to_value, status FROM meta_ad_changes WHERE account_id=$1 AND object_id=$2", [accountA, ID.set])).rows;
    expect(await changes()).toEqual([{ field: 'status', to_value: 'PAUSED', status: 'queued' }]);
    expect((await owner.query("SELECT count(*)::int AS n FROM jobs WHERE tenant_id=$1 AND type='meta.ad_change'", [accountA])).rows[0].n).toBe(1);
    // Again the same day: nothing new.
    await handleAdRulesJob(accountA);
    expect(await changes()).toHaveLength(1);
    const { actions } = await listAdRules(viewer);
    expect(actions.map((a) => [a.ruleId, a.objectId, a.outcome])).toEqual([[pause.id, ID.set, 'queued']]);
    expect((await notes()).some((r) => r.title === `Rule "Stop costly" paused the ad set "India 18-35"`)).toBe(true);
    await deleteAdRule(asA, pause.id);

    const alert = await createAdRule(asA, { ...rule, name: 'Watch costly', action: 'notify' });
    await handleAdRulesJob(accountA);
    expect((await listAdRules(asA)).actions.find((a) => a.ruleId === alert.id)?.outcome).toBe('notified');
    await setAdRuleEnabled(asA, alert.id, false);

    // The creator is no longer an admin: the rule records that it could not pause.
    await owner.query("DELETE FROM meta_ad_changes WHERE account_id=$1", [accountA]);
    const demoted = await createAdRule(asA, { ...rule, name: 'Demoted', action: 'pause' });
    await owner.query("UPDATE account_memberships SET role='agent' WHERE account_id=$1 AND user_id=$2", [accountA, adminA]);
    try {
      await handleAdRulesJob(accountA);
    } finally {
      await owner.query("UPDATE account_memberships SET role='admin' WHERE account_id=$1 AND user_id=$2", [accountA, adminA]);
    }
    expect((await listAdRules(asA)).actions.find((a) => a.ruleId === demoted.id)?.outcome).toBe('skipped');
    expect(await changes()).toEqual([]);
    expect((await listAdRules(asB)).rules).toEqual([]);
  });

  it('the app role cannot write rules or their actions', async () => {
    const app = new pg.Client({ connectionString: appUrl });
    await app.connect();
    try {
      await app.query('BEGIN');
      await app.query("SELECT set_config('app.account_id',$1,true), set_config('app.user_id',$2,true)", [accountA, adminA]);
      await expect(app.query("INSERT INTO meta_ad_rules(name,level,metric,operator,threshold,window_days,action,created_by) VALUES('x','ad','spend','gt',1,1,'notify',$1)", [adminA]))
        .rejects.toThrow(/permission denied/);
      await app.query('ROLLBACK');
    } finally {
      await app.end();
    }
  });
});
