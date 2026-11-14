import { randomUUID } from 'node:crypto';
import { config } from 'dotenv';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// Graph is mocked: no Meta network. Each account's Login code maps to a token
// that sees the same ad account and Page, so two workspaces can race for it.
vi.mock('./graph', async (original) => ({
  ...(await original<typeof import('./graph')>()),
  exchangeLoginToken: vi.fn(async (_c: unknown, code: string) => ({ accessToken: `user-token-${code}` })),
  getGrantedScopes: vi.fn(async () => ['ads_read']),
  listAdAccounts: vi.fn(async () => [{ id: process.env.IT_AD_ACCOUNT, name: 'Acct', currency: 'INR', businessId: null }]),
  listPages: vi.fn(async () => [{ id: process.env.IT_PAGE, name: 'Page', accessToken: 'page-token' }]),
  subscribePageLeadgen: vi.fn(async () => {}),
  unsubscribePage: vi.fn(async () => {}),
  listCampaigns: vi.fn(async () => [{ id: process.env.IT_CAMPAIGN, name: 'Camp', status: 'ACTIVE', objective: null }]),
  getInsights: vi.fn(async (_a: string, _t: string, o: { level: 'campaign' | 'adset' | 'ad'; until: string }) => [{
    level: o.level, objectId: o.level === 'ad' ? process.env.IT_AD : process.env.IT_CAMPAIGN, campaignId: process.env.IT_CAMPAIGN,
    name: o.level, objective: null, day: o.until, spend: 12.5, currency: 'INR', impressions: 1000, clicks: 40, conversationsStarted: 3,
    adsetId: null, linkClicks: 30, leads: 0, purchases: 0,
  }]),
  getPlatformInsights: vi.fn(async () => []),
  getReach: vi.fn(async () => []),
}));

import { disconnectDatabases, getPrisma, getWorkerPrisma } from '@/lib/db/prisma';
import { withTenant } from '@/lib/db/tenant';
import { disconnect, finishConnection, getConnection, MetaAdsError, startConnection, type MetaAdsActor } from './connection';
import { handleInsightsSyncJob, insightsWindow, listAdsWithInsights, queueInsightsSync } from './insights';

const configured = config({ path: '.env.test', quiet: true }).parsed;
const ownerUrl = process.env.TEST_DATABASE_URL;
const appUrl = process.env.TEST_APP_DATABASE_URL || configured?.DATABASE_URL;
const workerUrl = process.env.TEST_WORKER_DATABASE_URL || configured?.WORKER_DATABASE_URL;
if (appUrl) process.env.DATABASE_URL = appUrl;
if (workerUrl) process.env.WORKER_DATABASE_URL = workerUrl;

const seed = String(Date.now()).slice(-9);
process.env.IT_AD_ACCOUNT = `81${seed}`;
process.env.IT_PAGE = `82${seed}`;
process.env.IT_CAMPAIGN = `83${seed}`;
process.env.IT_AD = `84${seed}`;
const accountA = randomUUID(), accountB = randomUUID();
const adminA = randomUUID(), viewerA = randomUUID(), adminB = randomUUID();
const asA: MetaAdsActor = { accountId: accountA, userId: adminA, role: 'admin' };
const viewer: MetaAdsActor = { accountId: accountA, userId: viewerA, role: 'viewer' };
const asB: MetaAdsActor = { accountId: accountB, userId: adminB, role: 'admin' };
const choice = { adAccountId: `81${seed}`, pageId: `82${seed}` };
let owner: pg.Client;
const env: Record<string, string | undefined> = {};

const failure = async (promise: Promise<unknown>) => promise.then(() => 'resolved', (e) => (e instanceof MetaAdsError ? e.code : e));
const rows = async (account: string) =>
  (await owner.query('SELECT status, user_token_enc, page_token_enc FROM meta_ad_connections WHERE account_id=$1 ORDER BY created_at', [account])).rows;
const resolvePage = async () =>
  (await getWorkerPrisma().$queryRawUnsafe<{ account_id: string }[]>('SELECT account_id::text AS account_id FROM crm_resolve_page_account($1)', choice.pageId));

