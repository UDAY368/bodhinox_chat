import { randomUUID } from 'node:crypto';
import { config } from 'dotenv';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { disconnectDatabases, getPrisma, getWorkerPrisma } from '@/lib/db/prisma';
import type { TenantContext } from '@/lib/db/tenant';

// The whatsapp_numbers limit on PostgreSQL: removing a number frees its slot,
// so reviving it (settings form or Embedded Signup) must fit the plan again,
// and two concurrent adds cannot both pass. Meta and the session are mocked.
const h = vi.hoisted(() => ({ ctx: null as unknown }));
vi.mock('@/lib/auth/account', async (orig) => ({
  ...(await orig<typeof import('@/lib/auth/account')>()),
  requireRole: async () => h.ctx,
}));
vi.mock('@/lib/whatsapp/meta-api', async (orig) => ({
  MetaApiError: (await orig<typeof import('./meta-api')>()).MetaApiError,
  exchangeEmbeddedSignupCode: async () => ({ accessToken: 'test-only-token' }),
  verifyPhoneNumber: async ({ phoneNumberId }: { phoneNumberId: string }) => ({ id: phoneNumberId, display_phone_number: '+1', verified_name: 'Biz' }),
  listWabaPhoneNumbers: async () => [{ id: phoneA }, { id: phoneB }, { id: phoneC }],
  subscribeWabaToApp: async () => undefined,
  registerPhoneNumber: async () => ({ success: true, alreadyRegistered: true }),
  getSubscribedApps: async () => [],
  setBusinessEncryptionKey: async () => undefined,
}));

import { createScopedClient } from '@/lib/data/server';
import { POST } from '@/app/api/whatsapp/config/route';
import { connectEmbeddedSignup } from './embedded-signup-connect';
import { PlanLimitError } from '@/lib/billing/entitlements';

const configured = config({ path: '.env.test', quiet: true }).parsed;
const ownerUrl = process.env.TEST_DATABASE_URL;
const appUrl = process.env.TEST_APP_DATABASE_URL || configured?.DATABASE_URL;
const workerUrl = process.env.TEST_WORKER_DATABASE_URL || configured?.WORKER_DATABASE_URL;
if (appUrl) process.env.DATABASE_URL = appUrl;
if (workerUrl) process.env.WORKER_DATABASE_URL = workerUrl;

const account = randomUUID(), admin = randomUUID();
const tenant = { accountId: account, userId: admin, role: 'admin' } satisfies TenantContext;
const plan = `one_${randomUUID().slice(0, 8)}`;
const seed = String(Date.now()).slice(-9);
const phoneA = `71${seed}`, phoneB = `72${seed}`, phoneC = `73${seed}`, waba = `98${seed}`;
let owner: pg.Client;

const save = (phone: string) =>
  POST(new Request('http://localhost/api/whatsapp/config', {
    method: 'POST',
    body: JSON.stringify({ phone_number_id: phone, waba_id: waba, access_token: 'test-only-token' }),
  }));
const live = async () =>
  (await owner.query("SELECT phone_number_id FROM whatsapp_config WHERE account_id=$1 AND NOT (status='disconnected' AND access_token='') ORDER BY phone_number_id", [account])).rows.map((r) => r.phone_number_id);
const remove = (phone: string) =>
  owner.query("UPDATE whatsapp_config SET status='disconnected', access_token='', is_default=false WHERE account_id=$1 AND phone_number_id=$2", [account, phone]);

