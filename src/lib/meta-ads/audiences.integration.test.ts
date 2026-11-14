import { randomUUID } from 'node:crypto';
import { config } from 'dotenv';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// Custom audiences on PostgreSQL: a customer list built from a segment (only
// reachable contacts, hashed, never another workspace's), made once at Meta
// (an unclear create is looked up by name, never re-sent), lookalikes of it,
// and ads that include or exclude them. Graph is mocked.
const seed = String(Date.now()).slice(-9);
const ID = { adAccount: `71${seed}`, page: `73${seed}`, audience: `74${seed}`, lookalike: `75${seed}`, other: `76${seed}` };
const graph = vi.hoisted(() => ({
  terms: vi.fn(), createList: vi.fn(), createLookalike: vi.fn(), replace: vi.fn(), size: vi.fn(), find: vi.fn(),
  createCampaign: vi.fn(), createAdSet: vi.fn(), createCreative: vi.fn(), createAd: vi.fn(),
}));
vi.mock('./graph', async (original) => ({
  ...(await original<typeof import('./graph')>()),
  exchangeLoginToken: vi.fn(async () => ({ accessToken: 'user-token' })),
  getGrantedScopes: vi.fn(async () => ['ads_read', 'ads_management', 'pages_manage_ads', 'pages_show_list', 'business_management']),
  listAdAccounts: vi.fn(async () => [{ id: ID.adAccount, name: 'Main', currency: 'INR', businessId: null }]),
  listPages: vi.fn(async () => [{ id: ID.page, name: 'Page', accessToken: 'page-token' }]),
  subscribePageLeadgen: vi.fn(async () => {}),
  listCampaigns: vi.fn(async () => []),
  hasCustomAudienceTerms: graph.terms,
  createCustomerListAudience: graph.createList,
  createLookalikeAudience: graph.createLookalike,
  replaceAudienceUsers: graph.replace,
  getAudienceSize: graph.size,
  findAudiencesByName: graph.find,
  createCampaign: graph.createCampaign,
  createAdSet: graph.createAdSet,
  createCreative: graph.createCreative,
  createAd: graph.createAd,
  findCreatedByName: vi.fn(async () => []),
}));

import { disconnectDatabases, getPrisma } from '@/lib/db/prisma';
import { MetaApiError } from '@/lib/whatsapp/meta-api';
import {
  handleAudienceSyncJob, hashEmail, hashPhone, listAudiences, recheckAudience, removeAudience, requestAudienceCreate,
  requestAudienceSync, setAudienceAutoSync,
} from './audiences';
import { finishConnection, MetaAdsError, startConnection, type MetaAdsActor } from './connection';
import { handleAdCreateJob, parseAdCreateInput, requestAdCreate } from './create';

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
const company = `AudTest${seed}`;
let owner: pg.Client;
let segmentId: string;
const env: Record<string, string | undefined> = {};

const failure = async (promise: Promise<unknown>) => promise.then(() => 'resolved', (e) => (e instanceof MetaAdsError ? e.code : e));
const row = async (id: string) => (await owner.query(
  'SELECT status, meta_audience_id, uploaded_count, matched_lower, last_error_code, auto_sync FROM meta_audiences WHERE id=$1', [id])).rows[0];
const job = async (id: string) => (await owner.query("SELECT dedupe_key FROM jobs WHERE tenant_id=$1 AND type='meta.audience_sync' AND payload->>'audienceId'=$2",
  [accountA, id])).rows.map((r) => r.dedupe_key);

