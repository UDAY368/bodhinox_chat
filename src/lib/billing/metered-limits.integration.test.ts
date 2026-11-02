import { randomUUID } from 'node:crypto';
import { config } from 'dotenv';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { disconnectDatabases, getPrisma, getWorkerPrisma } from '@/lib/db/prisma';
import { withTenant, type TenantContext } from '@/lib/db/tenant';
import { PlanLimitError, requireWhatsAppNumberRoom } from './entitlements';
import { requireStorageRoom, storageBytesUsed } from './limits';
import type { BillingProvider, BillingSubscription, ProviderResult } from './provider';
import { runLifecycleSweep } from './subscriptions';
import { currentUsage } from './usage';

const configured = config({ path: '.env.test', quiet: true }).parsed;
const ownerUrl = process.env.TEST_DATABASE_URL;
const appUrl = process.env.TEST_APP_DATABASE_URL || configured?.DATABASE_URL;
const workerUrl = process.env.TEST_WORKER_DATABASE_URL || configured?.WORKER_DATABASE_URL;
if (appUrl) process.env.DATABASE_URL = appUrl;
if (workerUrl) process.env.WORKER_DATABASE_URL = workerUrl;

const accountA = randomUUID(), accountB = randomUUID();
const adminA = randomUUID(), agentA = randomUUID(), ownerB = randomUUID();
const tiny = `tiny_${randomUUID().slice(0, 8)}`;
const tag = randomUUID().slice(0, 8);
const digits = String(Math.floor(Math.random() * 1e9));
const admin: TenantContext = { accountId: accountA, userId: adminA, role: 'admin' };
const agent: TenantContext = { accountId: accountA, userId: agentA, role: 'agent' };
let owner: pg.Client;

