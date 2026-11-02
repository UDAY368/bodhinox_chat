import { createHmac, randomUUID } from 'node:crypto';
import { config } from 'dotenv';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { disconnectDatabases, getPrisma, getWorkerPrisma } from '@/lib/db/prisma';
import { handleCommerceEventJob } from '@/lib/commerce/event-rules';
import { engineSendTemplate } from '@/lib/automations/meta-send';
import { withTenant, type TenantContext } from '@/lib/db/tenant';
import { createWooStore, deleteWooStore, listWooStores, resolveWooStore, stopWooStore, updateWooStoreConsentKey } from './stores';
import { processWooWebhook } from './process';

const outbound = vi.hoisted(() => ({ dispatch: vi.fn(async () => {}) }));
vi.mock('@/lib/webhooks/deliver', () => ({ dispatchWebhookEvent: outbound.dispatch }));
vi.mock('@/lib/automations/meta-send', () => ({ engineSendTemplate: vi.fn() }));

const configured = config({ path: '.env.test', quiet: true }).parsed;
const ownerUrl = process.env.TEST_DATABASE_URL;
const appUrl = process.env.TEST_APP_DATABASE_URL || configured?.DATABASE_URL;
const workerUrl = process.env.TEST_WORKER_DATABASE_URL || configured?.WORKER_DATABASE_URL;
if (appUrl) process.env.DATABASE_URL = appUrl;
if (workerUrl) process.env.WORKER_DATABASE_URL = workerUrl;

const accountA = randomUUID(), accountB = randomUUID();
const adminA = randomUUID(), agentA = randomUUID(), viewerA = randomUUID(), ownerB = randomUUID();
const asAdminA: TenantContext = { accountId: accountA, userId: adminA, role: 'admin' };
const asAgentA: TenantContext = { accountId: accountA, userId: agentA, role: 'agent' };
const asViewerA: TenantContext = { accountId: accountA, userId: viewerA, role: 'viewer' };
const asB: TenantContext = { accountId: accountB, userId: ownerB, role: 'owner' };
const seed = String(Date.now()).slice(-8);
let owner: pg.Client;
let storeId = '';
let secret = '';

const order = (over: Record<string, unknown> = {}) => JSON.stringify({
  id: 5001, number: '5001', status: 'processing', currency: 'INR', total: '250.00', date_paid_gmt: '2026-11-02T10:00:00',
  billing: { first_name: 'Ravi', last_name: 'K', phone: `98${seed}`, country: 'IN', email: 'ravi@example.com' },
  line_items: [{ quantity: 2 }], meta_data: [],
  ...over,
});
const deliver = (raw: string, topic: string, deliveryId: string, key = secret, store = storeId) => {
  const headers = new Headers({
    'x-wc-webhook-topic': topic,
    'x-wc-webhook-delivery-id': deliveryId,
    'x-wc-webhook-signature': createHmac('sha256', key).update(raw).digest('base64'),
  });
  return processWooWebhook({ storeId: store, rawBody: raw, headers });
};
const events = async () => (await owner.query(
  "SELECT event,status,reason,dedupe_key FROM commerce_events WHERE account_id=$1 AND source='woocommerce' ORDER BY created_at,event", [accountA])).rows;

