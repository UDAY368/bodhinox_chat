import { randomUUID } from 'node:crypto';
import { config } from 'dotenv';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { disconnectDatabases, getPrisma, getWorkerPrisma } from '@/lib/db/prisma';
import { withTenant, type TenantContext } from '@/lib/db/tenant';
import { encrypt } from '@/lib/whatsapp/encryption';
import { handleCommerceEventJob, recordCommerceEvent, type RecordCommerceEventInput } from './event-rules';
import { claimWebhookReceipt } from './webhook-receipts';
import { deletePaymentProvider, getPaymentProvider, loadRazorpaySecrets, savePaymentProvider } from '@/lib/payments/providers';

const meta = vi.hoisted(() => ({ send: vi.fn(async () => ({ whatsapp_message_id: 'wamid.commerce' })) }));
vi.mock('@/lib/automations/meta-send', () => ({ engineSendTemplate: meta.send }));
vi.mock('@/lib/webhooks/deliver', () => ({ dispatchWebhookEvent: vi.fn(async () => {}) }));

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
const seed = String(Date.now()).slice(-9);
let owner: pg.Client;
let configA = '';

const record = (input: Partial<RecordCommerceEventInput> & { dedupeKey: string }) =>
  withTenant({ accountId: accountA, role: 'owner' }, (tx) => recordCommerceEvent(tx, {
    accountId: accountA, source: 'shopify', event: 'order_paid', payload: {}, ...input,
  }), getWorkerPrisma());
const eventRow = async (id: string) => (await owner.query('SELECT status,reason,contact_id,payload FROM commerce_events WHERE id=$1', [id])).rows[0];
const jobFor = async (id: string) => (await owner.query("SELECT type,tenant_id,run_at FROM jobs WHERE dedupe_key=$1", [`commerce:${id}`])).rows;
const phone = (n: number) => `+9198${seed}${n}`;