describe.skipIf(!ownerUrl || !appUrl || !workerUrl)('Meta custom audiences on PostgreSQL', { timeout: 120_000 }, () => {
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
    await owner.query("INSERT INTO auth_users(id,email,full_name,password_hash) SELECT x, x::text || '@example.invalid', 'Audience test', 'test-only-hash' FROM unnest($1::uuid[]) x", [[adminA, viewerA, adminB]]);
    await owner.query("INSERT INTO accounts(id,name,owner_user_id) VALUES($1,'Aud A',$2),($3,'Aud B',$4)", [accountA, adminA, accountB, adminB]);
    await owner.query("INSERT INTO account_memberships(account_id,user_id,role) VALUES($1,$2,'admin'),($1,$3,'viewer'),($4,$5,'admin')", [accountA, adminA, viewerA, accountB, adminB]);
    // Segment members: reachable by phone, reachable by email only, blocked, opted out; one non-member; one in another workspace.
    await owner.query(`INSERT INTO contacts(account_id,user_id,name,phone,email,company,blocked_at,opted_out_at) VALUES
      ($1,$2,'Phone',$4,NULL,$5,NULL,NULL),
      ($1,$2,'Email','+9177${seed}1','Mail@Example.COM',$5,NULL,NULL),
      ($1,$2,'Blocked',$6,NULL,$5,now(),NULL),
      ($1,$2,'Opted out',$7,NULL,$5,NULL,now()),
      ($1,$2,'Not in segment',$8,NULL,'Other',NULL,NULL),
      ($3,$2,'Other workspace',$9,NULL,$5,NULL,NULL)`,
    [accountA, adminA, accountB, `+9171${seed}`, company, `+9172${seed}`, `+9173${seed}`, `+9174${seed}`, `+9175${seed}`]);
    // The email-only member above also has a phone; give one contact neither so it is skipped.
    await owner.query("INSERT INTO contacts(account_id,user_id,name,phone,company) VALUES($1,$2,'No phone',NULL,$3)", [accountA, adminA, company])
      .catch(() => {});
    segmentId = (await owner.query('INSERT INTO segments(account_id,user_id,name,filter) VALUES($1,$2,$3,$4::jsonb) RETURNING id::text AS id',
      [accountA, adminA, 'Paid', JSON.stringify({ match: 'all', conditions: [{ field: 'company', op: 'contains', value: company }] })])).rows[0].id;
    await startConnection(asA, 'login-token');
    await finishConnection(asA, { adAccountId: ID.adAccount, pageId: ID.page });
  });
  beforeEach(() => {
    vi.clearAllMocks();
    graph.terms.mockResolvedValue(true);
    graph.size.mockResolvedValue({ lower: 1000, upper: 1200 });
    graph.replace.mockResolvedValue({ received: 0, invalid: 0 });
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

  let listId: string;

  it('admins create a customer list from a segment; it is made once and uploads only reachable members, hashed', async () => {
    const input = { kind: 'customer_list' as const, adAccountId: ID.adAccount, name: 'Paid customers', segmentId, autoSync: true };
    expect(await failure(requestAudienceCreate(viewer, input))).toBe('forbidden');
    expect(await failure(requestAudienceCreate(asA, { ...input, adAccountId: '999' }))).toBe('invalid_choice');
    expect(await failure(requestAudienceCreate(asA, { ...input, segmentId: randomUUID() }))).toBe('invalid_choice');
    const created = await requestAudienceCreate(asA, input);
    listId = created.id;
    expect(created).toMatchObject({ status: 'queued', kind: 'customer_list', segmentName: 'Paid', autoSync: true });
    expect(await job(listId)).toEqual([`audience:${listId}`]);
    expect(await failure(requestAudienceCreate(asA, { ...input, name: 'PAID customers' }))).toBe('name_taken');

    graph.createList.mockResolvedValueOnce({ id: ID.audience });
    await handleAudienceSyncJob(accountA, { audienceId: listId }, attempt);
    expect(graph.createList).toHaveBeenCalledTimes(1);
    expect(graph.createList.mock.calls[0].slice(0, 3)).toEqual([ID.adAccount, 'user-token', 'Paid customers']);
    const [audienceId, , session, rows] = graph.replace.mock.calls[0];
    expect(audienceId).toBe(ID.audience);
    expect(session).toMatchObject({ batch: 1, last: true, estimatedTotal: 2 });
    expect(new Set(rows.map((r: string[]) => r.join('|')))).toEqual(new Set([
      `${hashPhone(`+9171${seed}`)}|`,
      `${hashPhone(`+9177${seed}1`)}|${hashEmail('mail@example.com')}`,
    ]));
    // Only digests travel: no raw number or email in the call.
    for (const raw of [`9171${seed}`, `9177${seed}1`, 'mail@example.com', 'Mail@Example.COM'])
      expect(JSON.stringify(graph.replace.mock.calls)).not.toContain(raw);
    expect(await row(listId)).toMatchObject({ status: 'ready', meta_audience_id: ID.audience, uploaded_count: 2, matched_lower: '1000', last_error_code: null });

    // A repeat run never creates it again; it re-uploads (replace) only.
    await handleAudienceSyncJob(accountA, { audienceId: listId }, attempt);
    expect(graph.createList).toHaveBeenCalledTimes(1);
    expect(graph.replace).toHaveBeenCalledTimes(2);
  });

  it('the 6-hourly run uploads auto-sync lists only; members may read but not change them', async () => {
    await handleAudienceSyncJob(accountA, {}, attempt);
    expect(graph.replace).toHaveBeenCalledTimes(1);
    expect(await failure(setAudienceAutoSync(viewer, listId, false))).toBe('forbidden');
    expect((await setAudienceAutoSync(asA, listId, false)).autoSync).toBe(false);
    await handleAudienceSyncJob(accountA, {}, attempt);
    expect(graph.replace).toHaveBeenCalledTimes(1);
    await setAudienceAutoSync(asA, listId, true);
    expect((await listAudiences(viewer)).map((a) => a.id)).toContain(listId);
    expect(await listAudiences(asB)).toEqual([]);
    expect(await failure(requestAudienceSync(asB, listId))).toBe('not_found');
    const synced = await requestAudienceSync(asA, listId);
    expect(synced.status).toBe('queued');
    expect((await job(listId)).filter((k) => k.startsWith('audsync:'))).toHaveLength(1);
    await handleAudienceSyncJob(accountA, { audienceId: listId }, attempt);
    expect((await row(listId)).status).toBe('ready');
  });

  it('an unaccepted Custom Audience terms page fails the create before anything is sent', async () => {
    const created = await requestAudienceCreate(asA, { kind: 'customer_list', adAccountId: ID.adAccount, name: 'No terms', segmentId, autoSync: true });
    graph.terms.mockResolvedValueOnce(false);
    await handleAudienceSyncJob(accountA, { audienceId: created.id }, attempt);
    expect(graph.createList).not.toHaveBeenCalled();
    expect(await row(created.id)).toMatchObject({ status: 'failed', last_error_code: 'terms_not_accepted' });
    await removeAudience(asA, created.id);
  });

  it('an unclear create is adopted by name; when that is unclear too an admin re-checks', async () => {
    const one = await requestAudienceCreate(asA, { kind: 'customer_list', adAccountId: ID.adAccount, name: 'Unclear one', segmentId, autoSync: false });
    graph.createList.mockRejectedValueOnce(new Error('socket hang up'));
    graph.find.mockResolvedValueOnce([ID.other]);
    await handleAudienceSyncJob(accountA, { audienceId: one.id }, attempt);
    expect(await row(one.id)).toMatchObject({ status: 'ready', meta_audience_id: ID.other });

    const two = await requestAudienceCreate(asA, { kind: 'customer_list', adAccountId: ID.adAccount, name: 'Unclear two', segmentId, autoSync: false });
    graph.createList.mockRejectedValueOnce(new Error('timeout'));
    graph.find.mockResolvedValueOnce([]);
    await handleAudienceSyncJob(accountA, { audienceId: two.id }, attempt);
    expect(await row(two.id)).toMatchObject({ status: 'unknown', meta_audience_id: null });
    // The job never sends again for an unknown audience.
    await handleAudienceSyncJob(accountA, { audienceId: two.id }, attempt);
    expect(graph.createList).toHaveBeenCalledTimes(2);
    expect(await failure(recheckAudience(viewer, two.id))).toBe('forbidden');
    graph.find.mockResolvedValueOnce([`77${seed}`]);
    expect((await recheckAudience(asA, two.id)).status).toBe('queued');
    await handleAudienceSyncJob(accountA, { audienceId: two.id }, attempt);
    expect(await row(two.id)).toMatchObject({ status: 'ready', meta_audience_id: `77${seed}` });
    expect(graph.createList).toHaveBeenCalledTimes(2);
    await removeAudience(asA, one.id);
    await removeAudience(asA, two.id);
  });

  it('a rejected create is failed with its code only', async () => {
    const created = await requestAudienceCreate(asA, { kind: 'customer_list', adAccountId: ID.adAccount, name: 'Rejected', segmentId, autoSync: false });
    graph.createList.mockRejectedValueOnce(new MetaApiError('secret detail', { code: 2654, subcode: 1870034, httpStatus: 400 }));
    await handleAudienceSyncJob(accountA, { audienceId: created.id }, attempt);
    expect(await row(created.id)).toMatchObject({ status: 'failed', last_error_code: '2654:1870034' });
    await removeAudience(asA, created.id);
  });

  it('a lookalike needs a customer list Meta already has; it is created without an upload', async () => {
    const input = { kind: 'lookalike' as const, adAccountId: ID.adAccount, name: 'Paid LAL 1%', originId: listId, country: 'IN', percent: 1 };
    expect(await failure(requestAudienceCreate(asA, { ...input, originId: randomUUID() }))).toBe('invalid_choice');
    const created = await requestAudienceCreate(asA, input);
    graph.createLookalike.mockResolvedValueOnce({ id: ID.lookalike });
    await handleAudienceSyncJob(accountA, { audienceId: created.id }, attempt);
    expect(graph.createLookalike.mock.calls[0][2]).toEqual({ name: 'Paid LAL 1%', originAudienceId: ID.audience, country: 'IN', percent: 1 });
    expect(graph.replace).not.toHaveBeenCalled();
    expect(await row(created.id)).toMatchObject({ status: 'ready', meta_audience_id: ID.lookalike, auto_sync: false });
    expect(await failure(requestAudienceSync(asA, created.id))).toBe('invalid_request');
  });

  it('ads include and exclude ready audiences by their Meta ids; others are refused', async () => {
    const lookalikes = await listAudiences(asA);
    const lal = lookalikes.find((a) => a.kind === 'lookalike')!;
    const base = {
      adAccountId: ID.adAccount, kind: 'whatsapp', name: `Ad ${seed}`, dailyBudgetMinor: 50000, countries: ['IN'],
      primaryText: 'Chat with us', imageHash: 'abcdef0123456789abcdef0123456789',
    };
    expect(await failure(requestAdCreate(asA, parseAdCreateInput({ ...base, audienceIds: [randomUUID()] })!))).toBe('invalid_choice');
    const draft = await requestAdCreate(asA, parseAdCreateInput({ ...base, audienceIds: [lal.id], excludedAudienceIds: [listId] })!);
    expect((await owner.query('SELECT audience_ids, excluded_audience_ids FROM meta_ad_drafts WHERE id=$1', [draft.id])).rows[0])
      .toEqual({ audience_ids: [ID.lookalike], excluded_audience_ids: [ID.audience] });
    graph.createCampaign.mockResolvedValueOnce({ id: `61${seed}` });
    graph.createAdSet.mockResolvedValueOnce({ id: `62${seed}` });
    graph.createCreative.mockResolvedValueOnce({ id: `63${seed}` });
    graph.createAd.mockResolvedValueOnce({ id: `64${seed}` });
    await handleAdCreateJob(accountA, { draftId: draft.id }, attempt);
    expect(graph.createAdSet.mock.calls[0][2]).toMatchObject({ audienceIds: [ID.lookalike], excludedAudienceIds: [ID.audience] });
  });

  it('removing a list removes its lookalikes too; the app role cannot write audiences', async () => {
    const app = new pg.Client({ connectionString: appUrl });
    await app.connect();
    try {
      await app.query('BEGIN');
      await app.query("SELECT set_config('app.account_id',$1,true), set_config('app.user_id',$2,true)", [accountA, adminA]);
      await expect(app.query("UPDATE meta_audiences SET status='ready'")).rejects.toThrow(/permission denied/);
      await app.query('ROLLBACK');
    } finally {
      await app.end();
    }
    await removeAudience(asA, listId);
    expect((await owner.query('SELECT count(*)::int AS n FROM meta_audiences WHERE account_id=$1', [accountA])).rows[0].n).toBe(0);
    const audit = (await owner.query("SELECT action FROM audit_logs WHERE account_id=$1 AND action LIKE 'meta_ads.audience_%'", [accountA])).rows.map((r) => r.action);
    expect(audit).toEqual(expect.arrayContaining(['meta_ads.audience_create', 'meta_ads.audience_sync', 'meta_ads.audience_remove', 'meta_ads.audience_recheck']));
  });
});