describe.skipIf(!ownerUrl || !appUrl || !workerUrl)('metered limits on PostgreSQL', { timeout: 120_000 }, () => {
  beforeAll(async () => {
    owner = new pg.Client({ connectionString: ownerUrl });
    await owner.connect();
    if (!/test/i.test((await owner.query('SELECT current_database() AS name')).rows[0].name)) throw new Error('Requires an isolated test database');
    const app = await getPrisma().$queryRaw<{ role: string }[]>`SELECT current_user AS role`;
    if (app[0].role !== 'bodhinox_app') throw new Error('Requires constrained test app credentials');
    await owner.query("INSERT INTO auth_users(id,email,full_name,password_hash) SELECT x, x::text || '@example.invalid', 'Metered test', 'test-only-hash' FROM unnest($1::uuid[]) x", [[adminA, agentA, ownerB]]);
    await owner.query("INSERT INTO accounts(id,name,owner_user_id) VALUES($1,'Metered A',$2),($3,'Metered B',$4)", [accountA, adminA, accountB, ownerB]);
    await owner.query("INSERT INTO account_memberships(account_id,user_id,role) VALUES($1,$2,'admin'),($1,$3,'agent'),($4,$5,'owner')", [accountA, adminA, agentA, accountB, ownerB]);
    await owner.query(`INSERT INTO plans(id,name,features,limits) VALUES($1,'Tiny','{}','{"storage_bytes":1000,"whatsapp_numbers":1}')`, [tiny]);
    await owner.query("INSERT INTO account_subscriptions(account_id,plan_id,status) VALUES($1,$2,'active')", [accountA, tiny]);
  });

  afterAll(async () => {
    if (owner) {
      await owner.query("DELETE FROM jobs WHERE type IN ('billing.email','billing.lifecycle_sweep') AND tenant_id = ANY($1::uuid[])", [[accountA, accountB]]);
      await owner.query('DELETE FROM accounts WHERE id = ANY($1::uuid[])', [[accountA, accountB]]);
      await owner.query('DELETE FROM auth_users WHERE id = ANY($1::uuid[])', [[adminA, agentA, ownerB]]);
      await owner.query('DELETE FROM plans WHERE id=$1', [tiny]);
      await owner.end();
    }
    await disconnectDatabases();
  });

  it('seeds the new limits unlimited on every plan until real values are set', async () => {
    const { rows } = await owner.query(`SELECT id, limits->'ai_messages' AS ai, limits->'monthly_active_contacts' AS mac,
      limits->'storage_bytes' AS storage, limits->'whatsapp_numbers' AS numbers FROM plans WHERE id IN ('free','basic','pro') ORDER BY id`);
    expect(rows).toEqual(['basic', 'free', 'pro'].map((id) => ({ id, ai: null, mac: null, storage: null, numbers: null })));
  });

  it('counts only member uploads against storage, so inbound customer media never blocks an agent upload', async () => {
    // Inbound customer media alone is far over the 1000-byte cap.
    await owner.query(`INSERT INTO media_objects(account_id,uploaded_by,bucket,object_key,content_type,byte_size) VALUES
      ($1,$2,'chat-media',$3,'image/png',50000),($1,NULL,'chat-media',$4,'image/png',300),($1,$5,'chat-media',$6,'image/png',600)`,
    [accountA, adminA, `account-${accountA}/inbound/a.png`, `account-${accountA}/x.png`, agentA, `account-${accountA}/library/b.png`]);
    expect(await withTenant(agent, (tx) => storageBytesUsed(tx, accountA))).toBe(900);
    expect((await withTenant(agent, (tx) => currentUsage(tx, accountA))).storage_bytes).toBe(900);
    await withTenant(agent, (tx) => requireStorageRoom(tx, accountA, 100));
    await expect(withTenant(agent, (tx) => requireStorageRoom(tx, accountA, 101))).rejects.toBeInstanceOf(PlanLimitError);
  });

  it('limits additional WhatsApp numbers; numbers mid-setup count, removed ones free their slot', async () => {
    const add = (phone: string, status: string, token: string) =>
      owner.query('INSERT INTO whatsapp_config(account_id,user_id,phone_number_id,access_token,status) VALUES($1,$2,$3,$4,$5) RETURNING id',
        [accountA, adminA, `${phone}${digits}`, token, status]).then((r) => r.rows[0].id as string);
    await withTenant(admin, (tx) => requireWhatsAppNumberRoom(tx, accountA));
    const first = await add('7101', 'connected', 'enc');
    await expect(withTenant(admin, (tx) => requireWhatsAppNumberRoom(tx, accountA))).rejects.toThrow(/up to 1 WhatsApp numbers/);
    expect((await withTenant(agent, (tx) => currentUsage(tx, accountA))).whatsapp_numbers).toBe(1);
    // An admin removed it (disconnected, token cleared): the slot is free again.
    await owner.query("UPDATE whatsapp_config SET status='disconnected', access_token='' WHERE id=$1", [first]);
    await withTenant(admin, (tx) => requireWhatsAppNumberRoom(tx, accountA));
    // A number mid-setup (token stored, not yet connected) holds the slot.
    await add('7102', 'disconnected', 'enc');
    await expect(withTenant(admin, (tx) => requireWhatsAppNumberRoom(tx, accountA))).rejects.toBeInstanceOf(PlanLimitError);
    // A workspace without a subscription stays unlimited.
    await withTenant({ accountId: accountB, userId: ownerB, role: 'owner' }, (tx) => requireWhatsAppNumberRoom(tx, accountB));
  });

  it('sweeps an active subscription whose period lapsed without a renewal, and reconciles it from the provider', async () => {
    const subId = `sub_M${tag}`;
    await owner.query(`INSERT INTO account_subscriptions(account_id,plan_id,status,provider,provider_subscription_id,current_period_start,current_period_end)
      VALUES($1,'basic','active','razorpay',$2,now() - interval '32 days',now() - interval '2 days')`, [accountB, subId]);
    const swept = async () => (await getWorkerPrisma().$queryRaw<{ account_id: string }[]>`SELECT account_id FROM crm_accounts_for_billing_sweep()`).map((r) => r.account_id);
    expect(await swept()).toContain(accountB);
    // Still inside the renewal allowance: not swept yet.
    await owner.query("UPDATE account_subscriptions SET current_period_end = now() - interval '1 hour' WHERE account_id=$1", [accountB]);
    expect(await swept()).not.toContain(accountB);
    await owner.query("UPDATE account_subscriptions SET current_period_end = now() - interval '2 days' WHERE account_id=$1", [accountB]);

    // The subscription.cancelled webhook never arrived; the provider reports it ended.
    const ended: BillingSubscription = { id: subId, planId: 'plan_unmapped', customerId: null, state: 'cancelled', status: 'cancelled',
      currentStart: null, currentEnd: null, startAt: null, endedAt: new Date(), shortUrl: null, hasScheduledChanges: false, notes: {} };
    const fetched: string[] = [];
    const provider = {
      name: 'razorpay',
      async fetchSubscription(id: string): Promise<ProviderResult<BillingSubscription>> { fetched.push(id); return { outcome: 'ok', value: ended }; },
      async findSubscription() { return { outcome: 'ok', value: null }; },
    } as unknown as BillingProvider;
    await runLifecycleSweep(accountB, provider);
    expect(fetched).toEqual([subId]);
    expect((await owner.query('SELECT status FROM account_subscriptions WHERE account_id=$1', [accountB])).rows[0].status).toBe('cancelled');
    expect(await swept()).not.toContain(accountB);
  });
});