describe.skipIf(!ownerUrl || !appUrl || !workerUrl)('WooCommerce stores and webhooks on PostgreSQL', { timeout: 120_000 }, () => {
  beforeAll(async () => {
    owner = new pg.Client({ connectionString: ownerUrl });
    await owner.connect();
    if (!/test/i.test((await owner.query('SELECT current_database() AS name')).rows[0].name)) throw new Error('Requires an isolated test database');
    const app = await getPrisma().$queryRaw<{ role: string }[]>`SELECT current_user AS role`;
    if (app[0].role !== 'bodhinox_app') throw new Error('Requires constrained test app credentials');
    await owner.query("INSERT INTO auth_users(id,email,full_name,password_hash) SELECT x, x::text || '@example.invalid', 'Woo test', 'test-only-hash' FROM unnest($1::uuid[]) x", [[adminA, agentA, viewerA, ownerB]]);
    await owner.query("INSERT INTO accounts(id,name,owner_user_id) VALUES($1,'Woo A',$2),($3,'Woo B',$4)", [accountA, adminA, accountB, ownerB]);
    await owner.query("INSERT INTO account_memberships(account_id,user_id,role) VALUES($1,$2,'admin'),($1,$3,'agent'),($1,$4,'viewer'),($5,$6,'owner')", [accountA, adminA, agentA, viewerA, accountB, ownerB]);
    await owner.query(`INSERT INTO message_templates(account_id,user_id,name,body_text,status,category,language) VALUES
      ($1,$2,'woo_update','Order {{1}}: {{2}}','APPROVED','Utility','en'),
      ($1,$2,'woo_promo','Thanks! Here is 10% off','APPROVED','Marketing','en')`, [accountA, adminA]);
    await owner.query(`INSERT INTO commerce_event_rules(account_id,source,event,enabled,template_name,template_language,variable_map) VALUES
      ($1,'woocommerce','order_created',true,'woo_update','en','{"1":"order_number","2":"total"}'),
      ($1,'woocommerce','order_paid',true,'woo_promo','en','{}')`, [accountA]);
  });
  afterAll(async () => {
    if (owner) {
      await owner.query('DELETE FROM jobs WHERE tenant_id=ANY($1::uuid[])', [[accountA, accountB]]);
      if (storeId) await owner.query('DELETE FROM webhook_receipts WHERE dedupe_key LIKE $1', [`woocommerce:${storeId}:%`]);
      await owner.query('DELETE FROM accounts WHERE id=ANY($1::uuid[])', [[accountA, accountB]]);
      await owner.query('DELETE FROM auth_users WHERE id=ANY($1::uuid[])', [[adminA, agentA, viewerA, ownerB]]);
      await owner.end();
    }
    await disconnectDatabases();
  });

  it('lets only admins connect a store and never lets the app role read the secret', async () => {
    await expect(withTenant(asAgentA, (tx) => createWooStore(tx, accountA, { storeUrl: 'https://agent.example.com' }))).rejects.toThrow();
    await expect(withTenant(asViewerA, (tx) => createWooStore(tx, accountA, { storeUrl: 'https://viewer.example.com' }))).rejects.toThrow();
    const created = await withTenant(asAdminA, (tx) => createWooStore(tx, accountA, { storeUrl: `https://shop${seed}.example.com/` }));
    storeId = created.store.id;
    secret = created.webhookSecret;
    expect(created.store.store_url).toBe(`https://shop${seed}.example.com`);
    const stored = (await owner.query('SELECT webhook_secret_enc FROM woocommerce_stores WHERE id=$1', [storeId])).rows[0].webhook_secret_enc;
    expect(stored).not.toContain(secret);
    await expect(withTenant(asAdminA, (tx) => tx.$queryRaw`SELECT webhook_secret_enc FROM woocommerce_stores`)).rejects.toThrow();
    await expect(withTenant(asAdminA, (tx) => createWooStore(tx, accountA, { storeUrl: `https://shop${seed}.example.com` }))).rejects.toThrow('store_exists');
    expect(await withTenant(asAgentA, (tx) => listWooStores(tx, accountA))).toHaveLength(1);
  });

  it('isolates tenants', async () => {
    expect(await withTenant(asB, (tx) => listWooStores(tx, accountB))).toEqual([]);
    expect(await withTenant(asB, (tx) => tx.$queryRaw<unknown[]>`SELECT id FROM woocommerce_stores WHERE id=${storeId}::uuid`)).toEqual([]);
    expect(await withTenant(asB, (tx) => deleteWooStore(tx, accountB, storeId))).toBe(false);
    expect(await withTenant(asB, (tx) => updateWooStoreConsentKey(tx, accountB, storeId, 'x'))).toBeNull();
  });

  it('resolves the store for the public webhook only by id', async () => {
    const resolved = await resolveWooStore(storeId);
    expect(resolved).toMatchObject({ accountId: accountA, storeId, secret, consentMetaKey: null });
    expect(await resolveWooStore(randomUUID())).toBeNull();
    expect(await resolveWooStore('not-a-uuid')).toBeNull();
  });

  it('refuses a bad signature without recording anything', async () => {
    const res = await deliver(order(), 'order.created', `bad-${seed}`, 'wrong-secret');
    expect(res.status).toBe(401);
    expect(await events()).toEqual([]);
  });

  it('records a signed delivery durably, applies consent, and ignores redeliveries', async () => {
    const raw = order();
    const first = await deliver(raw, 'order.created', `d1-${seed}`);
    expect(first).toEqual({ status: 200, body: { status: 'received', events: 2 } });
    const rows = await events();
    expect(rows.map((r) => [r.event, r.status, r.reason])).toEqual([
      ['order_created', 'scheduled', null],
      // Marketing template to a contact this order created, without store consent.
      ['order_paid', 'skipped', 'no_marketing_consent'],
    ]);
    const jobs = (await owner.query("SELECT count(*)::int AS n FROM jobs WHERE tenant_id=$1 AND type='commerce.event_send'", [accountA])).rows[0].n;
    expect(jobs).toBe(1);
    const receipt = (await owner.query('SELECT status FROM webhook_receipts WHERE dedupe_key=$1', [`woocommerce:${storeId}:d1-${seed}`])).rows[0];
    expect(receipt.status).toBe('processed');
    expect(outbound.dispatch.mock.calls.map((c) => (c as unknown[])[2])).toEqual(['order.created', 'order.paid']);

    // Same delivery again: duplicate receipt, nothing new.
    expect((await deliver(raw, 'order.created', `d1-${seed}`)).body).toEqual({ status: 'duplicate' });
    // A new delivery for the same order and status (order.updated): same events, deduplicated.
    expect((await deliver(raw, 'order.updated', `d2-${seed}`)).status).toBe(200);
    expect(await events()).toHaveLength(2);
    expect(outbound.dispatch).toHaveBeenCalledTimes(2);

    // Completed later: a new event, no rule for it.
    expect((await deliver(order({ status: 'completed' }), 'order.updated', `d3-${seed}`)).status).toBe(200);
    expect((await events()).at(-1)).toMatchObject({ event: 'order_fulfilled', status: 'skipped', reason: 'no_rule' });
  });

  it('sends a marketing template to a contact that existed before the order', async () => {
    await owner.query("INSERT INTO contacts(account_id,user_id,phone,name) VALUES($1,$2,$3,'Existing')", [accountA, adminA, `+9197${seed}`]);
    const raw = order({ id: 5002, number: '5002', billing: { first_name: 'Existing', phone: `97${seed}`, country: 'IN' } });
    expect((await deliver(raw, 'order.updated', `d5-${seed}`)).status).toBe(200);
    expect((await events()).at(-1)).toMatchObject({ event: 'order_paid', status: 'scheduled', reason: null, dedupe_key: `woocommerce:${storeId}:5002:order_paid` });
  });

  it('disconnecting stops the store: deliveries 404, queued sends are skipped, the last store switches rules off', async () => {
    const asWorkerA = { accountId: accountA, role: 'owner' as const };
    const stop = (id: string) => withTenant(asWorkerA, (tx) => stopWooStore(tx, accountA, id), getWorkerPrisma());
    const row = async (key: string) => (await owner.query(
      'SELECT id,status,reason FROM commerce_events WHERE account_id=$1 AND dedupe_key=$2', [accountA, key])).rows[0];
    const rulesOn = async () => (await owner.query(
      "SELECT count(*)::int AS n FROM commerce_event_rules WHERE account_id=$1 AND source='woocommerce' AND enabled", [accountA])).rows[0].n;

    // A second store with its own queued send, and one send whose outcome is unknown.
    const second = await withTenant(asAdminA, (tx) => createWooStore(tx, accountA, { storeUrl: `https://two${seed}.example.com` }));
    const raw = order({ id: 6001, number: '6001', status: 'pending', date_paid_gmt: null });
    expect((await deliver(raw, 'order.created', `s2-${seed}`, second.webhookSecret, second.store.id)).status).toBe(200);
    const queued = `woocommerce:${storeId}:5001:order_created`;
    const unknown = `woocommerce:${storeId}:5002:order_paid`;
    const other = `woocommerce:${second.store.id}:6001:order_created`;
    expect(await row(queued)).toMatchObject({ status: 'scheduled', reason: null });
    expect(await row(other)).toMatchObject({ status: 'scheduled', reason: null });
    await owner.query("UPDATE commerce_events SET reason='outcome_unknown' WHERE account_id=$1 AND dedupe_key=$2", [accountA, unknown]);

    // Nothing happens while the store is still connected, and the app role cannot do it at all.
    expect(await stop(storeId)).toBe(0);
    expect(await row(queued)).toMatchObject({ status: 'scheduled', reason: null });

    expect(await withTenant(asAdminA, (tx) => deleteWooStore(tx, accountA, storeId))).toBe(true);
    await expect(withTenant(asAdminA, (tx) => stopWooStore(tx, accountA, storeId))).rejects.toThrow();
    // Another tenant's worker cannot touch account A's events.
    expect(await withTenant({ accountId: accountB, role: 'owner' }, (tx) => stopWooStore(tx, accountA, storeId), getWorkerPrisma())).toBe(0);
    expect(await row(queued)).toMatchObject({ status: 'scheduled', reason: null });

    expect(await stop(storeId)).toBe(1);
    expect(await row(queued)).toMatchObject({ status: 'skipped', reason: 'store_disconnected' });
    expect(await row(unknown)).toMatchObject({ status: 'scheduled', reason: 'outcome_unknown' });
    expect(await row(other)).toMatchObject({ status: 'scheduled', reason: null });
    expect(await rulesOn()).toBe(2); // another store remains
    expect(await stop(storeId)).toBe(0); // repeatable

    // The send job that was queued for the skipped event does nothing.
    await handleCommerceEventJob(accountA, { eventId: (await row(queued)).id });
    expect(engineSendTemplate).not.toHaveBeenCalled();
    expect(await row(queued)).toMatchObject({ status: 'skipped', reason: 'store_disconnected' });

    expect((await deliver(order(), 'order.created', `d4-${seed}`)).status).toBe(404);

    // Last store gone: its sends are skipped and every WooCommerce rule is off.
    expect(await withTenant(asAdminA, (tx) => deleteWooStore(tx, accountA, second.store.id))).toBe(true);
    expect(await stop(second.store.id)).toBe(1);
    expect(await row(other)).toMatchObject({ status: 'skipped', reason: 'store_disconnected' });
    expect(await rulesOn()).toBe(0);
    if (second.store.id) await owner.query('DELETE FROM webhook_receipts WHERE dedupe_key LIKE $1', [`woocommerce:${second.store.id}:%`]);
  });
});
