import { randomUUID } from 'node:crypto';
import { config } from 'dotenv';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// Ads phases 3-5 on PostgreSQL: a cost cap and a Messenger ad stored and sent;
// another of the admin's Pages only when the login manages it (and never for
// lead forms); "Edit ad" pauses the old ad through the change pipeline once the
// new one exists; saved setups (admins write, members read, per workspace);
// engagement audiences resolved and created by rule; deal stages reported to
// Meta once each, only when switched on. Graph is mocked.
const seed = String(Date.now()).slice(-9);
const ID = { adAccount: `81${seed}`, page: `82${seed}`, otherPage: `83${seed}`, ig: `84${seed}`, waba: `85${seed}` };
const graph = vi.hoisted(() => ({
  createCampaign: vi.fn(), createAdSet: vi.fn(), createCreative: vi.fn(), createAd: vi.fn(), rule: vi.fn(),
}));
vi.mock('./graph', async (original) => ({
  ...(await original<typeof import('./graph')>()),
  exchangeLoginToken: vi.fn(async () => ({ accessToken: 'user-token' })),
  getGrantedScopes: vi.fn(async () => ['ads_read', 'ads_management', 'pages_manage_ads', 'pages_show_list', 'business_management']),
  listAdAccounts: vi.fn(async () => [{ id: ID.adAccount, name: 'Main', currency: 'INR', businessId: null }]),
  listPages: vi.fn(async () => [{ id: ID.page, name: 'Main Page', accessToken: 'page-token' }, { id: ID.otherPage, name: 'Second Page', accessToken: 'other-token' }]),
  subscribePageLeadgen: vi.fn(async () => {}),
  listCampaigns: vi.fn(async () => []),
  listAdObjects: vi.fn(async () => []),
  createCampaign: graph.createCampaign,
  createAdSet: graph.createAdSet,
  createCreative: graph.createCreative,
  createAd: graph.createAd,
  findCreatedByName: vi.fn(async () => []),
  getPageInstagramAccount: vi.fn(async () => ID.ig),
  createRuleAudience: graph.rule,
  getAudienceSize: vi.fn(async () => ({ lower: 1000, upper: 2000 })),
}));

import { disconnectDatabases, getPrisma } from '@/lib/db/prisma';
import { encrypt } from '@/lib/whatsapp/encryption';
import { finishConnection, MetaAdsError, startConnection, type MetaAdsActor } from './connection';
import { handleAdCreateJob, parseAdCreateInput, requestAdCreate, requestAdVariant } from './create';
import { handleAudienceSyncJob, requestAudienceCreate } from './audiences';
import { deleteAdTemplate, listAdTemplates, saveAdTemplate } from './templates';
import { handleDealEventsJob } from './deal-events';

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
const nextId = () => `9${seed}${String(++n).padStart(3, '0')}`;
const failure = async (promise: Promise<unknown>) => promise.then(() => 'resolved', (e) => (e instanceof MetaAdsError ? e.code : e));
const input = (over: Record<string, unknown> = {}) => parseAdCreateInput({
  adAccountId: ID.adAccount, kind: 'whatsapp', name: `Ad ${randomUUID().slice(0, 6)}`, dailyBudgetMinor: 50000, countries: ['IN'],
  primaryText: 'Chat with us', imageHash: HASH, publish: true, ...over,
})!;
const runAll = async (draftId: string) => {
  for (let i = 0; i < 4; i++) await handleAdCreateJob(accountA, { draftId }, attempt);
};

