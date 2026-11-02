import { randomUUID } from 'node:crypto';
import { config } from 'dotenv';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { disconnectDatabases, getPrisma, getWorkerPrisma } from '@/lib/db/prisma';
import { withTenant } from '@/lib/db/tenant';
import { enqueueJob } from '@/lib/jobs/queue';
import { encrypt } from '@/lib/whatsapp/encryption';
import { MetaApiError } from './meta-api';
import { healthSyncDedupeKey, HEALTH_SYNC_JOB, syncNumberHealth, type FetchedHealth } from './health-sync';

const configured = config({ path: '.env.test', quiet: true }).parsed;
const ownerUrl = process.env.TEST_DATABASE_URL;
const appUrl = process.env.TEST_APP_DATABASE_URL || configured?.DATABASE_URL;
const workerUrl = process.env.TEST_WORKER_DATABASE_URL || configured?.WORKER_DATABASE_URL;
if (appUrl) process.env.DATABASE_URL = appUrl;
if (workerUrl) process.env.WORKER_DATABASE_URL = workerUrl;

const accountA = randomUUID(), accountB = randomUUID();
const ownerA = randomUUID(), adminA = randomUUID(), agentA = randomUUID(), ownerB = randomUUID();
const seed = String(Date.now()).slice(-9);
let owner: pg.Client;
let numberA = '', numberB = '';
const dedupeKeys: string[] = [];

const health = (s: Partial<FetchedHealth>): FetchedHealth => ({
  quality_rating: null, messaging_limit_tier: null, name_status: null, code_verification_status: null,
  display_phone_number: '+1 555 0100', ...s,
});
const fetcher = (s: Partial<FetchedHealth>) => async () => health(s);
const alerts = async (accountId: string) =>
  (await owner.query(
    `SELECT user_id,title,whatsapp_config_id,dedupe_key FROM notifications
     WHERE account_id=$1 AND type='whatsapp_number_health' ORDER BY created_at,user_id`,
    [accountId],
  )).rows as { user_id: string; title: string; whatsapp_config_id: string; dedupe_key: string }[];

