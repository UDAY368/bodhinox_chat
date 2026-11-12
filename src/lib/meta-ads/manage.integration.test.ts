import { randomUUID } from 'node:crypto';
import { config } from 'dotenv';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// Graph is mocked: no Meta network. One ad account with a campaign (daily
// budget 500.00), a paused ad set under it and an ad.
const graph = vi.hoisted(() => ({
  update: vi.fn(async (): Promise<{ success: boolean }> => ({ success: true })),
  read: vi.fn(async (): Promise<unknown> => null),
}));
vi.mock('./graph', async (original) => ({
  ...(await original<typeof import('./graph')>()),
  exchangeLoginCode: vi.fn(async (_c: unknown, code: string) => ({ accessToken: `user-token-${code}` })),
  getGrantedScopes: vi.fn(async () => ['ads_read', 'ads_management']),
  listAdAccounts: vi.fn(async () => [{ id: process.env.IT_M_ACCOUNT, name: 'Acct', currency: 'INR', businessId: null }]),
  listPages: vi.fn(async () => [{ id: process.env.IT_M_PAGE, name: 'Page', accessToken: 'page-token' }]),
  subscribePageLeadgen: vi.fn(async () => {}),
  unsubscribePage: vi.fn(async () => {}),
  listAdObjects: vi.fn(async () => [
    { level: 'campaign', id: process.env.IT_M_CAMPAIGN, campaignId: process.env.IT_M_CAMPAIGN, adsetId: null, name: 'Diwali',
      status: 'ACTIVE', effectiveStatus: 'ACTIVE', objective: 'OUTCOME_ENGAGEMENT', dailyBudgetMinor: 50000, lifetimeBudgetMinor: null,
      startTime: null, endTime: null },
    { level: 'adset', id: process.env.IT_M_ADSET, campaignId: process.env.IT_M_CAMPAIGN, adsetId: process.env.IT_M_ADSET, name: 'India 25-40',
      status: 'PAUSED', effectiveStatus: 'PAUSED', objective: null, dailyBudgetMinor: null, lifetimeBudgetMinor: null,
      startTime: null, endTime: '2026-12-31T18:30:00.000Z' },
    { level: 'ad', id: process.env.IT_M_AD, campaignId: process.env.IT_M_CAMPAIGN, adsetId: process.env.IT_M_ADSET, name: 'Lamp ad',
      status: 'ACTIVE', effectiveStatus: 'ADSET_PAUSED', objective: null, dailyBudgetMinor: null, lifetimeBudgetMinor: null,
      startTime: null, endTime: null },
  ]),
  updateAdObject: graph.update,
  getAdObject: graph.read,
}));

import { disconnectDatabases, getPrisma } from '@/lib/db/prisma';
import { withTenant } from '@/lib/db/tenant';
import { MetaApiError } from '@/lib/whatsapp/meta-api';
import { finishConnection, MetaAdsError, startConnection, type MetaAdsActor } from './connection';
import {
  dismissAdChange, getAdManageView, handleAdChangeJob, handleAdObjectsSyncJob, recheckAdChange, requestAdChange, setBudgetCap,
} from './manage';

const configured = config({ path: '.env.test', quiet: true }).parsed;
const ownerUrl = process.env.TEST_DATABASE_URL;
const appUrl = process.env.TEST_APP_DATABASE_URL || configured?.DATABASE_URL;
const workerUrl = process.env.TEST_WORKER_DATABASE_URL || configured?.WORKER_DATABASE_URL;
if (appUrl) process.env.DATABASE_URL = appUrl;
if (workerUrl) process.env.WORKER_DATABASE_URL = workerUrl;

const seed = String(Date.now()).slice(-9);
Object.assign(process.env, {
  IT_M_ACCOUNT: `71${seed}`, IT_M_PAGE: `72${seed}`, IT_M_CAMPAIGN: `73${seed}`, IT_M_ADSET: `74${seed}`, IT_M_AD: `75${seed}`,
});
const CAMPAIGN = `73${seed}`, ADSET = `74${seed}`, AD = `75${seed}`;
const accountA = randomUUID(), accountB = randomUUID();
const adminA = randomUUID(), viewerA = randomUUID(), adminB = randomUUID();
const asA: MetaAdsActor = { accountId: accountA, userId: adminA, role: 'admin' };
const viewer: MetaAdsActor = { accountId: accountA, userId: viewerA, role: 'viewer' };
const asB: MetaAdsActor = { accountId: accountB, userId: adminB, role: 'admin' };
const attempt = { attempts: 1, maxAttempts: 4 };
let owner: pg.Client;
const env: Record<string, string | undefined> = {};

const failure = async (promise: Promise<unknown>) => promise.then(() => 'resolved', (e) => (e instanceof MetaAdsError ? e.code : e));
const change = async (id: string) =>
  (await owner.query('SELECT status, last_error_code, resolved_by FROM meta_ad_changes WHERE id=$1', [id])).rows[0];
