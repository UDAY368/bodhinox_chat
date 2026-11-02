import { randomUUID } from 'node:crypto';
import { config } from 'dotenv';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { disconnectDatabases, getPrisma, getWorkerPrisma } from '@/lib/db/prisma';
import { withTenant, type TenantContext } from '@/lib/db/tenant';
import { encrypt } from '@/lib/whatsapp/encryption';
import { getShopifyStore, loadShopifyToken, saveShopifyStore, setMarketingOptInOnly, ShopifyStoreError } from './store';
import { processShopifyWebhook, type ShopifyDelivery } from './webhooks';
import { saveShopifyRule } from './rules';
import { dispatchWebhookEvent } from '@/lib/webhooks/deliver';

vi.mock('@/lib/automations/meta-send', () => ({ engineSendTemplate: vi.fn(async () => ({ whatsapp_message_id: 'wamid.shopify' })) }));
vi.mock('@/lib/webhooks/deliver', () => ({ dispatchWebhookEvent: vi.fn(async () => {}) }));
const dispatched = (event: string) => vi.mocked(dispatchWebhookEvent).mock.calls.filter((c) => c[2] === event);

const configured = config({ path: '.env.test', quiet: true }).parsed;
const ownerUrl = process.env.TEST_DATABASE_URL;
const appUrl = process.env.TEST_APP_DATABASE_URL || configured?.DATABASE_URL;
const workerUrl = process.env.TEST_WORKER_DATABASE_URL || configured?.WORKER_DATABASE_URL;
if (appUrl) process.env.DATABASE_URL = appUrl;
if (workerUrl) process.env.WORKER_DATABASE_URL = workerUrl;

const accountA = randomUUID(), accountB = randomUUID();
const adminA = randomUUID(), viewerA = randomUUID(), ownerB = randomUUID();
const asAdminA: TenantContext = { accountId: accountA, userId: adminA, role: 'admin' };
const asViewerA: TenantContext = { accountId: accountA, userId: viewerA, role: 'viewer' };
const asB: TenantContext = { accountId: accountB, userId: ownerB, role: 'owner' };
const seed = String(Date.now()).slice(-9);
const shopA = `it-a-${seed}.myshopify.com`;
const shopB = `it-b-${seed}.myshopify.com`;
const shopC = `it-c-${seed}.myshopify.com`;
let owner: pg.Client;
let configA = '';
let hook = 0;

const deliver = (topic: string, body: Record<string, unknown>, shop = shopA, extra: Partial<ShopifyDelivery> = {}) =>
  processShopifyWebhook({ topic, shop, webhookId: `it-${seed}-${++hook}`, body, ...extra });
const order = (id: number, extra: Record<string, unknown> = {}) => ({
  id, name: `#${id}`, currency: 'INR', total_price: '500.00', checkout_token: `ck-${seed}-${id}`,
  phone: `+9197${seed}${id % 10}`, customer: { id: 900 + id, first_name: 'Asha', email: `asha${id}@example.invalid`, sms_marketing_consent: { state: 'subscribed' } },
  ...extra,
});
const contactByPhone = async (phone: string, account = accountA) =>
  (await owner.query('SELECT id,name,email,phone FROM contacts WHERE account_id=$1 AND phone_normalized=$2', [account, phone.replace(/\D/g, '')])).rows[0] ?? null;
const events = async (account = accountA) => (await owner.query(
  'SELECT id,event,status,reason,external_id,contact_id,payload FROM commerce_events WHERE account_id=$1 ORDER BY created_at', [account])).rows;