describe.skipIf(!ownerUrl || !appUrl || !workerUrl)('WhatsApp number health sync on PostgreSQL', { timeout: 120_000 }, () => {
  beforeAll(async () => {
    owner = new pg.Client({ connectionString: ownerUrl });
    await owner.connect();
    if (!/test/i.test((await owner.query('SELECT current_database() AS name')).rows[0].name)) throw new Error('Requires an isolated test database');
    const app = await getPrisma().$queryRaw<{ name: string; role: string }[]>`SELECT current_database() AS name, current_user AS role`;
    if (!/test/i.test(app[0].name) || app[0].role !== 'bodhinox_app') throw new Error('Requires constrained test app credentials');
    await owner.query("INSERT INTO auth_users(id,email,full_name,password_hash) SELECT x, x::text || '@example.invalid', 'Health test', 'test-only-hash' FROM unnest($1::uuid[]) x", [[ownerA, adminA, agentA, ownerB]]);
    await owner.query("INSERT INTO accounts(id,name,owner_user_id) VALUES($1,'Health A',$2),($3,'Health B',$4)", [accountA, ownerA, accountB, ownerB]);
    await owner.query("INSERT INTO account_memberships(account_id,user_id,role) VALUES($1,$2,'owner'),($1,$3,'admin'),($1,$4,'agent'),($5,$6,'owner')", [accountA, ownerA, adminA, agentA, accountB, ownerB]);
    const insert = async (accountId: string, userId: string, phone: string) => (await owner.query(
      `INSERT INTO whatsapp_config(account_id,user_id,phone_number_id,access_token,status,display_name)
       VALUES($1,$2,$3,$4,'connected','Sales line') RETURNING id`, [accountId, userId, phone, encrypt('test-only-token')],
    )).rows[0].id as string;
    numberA = await insert(accountA, ownerA, `91${seed}`);
    numberB = await insert(accountB, ownerB, `92${seed}`);
  });
  afterAll(async () => {
    if (owner) {
      await owner.query('DELETE FROM jobs WHERE dedupe_key=ANY($1::text[])', [dedupeKeys]);
      await owner.query('DELETE FROM accounts WHERE id=ANY($1::uuid[])', [[accountA, accountB]]);
      await owner.query('DELETE FROM auth_users WHERE id=ANY($1::uuid[])', [[ownerA, adminA, agentA, ownerB]]);
      await owner.end();
    }
    await disconnectDatabases();
  });

  it('lists connected numbers for the worker, identifiers only', async () => {
    const rows = await getWorkerPrisma().$queryRaw<Record<string, string>[]>`SELECT * FROM crm_whatsapp_numbers_for_health_sync()`;
    expect(rows).toEqual(expect.arrayContaining([{ account_id: accountA, whatsapp_config_id: numberA }, { account_id: accountB, whatsapp_config_id: numberB }]));
    expect(Object.keys(rows[0]).sort()).toEqual(['account_id', 'whatsapp_config_id']);
    // The app role cannot call the cross-tenant projection.
    await expect(getPrisma().$queryRaw`SELECT * FROM crm_whatsapp_numbers_for_health_sync()`).rejects.toThrow();
  });

  it('deduplicates the scheduled job per number per window', async () => {
    const runAt = new Date(Date.now() + 365 * 86_400_000); // never claimed by other suites
    const key = healthSyncDedupeKey(numberA, Date.now());
    dedupeKeys.push(key);
    const first = await enqueueJob(HEALTH_SYNC_JOB, { configId: numberA }, { tenantId: accountA, dedupeKey: key, runAt });
    const again = await enqueueJob(HEALTH_SYNC_JOB, { configId: numberA }, { tenantId: accountA, dedupeKey: key, runAt });
    expect(again).toBe(first);
    expect((await owner.query('SELECT count(*)::int AS n FROM jobs WHERE dedupe_key=$1', [key])).rows[0].n).toBe(1);
  });

  it('stores health, alerts owners and admins once per change, and never twice', async () => {
    const first = await syncNumberHealth({ accountId: accountA, configId: numberA, fetchHealth: fetcher({ quality_rating: 'GREEN', messaging_limit_tier: 'TIER_1K', name_status: 'APPROVED', code_verification_status: 'VERIFIED' }) });
    expect(first).toMatchObject({ status: 'synced', changes: [], notified: 0 });
    const row = (await owner.query('SELECT quality_rating,messaging_limit_tier,name_status,code_verification_status,health_checked_at FROM whatsapp_config WHERE id=$1', [numberA])).rows[0];
    expect(row).toMatchObject({ quality_rating: 'GREEN', messaging_limit_tier: 'TIER_1K', name_status: 'APPROVED', code_verification_status: 'VERIFIED' });
    expect(row.health_checked_at).toBeInstanceOf(Date);

    const drop = await syncNumberHealth({ accountId: accountA, configId: numberA, fetchHealth: fetcher({ quality_rating: 'YELLOW', messaging_limit_tier: 'TIER_1K' }) });
    expect(drop).toMatchObject({ status: 'synced', notified: 2 });
    // Concurrent and repeated runs with the same answer add nothing.
    await Promise.all([1, 2, 3].map(() => syncNumberHealth({ accountId: accountA, configId: numberA, fetchHealth: fetcher({ quality_rating: 'YELLOW' }) })));
    const rows = await alerts(accountA);
    expect(rows.map((r) => r.user_id).sort()).toEqual([ownerA, adminA].sort());
    expect(rows.every((r) => r.title === 'WhatsApp number quality dropped' && r.whatsapp_config_id === numberA)).toBe(true);
    expect(await alerts(accountB)).toEqual([]);

    // A replayed insert of the same change is a no-op (unique dedupe index).
    const replay = await owner.query(
      `INSERT INTO notifications(account_id,user_id,type,title,dedupe_key) VALUES($1,$2,'whatsapp_number_health','x',$3) ON CONFLICT DO NOTHING`,
      [accountA, ownerA, rows[0].dedupe_key],
    );
    expect(replay.rowCount).toBe(0);
  });

  it('shows each alert only to its recipient', async () => {
    const seen = async (userId: string, role: 'owner' | 'admin' | 'agent') =>
      withTenant({ accountId: accountA, userId, role }, (tx) => tx.$queryRaw<{ user_id: string }[]>`
        SELECT user_id FROM notifications WHERE type='whatsapp_number_health'`);
    expect((await seen(adminA, 'admin')).map((r) => r.user_id)).toEqual([adminA]);
    expect(await seen(agentA, 'agent')).toEqual([]);
  });

  it('records a Meta failure without losing the last good health, then recovers', async () => {
    const failed = await syncNumberHealth({
      accountId: accountA, configId: numberA,
      fetchHealth: async () => { throw new MetaApiError('Invalid OAuth access token', { code: 190, httpStatus: 401 }); },
    });
    expect(failed).toEqual({ status: 'error', error: 'token' });
    let row = (await owner.query('SELECT quality_rating,health_error,health_error_at FROM whatsapp_config WHERE id=$1', [numberA])).rows[0];
    expect(row).toMatchObject({ quality_rating: 'YELLOW', health_error: 'token' });
    expect(row.health_error_at).toBeInstanceOf(Date);
    await syncNumberHealth({ accountId: accountA, configId: numberA, fetchHealth: fetcher({ quality_rating: 'YELLOW' }) });
    row = (await owner.query('SELECT health_error,health_error_at FROM whatsapp_config WHERE id=$1', [numberA])).rows[0];
    expect(row).toEqual({ health_error: null, health_error_at: null });
  });

  it('lets an admin sync on demand under tenant RLS, but not an agent or another workspace', async () => {
    const asAdmin = { accountId: accountA, userId: adminA, role: 'admin' as const };
    const result = await syncNumberHealth({ accountId: accountA, configId: numberA, tenant: asAdmin, db: getPrisma(), fetchHealth: fetcher({ quality_rating: 'YELLOW', name_status: 'DECLINED' }) });
    expect(result).toMatchObject({ status: 'synced', notified: 2 });
    expect((await alerts(accountA)).filter((r) => r.title === 'WhatsApp display name rejected')).toHaveLength(2);
    // An agent can read the row, but RLS hides it from the locking write, so nothing changes.
    expect(await syncNumberHealth({
      accountId: accountA, configId: numberA, tenant: { accountId: accountA, userId: agentA, role: 'agent' }, db: getPrisma(),
      fetchHealth: fetcher({ quality_rating: 'RED' }),
    })).toEqual({ status: 'not_found' });
    expect((await owner.query('SELECT quality_rating FROM whatsapp_config WHERE id=$1', [numberA])).rows[0].quality_rating).toBe('YELLOW');
    // Workspace B cannot see A's number at all.
    expect(await syncNumberHealth({ accountId: accountB, configId: numberA, tenant: { accountId: accountB, userId: ownerB, role: 'owner' }, db: getPrisma(), fetchHealth: fetcher({}) }))
      .toEqual({ status: 'not_found' });
  });

  it('keeps the alert when its number is deleted', async () => {
    await owner.query('DELETE FROM whatsapp_config WHERE id=$1', [numberA]);
    const rows = await alerts(accountA);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.whatsapp_config_id === null)).toBe(true);
  });
});