describe.skipIf(!ownerUrl || !appUrl || !workerUrl)('Ads phases 3-5 on PostgreSQL', { timeout: 120_000 }, () => {
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
    await owner.query("INSERT INTO auth_users(id,email,full_name,password_hash) SELECT x, x::text || '@example.invalid', 'Ads phases test', 'test-only-hash' FROM unnest($1::uuid[]) x", [[adminA, viewerA, adminB]]);
    await owner.query("INSERT INTO accounts(id,name,owner_user_id) VALUES($1,'Phases A',$2),($3,'Phases B',$4)", [accountA, adminA, accountB, adminB]);
    await owner.query("INSERT INTO account_memberships(account_id,user_id,role) VALUES($1,$2,'admin'),($1,$3,'viewer'),($4,$5,'admin')", [accountA, adminA, viewerA, accountB, adminB]);
    await startConnection(asA, 'login-token');
    await finishConnection(asA, { adAccountId: ID.adAccount, pageId: ID.page });
  });
  beforeEach(() => {
    vi.clearAllMocks();
    graph.createCampaign.mockImplementation(async () => ({ id: nextId() }));
    graph.createAdSet.mockImplementation(async () => ({ id: nextId() }));
    graph.createCreative.mockImplementation(async () => ({ id: nextId() }));
    graph.createAd.mockImplementation(async () => ({ id: nextId() }));
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

  it('stores a cost cap and a Messenger ad, and sends the cap to Meta', async () => {
    const draft = await requestAdCreate(asA, input({ kind: 'messenger', bidCapMinor: 2500 }));
    expect((await owner.query('SELECT kind, bid_cap_minor FROM meta_ad_drafts WHERE id=$1', [draft.id])).rows[0]).toEqual({ kind: 'messenger', bid_cap_minor: '2500' });
    await runAll(draft.id);
    expect(graph.createAdSet.mock.calls[0][2]).toMatchObject({ kind: 'messenger', bidCapMinor: 2500 });
    expect((await owner.query('SELECT status FROM meta_ad_drafts WHERE id=$1', [draft.id])).rows[0].status).toBe('created');
  });

  it("runs from another Page only when the login manages it, and never for lead form ads", async () => {
    expect(await failure(requestAdCreate(asA, input({ pageId: `99${seed}` })))).toBe('invalid_choice');
    expect(await failure(requestAdCreate(asA, input({ kind: 'lead_form', leadFormId: '123', ctaType: 'SIGN_UP', pageId: ID.otherPage })))).toBe('invalid_choice');
    const other = await requestAdCreate(asA, input({ pageId: ID.otherPage }));
    expect(other.pageId).toBe(ID.otherPage);
    const same = await requestAdCreate(asA, input({ pageId: ID.page }));
    expect(same.pageId).toBe(ID.page);
  });

  it('Edit ad makes a new version and pauses the old ad through the change pipeline', async () => {
    const source = await requestAdCreate(asA, input());
    await runAll(source.id);
    const made = (await owner.query('SELECT campaign_id, adset_id, ad_id FROM meta_ad_drafts WHERE id=$1', [source.id])).rows[0];
    await owner.query(`INSERT INTO meta_ad_objects(account_id, connection_id, ad_account_id, level, object_id, campaign_id, adset_id, name, status, effective_status)
      SELECT $1, c.id, $2, l.level, l.id, $3, $4, l.name, 'ACTIVE', 'ACTIVE' FROM meta_ad_connections c,
        (VALUES ('campaign', $3, 'C'), ('adset', $4, 'S'), ('ad', $5, 'A')) AS l(level, id, name)
      WHERE c.account_id=$1 AND c.status='active'`, [accountA, ID.adAccount, made.campaign_id, made.adset_id, made.ad_id]);

    const edit = await requestAdVariant(asA, { sourceId: source.id, name: null, primaryText: 'New text', headline: null, description: null, imageHash: HASH, imageUrl: null, replace: true });
    expect(edit.replacesAdId).toBe(made.ad_id);
    expect(await owner.query("SELECT 1 FROM meta_ad_changes WHERE account_id=$1 AND object_id=$2", [accountA, made.ad_id]).then((r) => r.rowCount)).toBe(0);
    await runAll(edit.id);
    const change = (await owner.query("SELECT field, to_value, status FROM meta_ad_changes WHERE account_id=$1 AND object_id=$2", [accountA, made.ad_id])).rows;
    expect(change).toEqual([{ field: 'status', to_value: 'PAUSED', status: 'queued' }]);
    expect((await owner.query("SELECT action FROM audit_logs WHERE account_id=$1 AND resource_id=$2", [accountA, edit.id])).rows.map((r) => r.action)).toContain('meta_ads.ad_replace');
  });

  it('saved setups: admins write, members read, names unique, other workspaces see none', async () => {
    const saved = await saveAdTemplate(asA, { name: 'Diwali', settings: { kind: 'whatsapp', budget: '500' } });
    expect(await failure(saveAdTemplate(asA, { name: 'diwali', settings: {} }))).toBe('name_taken');
    expect(await failure(saveAdTemplate(viewer, { name: 'Viewer', settings: {} }))).toBe('forbidden');
    expect(await listAdTemplates(viewer)).toEqual([expect.objectContaining({ id: saved.id, name: 'Diwali', settings: { kind: 'whatsapp', budget: '500' } })]);
    expect(await listAdTemplates(asB)).toEqual([]);
    expect(await failure(deleteAdTemplate(asB, saved.id))).toBe('not_found');
    await deleteAdTemplate(asA, saved.id);
    expect(await listAdTemplates(asA)).toEqual([]);
  });

  it('engagement audiences resolve the Instagram account and are created by rule, with no upload', async () => {
    graph.rule.mockResolvedValue({ id: `86${seed}` });
    const audience = await requestAudienceCreate(asA, { kind: 'engagement', adAccountId: ID.adAccount, name: 'IG fans', source: 'instagram', retentionDays: 90 });
    expect(audience).toMatchObject({ kind: 'engagement', ruleSource: 'instagram', retentionDays: 90, autoSync: false, status: 'queued' });
    await handleAudienceSyncJob(accountA, { audienceId: audience.id }, attempt);
    expect(graph.rule).toHaveBeenCalledWith(ID.adAccount, 'user-token', { name: 'IG fans', source: { type: 'instagram', id: ID.ig }, retentionDays: 90 });
    expect((await owner.query('SELECT status, meta_audience_id, uploaded_count FROM meta_audiences WHERE id=$1', [audience.id])).rows[0])
      .toEqual({ status: 'ready', meta_audience_id: `86${seed}`, uploaded_count: null });
    await expect(owner.query(`INSERT INTO meta_audiences(account_id, connection_id, ad_account_id, kind, name, rule_source, retention_days, created_by)
      SELECT account_id, id, $2, 'website', 'Bad', 'page:1', 30, $3 FROM meta_ad_connections WHERE account_id=$1 AND status='active'`,
    [accountA, ID.adAccount, adminA])).rejects.toThrow(/meta_audiences_rule_check/);
  });

  it('deal stages are reported once each, only when switched on', async () => {
    const number = (await owner.query("INSERT INTO whatsapp_config(account_id,user_id,phone_number_id,waba_id,access_token,status) VALUES($1,$2,$3,$4,$5,'connected') RETURNING id",
      [accountA, adminA, `87${seed}`, ID.waba, encrypt('test-only-token')])).rows[0].id;
    const contact = (await owner.query("INSERT INTO contacts(account_id,user_id,name,phone) VALUES($1,$2,'Deal lead',$3) RETURNING id", [accountA, adminA, `+9187${seed}`])).rows[0].id;
    await owner.query(`INSERT INTO ad_referrals(account_id,contact_id,wa_message_id,whatsapp_config_id,source_id,source_type,ctwa_clid,created_at)
      VALUES($1,$2,$3,$4,'120000000099','ad','clid-deal', now() - interval '1 day')`, [accountA, contact, `wamid.deal.${seed}`, number]);
    const pipeline = (await owner.query("INSERT INTO pipelines(account_id,user_id,name) VALUES($1,$2,'Sales') RETURNING id", [accountA, adminA])).rows[0].id;
    const stage = (await owner.query("INSERT INTO pipeline_stages(account_id,pipeline_id,name) VALUES($1,$2,'Won') RETURNING id", [accountA, pipeline])).rows[0].id;
    const deal = (await owner.query(`INSERT INTO deals(account_id,user_id,pipeline_id,stage_id,contact_id,title,status,value,currency)
      VALUES($1,$2,$3,$4,$5,'Lamps','won',1500,'INR') RETURNING id`, [accountA, adminA, pipeline, stage, contact])).rows[0].id;
    await owner.query(`UPDATE meta_ad_connections SET capi_enabled=true, capi_dataset_id=$2, capi_waba_id=$3, capi_whatsapp_config_id=$4
      WHERE account_id=$1 AND status='active'`, [accountA, `88${seed}`, ID.waba, number]);

    expect(await handleDealEventsJob(accountA)).toEqual({ leads: 0, purchases: 0 });
    await owner.query("UPDATE meta_ad_connections SET capi_deal_events=true WHERE account_id=$1 AND status='active'", [accountA]);
    expect(await handleDealEventsJob(accountA)).toEqual({ leads: 1, purchases: 1 });
    expect(await handleDealEventsJob(accountA)).toEqual({ leads: 0, purchases: 0 });
    const events = (await owner.query("SELECT event_name, event_id, source, value::text AS value, currency FROM capi_events WHERE account_id=$1 ORDER BY event_name", [accountA])).rows;
    expect(events).toEqual([
      { event_name: 'Purchase', event_id: expect.stringContaining(deal), source: 'deal', value: '1500.000000', currency: 'INR' },
      { event_name: 'QualifiedLead', event_id: expect.stringContaining(deal), source: 'deal', value: null, currency: null },
    ]);
    expect(await handleDealEventsJob(accountB)).toEqual({ leads: 0, purchases: 0 });
  });
});