describe.skipIf(!ownerUrl || !appUrl || !workerUrl)('Shopify store on PostgreSQL', { timeout: 120_000 }, () => {
  beforeAll(async () => {
    owner = new pg.Client({ connectionString: ownerUrl });
    await owner.connect();
    if (!/test/i.test((await owner.query('SELECT current_database() AS name')).rows[0].name)) throw new Error('Requires an isolated test database');
    const app = await getPrisma().$queryRaw<{ role: string }[]>`SELECT current_user AS role`;
    if (app[0].role !== 'bodhinox_app') throw new Error('Requires constrained test app credentials');
    await owner.query("INSERT INTO auth_users(id,email,full_name,password_hash) SELECT x, x::text || '@example.invalid', 'Shopify test', 'test-only-hash' FROM unnest($1::uuid[]) x", [[adminA, viewerA, ownerB]]);
    await owner.query("INSERT INTO accounts(id,name,owner_user_id) VALUES($1,'Shopify A',$2),($3,'Shopify B',$4)", [accountA, adminA, accountB, ownerB]);
    await owner.query("INSERT INTO account_memberships(account_id,user_id,role) VALUES($1,$2,'admin'),($1,$3,'viewer'),($4,$5,'owner')", [accountA, adminA, viewerA, accountB, ownerB]);
    configA = (await owner.query(
      "INSERT INTO whatsapp_config(account_id,user_id,phone_number_id,waba_id,access_token,status,is_default) VALUES($1,$2,$3,$4,$5,'connected',true) RETURNING id",
      [accountA, adminA, `71${seed}`, `72${seed}`, encrypt('test-only-token')],
    )).rows[0].id;
    await owner.query(`INSERT INTO message_templates(account_id,user_id,name,body_text,status,category,language) VALUES
      ($1,$2,'order_update','Order {{1}} total {{2}}','APPROVED','Utility','en'),
      ($1,$2,'cart_reminder','Your cart is waiting {{1}}','APPROVED','Marketing','en')`, [accountA, adminA]);
  });
  afterAll(async () => {
    if (owner) {
      await owner.query('DELETE FROM jobs WHERE tenant_id=ANY($1::uuid[])', [[accountA, accountB]]);
      await owner.query('DELETE FROM webhook_receipts WHERE dedupe_key LIKE $1', [`shopify:it-${seed}-%`]);
      await owner.query('DELETE FROM accounts WHERE id=ANY($1::uuid[])', [[accountA, accountB]]);
      await owner.query('DELETE FROM auth_users WHERE id=ANY($1::uuid[])', [[adminA, viewerA, ownerB]]);
      await owner.end();
    }
    await disconnectDatabases();
  });

  it('lets an admin connect, keeps the token unreadable to the app role and refuses a store bound elsewhere', async () => {
    await expect(withTenant(asViewerA, (tx) => saveShopifyStore(tx, accountA, { shop: shopA, accessToken: 'shpat_a', scopes: ['read_orders'] }))).rejects.toThrow();
    const saved = await withTenant(asAdminA, (tx) => saveShopifyStore(tx, accountA, { shop: shopA, accessToken: 'shpat_a', scopes: ['read_orders'] }));
    expect(saved).toMatchObject({ shop_domain: shopA, uninstalled_at: null, marketing_opt_in_only: true });
    expect(saved).not.toHaveProperty('access_token_enc');
    await expect(withTenant(asAdminA, (tx) => tx.$queryRawUnsafe('SELECT access_token_enc FROM shopify_stores'))).rejects.toThrow();
    await expect(withTenant(asAdminA, (tx) => tx.$queryRawUnsafe('SELECT * FROM shopify_stores'))).rejects.toThrow();
    const stored = (await owner.query('SELECT access_token_enc FROM shopify_stores WHERE account_id=$1', [accountA])).rows[0];
    expect(stored.access_token_enc).not.toContain('shpat_a');
    expect(await loadShopifyToken(accountA)).toEqual({ shop: shopA, accessToken: 'shpat_a' });
    // Members read the public columns; viewers cannot change settings.
    expect(await withTenant(asViewerA, (tx) => getShopifyStore(tx, accountA))).toMatchObject({ shop_domain: shopA });
    await withTenant(asViewerA, (tx) => setMarketingOptInOnly(tx, accountA, false));
    expect((await withTenant(asViewerA, (tx) => getShopifyStore(tx, accountA)))?.marketing_opt_in_only).toBe(true);
    // Another workspace cannot see it or claim the same store.
    expect(await withTenant(asB, (tx) => getShopifyStore(tx, accountA))).toBeNull();
    await expect(withTenant(asB, (tx) => saveShopifyStore(tx, accountB, { shop: shopA, accessToken: 'shpat_b', scopes: [] })))
      .rejects.toBeInstanceOf(ShopifyStoreError);
    await withTenant(asB, (tx) => saveShopifyStore(tx, accountB, { shop: shopB, accessToken: 'shpat_b', scopes: [] }));
  });

  it('saves rules only for approved templates and admins', async () => {
    const rule = { event: 'order_paid' as const, enabled: true, template_name: 'order_update', template_language: 'en', whatsapp_config_id: null, delay_minutes: 0, variable_map: { '1': 'order_number', '2': 'total' } };
    await expect(withTenant(asViewerA, (tx) => saveShopifyRule(tx, accountA, rule))).rejects.toThrow();
    await expect(withTenant(asAdminA, (tx) => saveShopifyRule(tx, accountA, { ...rule, template_name: 'missing' }))).rejects.toThrow('template_not_found');
    expect(await withTenant(asAdminA, (tx) => saveShopifyRule(tx, accountA, rule))).toMatchObject({ event: 'order_paid', enabled: true });
    await withTenant(asAdminA, (tx) => saveShopifyRule(tx, accountA, {
      ...rule, event: 'checkout_abandoned', template_name: 'cart_reminder', delay_minutes: 60, variable_map: { '1': 'checkout_url' },
    }));
  });

  it('records an order once per delivery and per order, with a queued send', async () => {
    const body = order(1);
    expect(await processShopifyWebhook({ topic: 'orders/paid', shop: shopA, webhookId: `it-${seed}-dup`, body })).toBe('recorded');
    expect(await processShopifyWebhook({ topic: 'orders/paid', shop: shopA, webhookId: `it-${seed}-dup`, body })).toBe('duplicate');
    expect(await deliver('orders/paid', body)).toBe('recorded'); // new delivery id, same order: event deduplicated
    const rows = (await events()).filter((e) => e.event === 'order_paid');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: 'scheduled', external_id: '1' });
    expect(rows[0].payload).toMatchObject({ order_number: '#1', total: '₹500.00', shop_domain: shopA });
    expect(JSON.stringify(rows[0].payload)).not.toContain('example.invalid');
    const jobs = (await owner.query('SELECT count(*)::int AS n FROM jobs WHERE dedupe_key=$1', [`commerce:${rows[0].id}`])).rows[0].n;
    expect(jobs).toBe(1);
    // One outbound order.paid for the order event, none for the redelivery or the repeated event.
    expect(dispatched('order.paid')).toHaveLength(1);
    expect(dispatched('order.paid')[0][3]).toMatchObject({ source: 'shopify', external_id: '1', order_number: '#1', total_minor: 50000 });
    // The contact this order created is recorded as its provenance.
    const created = await contactByPhone(`+9197${seed}1`);
    expect(created).toMatchObject({ name: 'Asha', email: 'asha1@example.invalid' });
    const provenance = (await owner.query('SELECT created_contact_id FROM commerce_events WHERE id=$1', [rows[0].id])).rows[0];
    expect(provenance.created_contact_id).toBe(created.id);
    // Unknown store: acknowledged and ignored.
    expect(await deliver('orders/paid', order(2), `it-none-${seed}.myshopify.com`)).toBe('ignored');
  });

  it('schedules an abandoned checkout once per token and honours opt-in-only consent', async () => {
    const checkout = { token: `tok-${seed}`, abandoned_checkout_url: 'https://x.myshopify.com/r', phone: `+9196${seed}1`, buyer_accepts_marketing: true };
    expect(await deliver('checkouts/create', { ...checkout, phone: null })).toBe('ignored');
    expect(await deliver('checkouts/create', checkout)).toBe('recorded');
    expect(await deliver('checkouts/update', checkout)).toBe('recorded');
    const abandoned = (await events()).filter((e) => e.event === 'checkout_abandoned');
    expect(abandoned).toHaveLength(1);
    expect(abandoned[0]).toMatchObject({ status: 'scheduled' });
    // No consent reported + opt-in only => not sent as marketing.
    await deliver('checkouts/create', { token: `tok2-${seed}`, phone: `+9196${seed}2` });
    const second = (await events()).find((e) => e.external_id === `tok2-${seed}`);
    expect(second).toMatchObject({ status: 'skipped', reason: 'no_marketing_consent' });
  });

  it('emits order.created for orders/create and marks only contacts it created', async () => {
    // A contact the workspace already had is linked but never marked as created by the store.
    await owner.query("INSERT INTO contacts(account_id,user_id,phone,name,email) VALUES($1,$2,$3,'Existing','kept@example.invalid')", [accountA, adminA, `+9197${seed}5`]);
    expect(await deliver('orders/create', order(5))).toBe('recorded');
    expect(await deliver('orders/create', order(6))).toBe('recorded');
    expect(dispatched('order.created')).toHaveLength(2);
    const created = (await events()).filter((e) => e.event === 'order_created');
    const marks = (await owner.query('SELECT external_id,created_contact_id FROM commerce_events WHERE id=ANY($1::uuid[])', [created.map((e) => e.id)])).rows;
    expect(marks.find((m) => m.external_id === '5').created_contact_id).toBeNull();
    expect(marks.find((m) => m.external_id === '6').created_contact_id).toBeTruthy();
    // Customer 906 has since talked to the workspace on WhatsApp.
    const talked = await contactByPhone(`+9197${seed}6`);
    await owner.query('INSERT INTO conversations(account_id,user_id,contact_id,whatsapp_config_id) VALUES($1,$2,$3,$4)', [accountA, adminA, talked.id, configA]);
  });

  it('answers customers/data_request by recording it and customers/redact by anonymising the customer', async () => {
    expect(await deliver('customers/data_request', { customer: { id: 901 }, orders_requested: [1], data_request: { id: 7 } })).toBe('data_request_recorded');
    const receipt = (await owner.query("SELECT payload,status FROM webhook_receipts WHERE dedupe_key LIKE $1 AND payload->>'topic'='customers/data_request'", [`shopify:it-${seed}-%`])).rows[0];
    expect(receipt).toMatchObject({ status: 'pending', payload: { customer_id: '901', events_held: 1 } });
    expect(await deliver('customers/redact', { customer: { id: 901, email: 'asha1@example.invalid' }, orders_to_redact: [1] })).toBe('redacted');
    const paid = (await events()).find((e) => e.event === 'order_paid')!;
    expect(paid).toMatchObject({ payload: { redacted: true }, contact_id: null, status: 'skipped', reason: 'customer_redacted' });
    // The contact this store created for the customer is erased with the events.
    expect(await contactByPhone(`+9197${seed}1`)).toBeNull();
    // A contact the workspace already had is untouched.
    expect(await deliver('customers/redact', { customer: { id: 905, email: 'asha5@example.invalid' }, orders_to_redact: [5] })).toBe('redacted');
    expect(await contactByPhone(`+9197${seed}5`)).toMatchObject({ name: 'Existing', email: 'kept@example.invalid' });
    // A store-created contact with a conversation keeps its phone but loses the store's name and email.
    expect(await deliver('customers/redact', { customer: { id: 906 }, orders_to_redact: [6] })).toBe('redacted');
    expect(await contactByPhone(`+9197${seed}6`)).toMatchObject({ name: `9197${seed}6`, phone: `9197${seed}6`, email: null });
    const left = (await owner.query(
      "SELECT count(*)::int AS n FROM contacts WHERE account_id=$1 AND (email LIKE 'asha%' OR name='Asha')", [accountA])).rows[0].n;
    expect(left).toBe(0);
    // Other customers are untouched.
    expect((await events()).find((e) => e.event === 'checkout_abandoned' && e.status === 'scheduled')).toBeTruthy();
  });

  it('stops rules and queued sends on app/uninstalled, ignoring a stale uninstall', async () => {
    expect(await deliver('app/uninstalled', {}, shopA, { triggeredAt: new Date(Date.now() - 86_400_000) })).toBe('uninstalled');
    expect((await withTenant(asAdminA, (tx) => getShopifyStore(tx, accountA)))?.uninstalled_at).toBeNull();
    expect(await deliver('app/uninstalled', {})).toBe('uninstalled');
    const store = await withTenant(asAdminA, (tx) => getShopifyStore(tx, accountA));
    expect(store?.uninstalled_at).toBeInstanceOf(Date);
    expect(await loadShopifyToken(accountA)).toBeNull();
    expect((await owner.query('SELECT access_token_enc FROM shopify_stores WHERE account_id=$1', [accountA])).rows[0].access_token_enc).toBeNull();
    const rules = (await owner.query("SELECT enabled FROM commerce_event_rules WHERE account_id=$1 AND source='shopify'", [accountA])).rows;
    expect(rules.every((r) => r.enabled === false)).toBe(true);
    const abandoned = (await events()).find((e) => e.event === 'checkout_abandoned' && e.external_id === `tok-${seed}`);
    expect(abandoned).toMatchObject({ status: 'skipped', reason: 'store_disconnected' });
    // Further order events are ignored, and the worker can never switch a rule back on.
    expect(await deliver('orders/create', order(3))).toBe('ignored');
    await expect(withTenant({ accountId: accountA, role: 'owner' }, (tx) =>
      tx.$executeRaw`UPDATE commerce_event_rules SET enabled=true WHERE account_id=${accountA}::uuid`, getWorkerPrisma())).rejects.toThrow();
  });

  it('removes the store and anonymises its events on shop/redact; the domain can then be installed elsewhere', async () => {
    expect(await contactByPhone(`+9196${seed}1`)).not.toBeNull(); // created by the abandoned checkout
    expect(await deliver('shop/redact', { shop_domain: shopA })).toBe('redacted');
    expect(await contactByPhone(`+9196${seed}1`)).toBeNull();
    expect(await contactByPhone(`+9196${seed}2`)).toBeNull();
    expect(await contactByPhone(`+9197${seed}5`)).toMatchObject({ name: 'Existing' });
    expect((await owner.query('SELECT count(*)::int AS n FROM shopify_stores WHERE account_id=$1', [accountA])).rows[0].n).toBe(0);
    const left = (await events()).filter((e) => !e.payload.redacted);
    expect(left).toHaveLength(0);
    // Another workspace's store is untouched.
    expect(await withTenant(asB, (tx) => getShopifyStore(tx, accountB))).toMatchObject({ shop_domain: shopB });
  });

  it('keeps the old shop reachable for GDPR webhooks after the workspace connects a different shop', async () => {
    expect(await deliver('orders/paid', order(7), shopB)).toBe('recorded');
    expect(await contactByPhone(`+9197${seed}7`, accountB)).not.toBeNull();
    // Switch workspace B from shop B to shop C.
    const saved = await withTenant(asB, (tx) => saveShopifyStore(tx, accountB, { shop: shopC, accessToken: 'shpat_c', scopes: [] }));
    expect(saved).toMatchObject({ shop_domain: shopC, uninstalled_at: null });
    expect(await loadShopifyToken(accountB)).toEqual({ shop: shopC, accessToken: 'shpat_c' });
    const rows = (await owner.query('SELECT shop_domain,uninstalled_at,access_token_enc FROM shopify_stores WHERE account_id=$1 ORDER BY shop_domain', [accountB])).rows;
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ shop_domain: shopB, access_token_enc: null });
    expect(rows[0].uninstalled_at).toBeInstanceOf(Date);
    // Shop B's events no longer record, but its redaction webhooks still reach workspace B.
    expect(await deliver('orders/paid', order(8), shopB)).toBe('ignored');
    expect(await deliver('customers/redact', { customer: { id: 907 }, orders_to_redact: [7] }, shopB)).toBe('redacted');
    expect(await contactByPhone(`+9197${seed}7`, accountB)).toBeNull();
    expect((await events(accountB)).every((e) => e.payload.redacted)).toBe(true);
    expect(await deliver('shop/redact', { shop_domain: shopB }, shopB)).toBe('redacted');
    expect((await owner.query('SELECT shop_domain FROM shopify_stores WHERE account_id=$1', [accountB])).rows).toEqual([{ shop_domain: shopC }]);
    // At most one installed store per workspace, enforced by the database.
    await expect(owner.query("INSERT INTO shopify_stores(account_id,shop_domain,access_token_enc) VALUES($1,$2,'x')", [accountB, `it-d-${seed}.myshopify.com`]))
      .rejects.toThrow();
  });
});