const cached = async (objectId: string) =>
  (await owner.query('SELECT status, daily_budget_minor::text AS daily, name FROM meta_ad_objects WHERE object_id=$1', [objectId])).rows[0];
const jobs = async (type: string) =>
  (await owner.query('SELECT payload, dedupe_key FROM jobs WHERE tenant_id=$1 AND type=$2', [accountA, type])).rows;
const intent = async (changeId: string) =>
  (await owner.query('SELECT status FROM outbound_intents WHERE idempotency_key=$1', [`${accountA}:adchange:${changeId}`])).rows[0]?.status;

describe.skipIf(!ownerUrl || !appUrl || !workerUrl)('Ad management on PostgreSQL', { timeout: 120_000 }, () => {
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
    await owner.query("INSERT INTO auth_users(id,email,full_name,password_hash) SELECT x, x::text || '@example.invalid', 'Ad manage test', 'test-only-hash' FROM unnest($1::uuid[]) x", [[adminA, viewerA, adminB]]);
    await owner.query("INSERT INTO accounts(id,name,owner_user_id) VALUES($1,'Manage A',$2),($3,'Manage B',$4)", [accountA, adminA, accountB, adminB]);
    await owner.query("INSERT INTO account_memberships(account_id,user_id,role) VALUES($1,$2,'admin'),($1,$3,'viewer'),($4,$5,'admin')", [accountA, adminA, viewerA, accountB, adminB]);
    await startConnection(asA, 'm1');
    await finishConnection(asA, { adAccountId: `71${seed}`, pageId: `72${seed}` });
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

  it('syncs the tree for its own workspace only; members read it and cannot write it', async () => {
    await handleAdObjectsSyncJob(accountA);
    const view = await getAdManageView(viewer);
    expect(view.objects.map((o) => [o.level, o.id])).toEqual([['campaign', CAMPAIGN], ['adset', ADSET], ['ad', AD]]);
    expect(view.currency).toBe('INR');
    expect(view.manageEnabled).toBe(true);
    expect(view.missingScopes).toEqual([]);
    expect((await getAdManageView({ ...asB, role: 'viewer' })).objects).toEqual([]);
    const app = { accountId: accountA, userId: adminA, role: 'admin' as const };
    await expect(withTenant(app, (tx) => tx.$executeRawUnsafe(
      `INSERT INTO meta_ad_changes(account_id, connection_id, level, object_id, field, to_value, requested_by)
       SELECT account_id, id, 'campaign', '1', 'status', 'PAUSED', '${adminA}' FROM meta_ad_connections LIMIT 1`))).rejects.toThrow();
    await expect(withTenant(app, (tx) => tx.$executeRawUnsafe('DELETE FROM meta_ad_objects'))).rejects.toThrow();
  });

  it('records a change with its job, refuses a second open one, and enforces roles and the cap', async () => {
    expect(await failure(setBudgetCap(viewer, 60000))).toBe('forbidden');
    expect(await setBudgetCap(asA, 60000)).toBe(60000);
    expect(await failure(requestAdChange(viewer, { objectId: CAMPAIGN, field: 'status', value: 'PAUSED' }))).toBe('forbidden');
    expect(await failure(requestAdChange(asA, { objectId: CAMPAIGN, field: 'daily_budget', value: '60001' }))).toBe('over_budget_cap');
    expect(await failure(requestAdChange(asA, { objectId: ADSET, field: 'daily_budget', value: '100' }))).toBe('invalid_request');
    expect(await failure(requestAdChange(asA, { objectId: '999', field: 'status', value: 'PAUSED' }))).toBe('not_found');
    expect(await failure(requestAdChange(asB, { objectId: CAMPAIGN, field: 'status', value: 'PAUSED' }))).toBe('not_connected');

    const queued = await requestAdChange(asA, { objectId: CAMPAIGN, field: 'daily_budget', value: '55000' });
    expect(queued).toMatchObject({ status: 'queued', fromValue: '50000', toValue: '55000' });
    expect((await jobs('meta.ad_change')).map((j) => j.payload)).toEqual([{ changeId: queued.id }]);
    expect(await failure(requestAdChange(asA, { objectId: CAMPAIGN, field: 'daily_budget', value: '56000' }))).toBe('change_pending');
    const audit = await owner.query("SELECT user_id::text AS user_id FROM audit_logs WHERE account_id=$1 AND action='meta_ads.change_request'", [accountA]);
    expect(audit.rows).toEqual([{ user_id: adminA }]);

    // Applied once through an outbound intent; the cache shows it and a refresh is queued.
    await handleAdChangeJob(accountA, { changeId: queued.id }, attempt);
    expect(graph.update).toHaveBeenCalledTimes(1);
    expect(graph.update).toHaveBeenLastCalledWith(CAMPAIGN, 'user-token-m1', { daily_budget: '55000' });
    expect(await change(queued.id)).toMatchObject({ status: 'applied' });
    expect(await intent(queued.id)).toBe('accepted');
    expect((await cached(CAMPAIGN)).daily).toBe('55000');
    expect((await jobs('meta.ad_objects_sync')).some((j) => j.dedupe_key === `meta-ad-objects-change:${queued.id}`)).toBe(true);
    // A re-run of the same job sends nothing.
    await handleAdChangeJob(accountA, { changeId: queued.id }, { attempts: 2, maxAttempts: 4 });
    expect(graph.update).toHaveBeenCalledTimes(1);
  });

  it('refuses a resume whose campaign budget is above the cap', async () => {
    await setBudgetCap(asA, 40000);
    expect(await failure(requestAdChange(asA, { objectId: ADSET, field: 'status', value: 'ACTIVE' }))).toBe('over_budget_cap');
    await setBudgetCap(asA, null);
  });

  it('settles an unclear send by reading the object back, never by sending again', async () => {
    // The network fails after the claim: Meta did apply it.
    graph.update.mockRejectedValueOnce(new TypeError('fetch failed'));
    graph.read.mockResolvedValueOnce({ level: 'ad', id: AD, status: 'PAUSED' });
    const paused = await requestAdChange(asA, { objectId: AD, field: 'status', value: 'PAUSED' });
    await handleAdChangeJob(accountA, { changeId: paused.id }, attempt);
    expect(await change(paused.id)).toMatchObject({ status: 'applied' });

    // Unclear and Meta does not show it: 'unknown' until an admin re-checks.
    graph.update.mockRejectedValueOnce(new TypeError('fetch failed'));
    graph.read.mockResolvedValueOnce({ level: 'campaign', id: CAMPAIGN, name: 'Diwali' });
    const renamed = await requestAdChange(asA, { objectId: CAMPAIGN, field: 'name', value: 'Diwali 2026' });
    await handleAdChangeJob(accountA, { changeId: renamed.id }, attempt);
    // The one send that may have reached Meta; nothing below may send again.
    const sends = graph.update.mock.calls.length;
    expect(await change(renamed.id)).toMatchObject({ status: 'unknown' });
    expect(await intent(renamed.id)).toBe('unknown');
    // A retried job leaves an unknown change alone; the open change blocks a new one on the same field.
    await handleAdChangeJob(accountA, { changeId: renamed.id }, { attempts: 2, maxAttempts: 4 });
    expect(graph.update.mock.calls.length).toBe(sends);
    expect(await failure(requestAdChange(asA, { objectId: CAMPAIGN, field: 'name', value: 'Other' }))).toBe('change_pending');

    expect(await failure(recheckAdChange(viewer, renamed.id))).toBe('forbidden');
    expect(await failure(dismissAdChange(asB, renamed.id))).toBe('not_found');
    expect(await failure(recheckAdChange(asB, renamed.id))).toBe('not_found');
    graph.read.mockResolvedValueOnce({ level: 'campaign', id: CAMPAIGN, name: 'Diwali 2026' });
    expect(await recheckAdChange(asA, renamed.id)).toMatchObject({ status: 'applied' });
    expect(await change(renamed.id)).toMatchObject({ status: 'applied', resolved_by: adminA });
    expect((await cached(CAMPAIGN)).name).toBe('Diwali 2026');
    expect(graph.update.mock.calls.length).toBe(sends);
  });

  it('lets an admin dismiss an unclear change, and records a rejection as failed', async () => {
    graph.update.mockRejectedValueOnce(new TypeError('fetch failed'));
    graph.read.mockResolvedValueOnce(null);
    const unclear = await requestAdChange(asA, { objectId: ADSET, field: 'end_time', value: new Date(Date.now() + 30 * 86_400_000).toISOString() });
    await handleAdChangeJob(accountA, { changeId: unclear.id }, attempt);
    expect(await change(unclear.id)).toMatchObject({ status: 'unknown' });
    expect(await dismissAdChange(asA, unclear.id)).toMatchObject({ status: 'dismissed' });
    expect(await failure(dismissAdChange(asA, unclear.id))).toBe('invalid_request');

    graph.update.mockRejectedValueOnce(new MetaApiError('Meta API error: 400', { code: 100, subcode: 1885272, type: null, fbtraceId: null, httpStatus: 400 }));
    const rejected = await requestAdChange(asA, { objectId: CAMPAIGN, field: 'daily_budget', value: '100' });
    await handleAdChangeJob(accountA, { changeId: rejected.id }, attempt);
    expect(await change(rejected.id)).toMatchObject({ status: 'failed', last_error_code: '100:1885272' });

    const view = await getAdManageView(viewer);
    expect(view.changes.map((c) => c.status)).toEqual(expect.arrayContaining(['applied', 'dismissed', 'failed']));
  });
});