describe.skipIf(!ownerUrl || !appUrl || !workerUrl)('Meta ad connection on PostgreSQL', { timeout: 120_000 }, () => {
  beforeAll(async () => {
    for (const key of ['META_ADS_ENABLED', 'META_APP_ID', 'META_APP_SECRET', 'META_ADS_LOGIN_CONFIG_ID']) env[key] = process.env[key];
    Object.assign(process.env, { META_ADS_ENABLED: 'true', META_APP_ID: '1234', META_APP_SECRET: 'test-only-secret', META_ADS_LOGIN_CONFIG_ID: '5678' });
    owner = new pg.Client({ connectionString: ownerUrl });
    await owner.connect();
    if (!/test/i.test((await owner.query('SELECT current_database() AS name')).rows[0].name)) throw new Error('Requires an isolated test database');
    const app = await getPrisma().$queryRaw<{ role: string }[]>`SELECT current_user AS role`;
    if (app[0].role !== 'bodhinox_app') throw new Error('Requires constrained test app credentials');
    await owner.query("INSERT INTO auth_users(id,email,full_name,password_hash) SELECT x, x::text || '@example.invalid', 'Meta ads test', 'test-only-hash' FROM unnest($1::uuid[]) x", [[adminA, viewerA, adminB]]);
    await owner.query("INSERT INTO accounts(id,name,owner_user_id) VALUES($1,'Ads A',$2),($3,'Ads B',$4)", [accountA, adminA, accountB, adminB]);
    await owner.query("INSERT INTO account_memberships(account_id,user_id,role) VALUES($1,$2,'admin'),($1,$3,'viewer'),($4,$5,'admin')", [accountA, adminA, viewerA, accountB, adminB]);
  });
  afterAll(async () => {
    for (const [key, value] of Object.entries(env)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    if (owner) {
      await owner.query('DELETE FROM jobs WHERE tenant_id=ANY($1::uuid[])', [[accountA, accountB]]);
      await owner.query('DELETE FROM accounts WHERE id=ANY($1::uuid[])', [[accountA, accountB]]);
      await owner.query('DELETE FROM auth_users WHERE id=ANY($1::uuid[])', [[adminA, viewerA, adminB]]);
      await owner.end();
    }
    await disconnectDatabases();
  });

  it('stores one pending row per workspace with the token encrypted and unreadable to the app role', async () => {
    expect(await failure(startConnection(viewer, 'v'))).toBe('forbidden');
    await startConnection(asA, 'a1');
    const second = await startConnection(asA, 'a2');
    expect(second.status).toBe('pending');
    const stored = await rows(accountA);
    expect(stored).toHaveLength(1);
    expect(stored[0].user_token_enc).not.toContain('user-token');
    const app = { accountId: accountA, userId: adminA, role: 'admin' as const };
    await expect(withTenant(app, (tx) => tx.$queryRawUnsafe('SELECT user_token_enc FROM meta_ad_connections'))).rejects.toThrow();
    await expect(withTenant(app, (tx) => tx.$queryRawUnsafe('SELECT page_token_enc FROM meta_ad_connections'))).rejects.toThrow();
    expect(await getConnection(viewer)).toMatchObject({ status: 'pending' });
  });

  it('activates the Page for one workspace only and frees it on disconnect', async () => {
    const active = await finishConnection(asA, choice);
    expect(active).toMatchObject({ status: 'active', pageId: choice.pageId, adAccountId: choice.adAccountId });
    expect((await rows(accountA))[0].page_token_enc).not.toContain('page-token');
    expect(await failure(startConnection(asA, 'again'))).toBe('already_connected');
    expect(await resolvePage()).toEqual([{ account_id: accountA }]);

    await startConnection(asB, 'b1');
    expect(await failure(finishConnection(asB, choice))).toBe('page_in_use');
    // A token_invalid connection still holds the Page.
    await owner.query("UPDATE meta_ad_connections SET status='token_invalid' WHERE account_id=$1", [accountA]);
    expect(await failure(finishConnection(asB, choice))).toBe('page_in_use');
    expect(await resolvePage()).toEqual([]);

    const gone = await disconnect(asA);
    expect(gone?.status).toBe('disconnected');
    expect((await rows(accountA))[0]).toMatchObject({ user_token_enc: '', page_token_enc: '' });
    const audits = (await owner.query("SELECT action FROM audit_logs WHERE account_id=$1 AND action LIKE 'meta_ads.%' ORDER BY created_at", [accountA])).rows.map((r) => r.action);
    expect(audits).toEqual(['meta_ads.connect', 'meta_ads.disconnect']);
    expect(await finishConnection(asB, choice)).toMatchObject({ status: 'active' });
    expect(await resolvePage()).toEqual([{ account_id: accountB }]);
  });

  it('keeps the worker policy tenant-scoped and one live row per workspace', async () => {
    const touched = await withTenant({ accountId: accountA, role: 'owner' }, (tx) =>
      tx.$executeRaw`UPDATE meta_ad_connections SET page_name='x' WHERE account_id=${accountB}::uuid`, getWorkerPrisma());
    expect(touched).toBe(0);
    await expect(owner.query("INSERT INTO meta_ad_connections(account_id,connected_by,status) VALUES($1,$2,'pending')", [accountB, adminB]))
      .rejects.toMatchObject({ code: '23505' });
  });

  it('syncs insights through the worker and joins conversations Bodhinox saw', async () => {
    const contact = (await owner.query("INSERT INTO contacts(account_id,user_id,name,phone) VALUES($1,$2,'Lead',$3) RETURNING id", [accountB, adminB, `+9198${seed}`])).rows[0].id;
    await owner.query(`INSERT INTO ad_referrals(account_id,contact_id,wa_message_id,source_id,source_type,ctwa_clid)
      VALUES($1,$2,$3,$4,'ad','clid')`, [accountB, contact, `wamid.${seed}`, `84${seed}`]);
    await handleInsightsSyncJob(accountB, {});
    const { since, until } = insightsWindow();
    const ads = await listAdsWithInsights({ ...asB, role: 'viewer' }, { level: 'ad', from: since, to: until });
    expect(ads.rows).toEqual([expect.objectContaining({ id: `84${seed}`, spend: 12.5, conversationsStarted: 3, conversationsInBodhinox: 1 })]);
    expect(ads.insightsSyncedAt).not.toBeNull();
    const campaigns = await listAdsWithInsights(asB, { level: 'campaign', from: since, to: until });
    expect(campaigns.rows).toEqual([expect.objectContaining({ id: `83${seed}`, status: 'ACTIVE', conversationsInBodhinox: 1 })]);
    // Another workspace sees none of it.
    expect((await listAdsWithInsights(asA, { level: 'ad', from: since, to: until })).rows).toEqual([]);

    expect(await queueInsightsSync(asB)).toBe(true);
    expect(await queueInsightsSync(asB)).toBe(true);
    const jobs = (await owner.query("SELECT count(*)::int AS n FROM jobs WHERE tenant_id=$1 AND type='meta.insights_sync'", [accountB])).rows[0].n;
    expect(jobs).toBe(1);
    expect(await queueInsightsSync(asA)).toBe(false);
  });

  it('counts ad chats on the workspace timezone days and lists ads that have chats but no spend row', async () => {
    await owner.query("INSERT INTO workspace_inbox_settings(account_id,timezone) VALUES($1,'Asia/Kolkata')", [accountA]);
    const contact = (await owner.query("INSERT INTO contacts(account_id,user_id,name,phone) VALUES($1,$2,'Night lead',$3) RETURNING id", [accountA, adminA, `+9197${seed}`])).rows[0].id;
    // 20:00 UTC on 10 Jan is 01:30 on 11 Jan in India.
    await owner.query(`INSERT INTO ad_referrals(account_id,contact_id,wa_message_id,source_id,source_type,ctwa_clid,created_at)
      VALUES($1,$2,$3,$4,'ad','clid-night','2026-01-10T20:00:00Z')`, [accountA, contact, `wamid.night.${seed}`, `85${seed}`]);

    const day11 = await listAdsWithInsights(viewer, { level: 'ad', from: '2026-01-11', to: '2026-01-11' });
    expect(day11.rows).toEqual([expect.objectContaining({
      id: `85${seed}`, spend: null, impressions: null, clicks: null, conversationsStarted: null, conversationsInBodhinox: 1,
    })]);
    expect((await listAdsWithInsights(viewer, { level: 'ad', from: '2026-01-10', to: '2026-01-10' })).rows).toEqual([]);
    // Workspace B never sees workspace A's chats.
    expect((await listAdsWithInsights(asB, { level: 'ad', from: '2026-01-11', to: '2026-01-11' })).rows).toEqual([]);
  });
});