describe.skipIf(!ownerUrl || !appUrl || !workerUrl)('commerce foundation on PostgreSQL', { timeout: 120_000 }, () => {
  beforeAll(async () => {
    owner = new pg.Client({ connectionString: ownerUrl });
    await owner.connect();
    if (!/test/i.test((await owner.query('SELECT current_database() AS name')).rows[0].name)) throw new Error('Requires an isolated test database');
    const app = await getPrisma().$queryRaw<{ role: string }[]>`SELECT current_user AS role`;
    if (app[0].role !== 'bodhinox_app') throw new Error('Requires constrained test app credentials');
    await owner.query("INSERT INTO auth_users(id,email,full_name,password_hash) SELECT x, x::text || '@example.invalid', 'Commerce test', 'test-only-hash' FROM unnest($1::uuid[]) x", [[adminA, agentA, viewerA, ownerB]]);
    await owner.query("INSERT INTO accounts(id,name,owner_user_id) VALUES($1,'Commerce A',$2),($3,'Commerce B',$4)", [accountA, adminA, accountB, ownerB]);
    await owner.query("INSERT INTO account_memberships(account_id,user_id,role) VALUES($1,$2,'admin'),($1,$3,'agent'),($1,$4,'viewer'),($5,$6,'owner')", [accountA, adminA, agentA, viewerA, accountB, ownerB]);
    configA = (await owner.query(
      "INSERT INTO whatsapp_config(account_id,user_id,phone_number_id,waba_id,access_token,status) VALUES($1,$2,$3,$4,$5,'connected') RETURNING id",
      [accountA, adminA, `61${seed}`, `62${seed}`, encrypt('test-only-token')],
    )).rows[0].id;
    await owner.query(`INSERT INTO message_templates(account_id,user_id,name,body_text,status,category,language) VALUES
      ($1,$2,'order_update','Order {{1}} paid: {{2}}','APPROVED','Utility','en'),
      ($1,$2,'come_back','Your cart is waiting','APPROVED','Marketing','en')`, [accountA, adminA]);
    await owner.query(`INSERT INTO commerce_event_rules(account_id,source,event,enabled,template_name,template_language,delay_minutes,variable_map) VALUES
      ($1,'shopify','order_paid',true,'order_update','en',0,'{"1":"order_number","2":"total"}'),
      ($1,'shopify','order_created',false,'order_update','en',0,'{}'),
      ($1,'shopify','checkout_abandoned',true,'come_back','en',60,'{}'),
      ($1,'woocommerce','order_paid',true,'come_back','en',0,'{}')`, [accountA]);
  });
  beforeEach(() => meta.send.mockClear());
  afterAll(async () => {
    if (owner) {
      await owner.query("DELETE FROM jobs WHERE tenant_id=ANY($1::uuid[])", [[accountA, accountB]]);
      await owner.query("DELETE FROM webhook_receipts WHERE dedupe_key LIKE $1", [`razorpay:it-${seed}%`]);
      await owner.query('DELETE FROM accounts WHERE id=ANY($1::uuid[])', [[accountA, accountB]]);
      await owner.query('DELETE FROM auth_users WHERE id=ANY($1::uuid[])', [[adminA, agentA, viewerA, ownerB]]);
      await owner.end();
    }
    await disconnectDatabases();
  });

  it('records an event once, creates the contact and queues one durable send', async () => {
    const input = { dedupeKey: `paid-${seed}`, externalId: '1001', phone: phone(1), name: 'Asha',
      payload: { order_number: '#1001', total_minor: 50000, currency: 'INR', customer: { address: 'secret' } } };
    const first = await record(input);
    expect(first).toMatchObject({ duplicate: false, status: 'scheduled', reason: null });
    expect(first.contactId).toBeTruthy();
    const again = await record(input);
    expect(again).toMatchObject({ eventId: first.eventId, duplicate: true, status: 'scheduled' });
    expect((await owner.query('SELECT count(*)::int AS n FROM commerce_events WHERE account_id=$1 AND dedupe_key=$2', [accountA, input.dedupeKey])).rows[0].n).toBe(1);
    const jobs = await jobFor(first.eventId);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ type: 'commerce.event_send', tenant_id: accountA });
    const row = await eventRow(first.eventId);
    // Only flat fields are kept; the nested customer record is dropped.
    expect(row.payload).toEqual({ order_number: '#1001', total_minor: 50000, currency: 'INR', customer_name: 'Asha', total: '₹500.00' });
    expect((await owner.query('SELECT name,user_id FROM contacts WHERE id=$1', [first.contactId])).rows[0]).toEqual({ name: 'Asha', user_id: adminA });
  });

  it('sends the template once through an outbound intent and ignores a redelivered job', async () => {
    const { eventId, contactId } = await record({ dedupeKey: `send-${seed}`, phone: phone(2), payload: { order_number: '#7', total: '₹7.00' } });
    await handleCommerceEventJob(accountA, { eventId });
    expect(meta.send).toHaveBeenCalledTimes(1);
    expect(meta.send.mock.calls[0]).toEqual([expect.objectContaining({
      accountId: accountA, contactId, templateName: 'order_update', language: 'en', params: ['#7', '₹7.00'], bodyValuesOnly: true,
    })]);
    expect(await eventRow(eventId)).toMatchObject({ status: 'sent', reason: null });
    const intent = (await owner.query('SELECT status FROM outbound_intents WHERE idempotency_key=$1', [`${accountA}:commerce:${eventId}`])).rows;
    expect(intent).toEqual([{ status: 'accepted' }]);
    const conversation = (await owner.query('SELECT whatsapp_config_id FROM conversations WHERE account_id=$1 AND contact_id=$2', [accountA, contactId])).rows;
    expect(conversation).toEqual([{ whatsapp_config_id: configA }]);
    await handleCommerceEventJob(accountA, { eventId });
    expect(meta.send).toHaveBeenCalledTimes(1);
  });

  it('surfaces an ambiguous send for reconciliation and never re-sends it', async () => {
    const { eventId } = await record({ dedupeKey: `ambiguous-${seed}`, phone: phone(3), payload: { order_number: '#8' } });
    meta.send.mockRejectedValueOnce(new Error('socket hang up'));
    await expect(handleCommerceEventJob(accountA, { eventId })).rejects.toMatchObject({ name: 'UncertainDispatchError' });
    expect(await eventRow(eventId)).toMatchObject({ status: 'scheduled', reason: 'outcome_unknown' });
    await expect(handleCommerceEventJob(accountA, { eventId })).rejects.toMatchObject({ name: 'UncertainDispatchError' });
    expect(meta.send).toHaveBeenCalledTimes(1);
  });

  it('skips without a rule, with a disabled rule and without a phone', async () => {
    expect(await record({ dedupeKey: `norule-${seed}`, event: 'order_fulfilled', phone: phone(4) })).toMatchObject({ status: 'skipped', reason: 'no_rule' });
    expect(await record({ dedupeKey: `disabled-${seed}`, event: 'order_created', phone: phone(4) })).toMatchObject({ status: 'skipped', reason: 'rule_disabled' });
    const nophone = await record({ dedupeKey: `nophone-${seed}`, phone: '12345' });
    expect(nophone).toMatchObject({ status: 'skipped', reason: 'no_phone', contactId: null });
    expect(await jobFor(nophone.eventId)).toEqual([]);
  });

  it('applies the consent rule for blocked, opted-out and new contacts', async () => {
    const blocked = (await owner.query("INSERT INTO contacts(account_id,user_id,phone,name,blocked_at) VALUES($1,$2,$3,'B',now()) RETURNING id", [accountA, adminA, phone(5).slice(1)])).rows[0].id;
    expect(await record({ dedupeKey: `blocked-${seed}`, phone: phone(5) })).toMatchObject({ status: 'skipped', reason: 'contact_blocked', contactId: blocked });
    await owner.query("INSERT INTO contacts(account_id,user_id,phone,name,opted_out_at) VALUES($1,$2,$3,'O',now())", [accountA, adminA, phone(6)]);
    // Utility goes to an opted-out contact; marketing does not.
    expect(await record({ dedupeKey: `optout-utility-${seed}`, phone: phone(6) })).toMatchObject({ status: 'scheduled' });
    expect(await record({ dedupeKey: `optout-mkt-${seed}`, source: 'woocommerce', phone: phone(6), marketingConsent: true }))
      .toMatchObject({ status: 'skipped', reason: 'contact_opted_out' });
    // A contact first seen through this event needs the store's consent for marketing.
    expect(await record({ dedupeKey: `new-mkt-${seed}`, source: 'woocommerce', phone: phone(7) })).toMatchObject({ status: 'skipped', reason: 'no_marketing_consent' });
    expect(await record({ dedupeKey: `new-mkt-ok-${seed}`, source: 'woocommerce', phone: phone(8), marketingConsent: true })).toMatchObject({ status: 'scheduled' });
  });

  it('re-checks consent at send time and skips an abandoned checkout that became an order', async () => {
    const later = await record({ dedupeKey: `optout-later-${seed}`, event: 'checkout_abandoned', phone: phone(9), marketingConsent: true, payload: { checkout_token: `tok-a-${seed}` } });
    expect(later.status).toBe('scheduled');
    expect((await jobFor(later.eventId))[0].run_at.getTime()).toBeGreaterThan(Date.now() + 59 * 60_000);
    await owner.query('UPDATE contacts SET opted_out_at=now() WHERE id=$1', [later.contactId]);
    await handleCommerceEventJob(accountA, { eventId: later.eventId });
    expect(await eventRow(later.eventId)).toMatchObject({ status: 'skipped', reason: 'contact_opted_out' });

    const abandoned = await record({ dedupeKey: `abandoned-${seed}`, event: 'checkout_abandoned', phone: phone(0), marketingConsent: true, payload: { checkout_token: `tok-b-${seed}` } });
    await record({ dedupeKey: `bought-${seed}`, event: 'order_created', phone: phone(0), payload: { checkout_token: `tok-b-${seed}` } });
    await handleCommerceEventJob(accountA, { eventId: abandoned.eventId });
    expect(await eventRow(abandoned.eventId)).toMatchObject({ status: 'skipped', reason: 'checkout_completed' });
    expect(meta.send).not.toHaveBeenCalled();
  });

  it('keeps commerce rows inside the tenant and enforces role grants', async () => {
    expect(await withTenant(asB, (tx) => tx.commerce_events.count({ where: { account_id: accountA } }))).toBe(0);
    expect(await withTenant(asViewerA, (tx) => tx.commerce_events.count())).toBeGreaterThan(0);
    // Events and orders are written by the worker only.
    await expect(withTenant(asAdminA, (tx) => tx.$executeRaw`INSERT INTO commerce_events(source,event,dedupe_key) VALUES('shopify','order_paid','x')`)).rejects.toThrow();
    await expect(withTenant(asAdminA, (tx) => tx.$executeRaw`INSERT INTO orders(source,currency,subtotal_minor) VALUES('manual','INR',100)`)).rejects.toThrow();
    // Rules: members read, admins write.
    await expect(withTenant(asAgentA, (tx) => tx.$executeRaw`UPDATE commerce_event_rules SET enabled=false WHERE account_id=${accountA}::uuid`)).resolves.toBe(0);
    expect(await withTenant(asAgentA, (tx) => tx.commerce_event_rules.count())).toBe(4);
  });

  it('lets agents move an order status but not change its amounts', async () => {
    const order = await withTenant({ accountId: accountA, role: 'owner' }, (tx) => tx.orders.create({
      data: { account_id: accountA, source: 'whatsapp', message_id: `wamid.order.${seed}`, currency: 'INR', subtotal_minor: BigInt(1000) }, select: { id: true },
    }), getWorkerPrisma());
    await withTenant({ accountId: accountA, role: 'owner' }, (tx) => tx.order_items.create({
      data: { account_id: accountA, order_id: order.id, retailer_id: 'SKU', name: 'Tea', quantity: 2, unit_price_minor: BigInt(500), currency: 'INR' },
    }), getWorkerPrisma());
    await withTenant(asAgentA, (tx) => tx.$executeRaw`UPDATE orders SET status='confirmed' WHERE id=${order.id}::uuid`);
    await expect(withTenant(asAgentA, (tx) => tx.$executeRaw`UPDATE orders SET subtotal_minor=1 WHERE id=${order.id}::uuid`)).rejects.toThrow();
    expect(await withTenant(asViewerA, (tx) => tx.orders.count())).toBe(0);
    expect(await withTenant(asB, (tx) => tx.orders.count({ where: { id: order.id } }))).toBe(0);
    expect((await owner.query('SELECT status FROM orders WHERE id=$1', [order.id])).rows[0].status).toBe('confirmed');
    // One order per inbound message.
    await expect(withTenant({ accountId: accountA, role: 'owner' }, (tx) => tx.orders.create({
      data: { account_id: accountA, source: 'whatsapp', message_id: `wamid.order.${seed}`, currency: 'INR', subtotal_minor: BigInt(1) },
    }), getWorkerPrisma())).rejects.toThrow();
  });

  it('stores Razorpay secrets encrypted and never lets the app role read them', async () => {
    const saved = await withTenant(asAdminA, (tx) => savePaymentProvider(tx, accountA, { keyId: 'rzp_test_ABCDEF123456', keySecret: 'key-secret', webhookSecret: 'hook-secret' }));
    expect(saved).toMatchObject({ provider: 'razorpay', mode: 'test', key_id: 'rzp_test_ABCDEF123456' });
    expect(Object.keys(saved)).not.toContain('key_secret_enc');
    const stored = (await owner.query('SELECT key_secret_enc,webhook_secret_enc FROM payment_providers WHERE account_id=$1', [accountA])).rows[0];
    expect(stored.key_secret_enc).not.toContain('key-secret');
    await expect(withTenant(asAdminA, (tx) => tx.$queryRaw`SELECT key_secret_enc FROM payment_providers`)).rejects.toThrow();
    await expect(withTenant(asAdminA, (tx) => tx.$queryRaw`SELECT * FROM payment_providers`)).rejects.toThrow();
    expect(await withTenant(asViewerA, (tx) => getPaymentProvider(tx, accountA))).toMatchObject({ key_id: 'rzp_test_ABCDEF123456' });
    expect(await loadRazorpaySecrets(accountA)).toEqual({ keyId: 'rzp_test_ABCDEF123456', keySecret: 'key-secret', webhookSecret: 'hook-secret', mode: 'test' });
    // Replacing keys without a webhook secret keeps the stored one.
    await withTenant(asAdminA, (tx) => savePaymentProvider(tx, accountA, { keyId: 'rzp_live_ABCDEF123456', keySecret: 'key-2' }));
    expect(await loadRazorpaySecrets(accountA)).toEqual({ keyId: 'rzp_live_ABCDEF123456', keySecret: 'key-2', webhookSecret: 'hook-secret', mode: 'live' });
    // Agents cannot connect or disconnect; other tenants see nothing.
    await expect(withTenant(asAgentA, (tx) => savePaymentProvider(tx, accountA, { keyId: 'rzp_test_ZZZZZZ123456', keySecret: 'x' }))).rejects.toThrow();
    expect(await withTenant(asAgentA, (tx) => deletePaymentProvider(tx, accountA))).toBe(false);
    expect(await withTenant(asB, (tx) => getPaymentProvider(tx, accountA))).toBeNull();
    await expect(loadRazorpaySecrets(accountB)).rejects.toMatchObject({ reason: 'not_connected' });
  });

  it('lets agents create payment links that only the worker can mark paid', async () => {
    const reference = `ref_${seed}_abcdefghij`;
    await withTenant(asAgentA, (tx) => tx.payment_links.create({
      data: { account_id: accountA, provider: 'razorpay', reference_id: reference, amount_minor: BigInt(50000), currency: 'INR', created_by: agentA },
      select: { id: true },
    }));
    await expect(withTenant(asAdminA, (tx) => tx.$executeRaw`UPDATE payment_links SET status='paid' WHERE reference_id=${reference}`)).rejects.toThrow();
    await withTenant({ accountId: accountA, role: 'owner' }, (tx) => tx.$executeRaw`UPDATE payment_links SET status='paid',paid_at=now() WHERE reference_id=${reference}`, getWorkerPrisma());
    expect((await owner.query('SELECT status FROM payment_links WHERE reference_id=$1', [reference])).rows[0].status).toBe('paid');
    await expect(withTenant(asViewerA, (tx) => tx.payment_links.create({
      data: { account_id: accountA, provider: 'razorpay', reference_id: `${reference}x`, amount_minor: BigInt(1), currency: 'INR' },
    }))).rejects.toThrow();
    expect(await withTenant(asB, (tx) => tx.payment_links.count())).toBe(0);
  });

  it('records each provider webhook delivery once', async () => {
    const claim = () => getWorkerPrisma().$transaction((tx) => claimWebhookReceipt(tx, { provider: 'razorpay', receiptId: `it-${seed}`, payload: { event: 'payment_link.paid' } }));
    const first = await claim();
    expect(first.duplicate).toBe(false);
    expect(await claim()).toEqual({ id: first.id, duplicate: true });
  });
});