describe.skipIf(!ownerUrl || !appUrl || !workerUrl)('WhatsApp number limit on revive (PostgreSQL)', { timeout: 120_000 }, () => {
  beforeAll(async () => {
    owner = new pg.Client({ connectionString: ownerUrl });
    await owner.connect();
    if (!/test/i.test((await owner.query('SELECT current_database() AS name')).rows[0].name)) throw new Error('Requires an isolated test database');
    const app = await getPrisma().$queryRaw<{ role: string }[]>`SELECT current_user AS role`;
    if (app[0].role !== 'bodhinox_app') throw new Error('Requires constrained test app credentials');
    await getWorkerPrisma().$queryRaw`SELECT 1`;
    await owner.query("INSERT INTO auth_users(id,email,full_name,password_hash) VALUES($1::uuid, $2, 'Limit test', 'test-only-hash')", [admin, `${admin}@example.invalid`]);
    await owner.query("INSERT INTO accounts(id,name,owner_user_id) VALUES($1,'Limit A',$2)", [account, admin]);
    await owner.query("INSERT INTO account_memberships(account_id,user_id,role) VALUES($1,$2,'admin')", [account, admin]);
    await owner.query(`INSERT INTO plans(id,name,features,limits) VALUES($1,'One','{}','{"whatsapp_numbers":1}')`, [plan]);
    await owner.query("INSERT INTO account_subscriptions(account_id,plan_id,status) VALUES($1,$2,'active')", [account, plan]);
    h.ctx = { ...tenant, db: createScopedClient(tenant), account: { id: account, name: 'Limit A' } };
  });
  afterAll(async () => {
    if (owner) {
      await owner.query('DELETE FROM accounts WHERE id=$1', [account]);
      await owner.query('DELETE FROM auth_users WHERE id=$1', [admin]);
      await owner.query('DELETE FROM plans WHERE id=$1', [plan]);
      await owner.end();
    }
    await disconnectDatabases();
  });
  beforeEach(async () => {
    process.env.NEXT_PUBLIC_META_APP_ID = '1234';
    process.env.NEXT_PUBLIC_META_EMBEDDED_SIGNUP_CONFIG_ID = '5678';
    process.env.META_APP_SECRET = 'test-only-secret';
    await owner.query('DELETE FROM whatsapp_config WHERE account_id=$1', [account]);
  });

  it('settings form: connect A, remove A, connect B, then reviving A is refused (402) and A stays removed', async () => {
    expect((await save(phoneA)).status).toBe(200);
    await remove(phoneA);
    expect((await save(phoneB)).status).toBe(200);
    const revived = await save(phoneA);
    expect(revived.status).toBe(402);
    expect(await live()).toEqual([phoneB]);
    // Re-saving the number that holds the slot is never limited.
    expect((await save(phoneB)).status).toBe(200);
    // Once B is removed, A fits again and is revived in place.
    await remove(phoneB);
    expect(await (await save(phoneA)).json()).toMatchObject({ success: true, reconnected: true, created: false });
    expect(await live()).toEqual([phoneA]);
  });

  it('Embedded Signup: reviving a removed number over the plan is refused and its token stays cleared', async () => {
    expect(await connectEmbeddedSignup(tenant, { code: 'c1', waba_id: waba, phone_number_id: phoneA })).toMatchObject({ ok: true });
    await remove(phoneA);
    expect(await connectEmbeddedSignup(tenant, { code: 'c2', waba_id: waba, phone_number_id: phoneB })).toMatchObject({ ok: true, created: true });
    await expect(connectEmbeddedSignup(tenant, { code: 'c3', waba_id: waba, phone_number_id: phoneA })).rejects.toBeInstanceOf(PlanLimitError);
    expect(await live()).toEqual([phoneB]);
    const row = (await owner.query('SELECT access_token, status FROM whatsapp_config WHERE account_id=$1 AND phone_number_id=$2', [account, phoneA])).rows[0];
    expect(row).toEqual({ access_token: '', status: 'disconnected' });
  });

  it('two concurrent adds of different numbers on a 1-number plan: exactly one is saved', async () => {
    const statuses = (await Promise.all([save(phoneB), save(phoneC)])).map((r) => r.status).sort();
    expect(statuses).toEqual([200, 402]);
    expect(await live()).toHaveLength(1);
  });
});
