import { randomUUID } from 'node:crypto';
import { config } from 'dotenv';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// Phase 9 follow-up completion (design D13, §9 test 6) on PostgreSQL: the
// reorder reminder needs the order's explicit checkout opt-in, a contact who
// never opted out, and an approved MARKETING template; the other notices use
// the workspace's UTILITY template outside the window and the courier link
// inside it. Meta is never called: the engine senders are fakes.
const sends = vi.hoisted(() => ({ text: vi.fn(), template: vi.fn() }));
vi.mock('@/lib/automations/meta-send', () => ({ engineSendText: sends.text, engineSendTemplate: sends.template }));

import { disconnectDatabases, getPrisma, getWorkerPrisma } from '@/lib/db/prisma';
import { withTenant, type TenantContext, type TenantTransaction } from '@/lib/db/tenant';
import { placeOrder } from './checkout';
import { MARKETING_OPT_IN_VERSION } from './marketing-consent';
import { getNoticeTemplates, saveNoticeTemplate } from './notice-templates';
import { handleOrderFollowupJob, repeatPurchaseDueAt } from './order-followup';
import { recordWhatsAppOrder } from './orders';
import { issueSessionTx, loadSession, quoteSessionTx, setAddressTx, updateCartTx } from './storefront';

const configured = config({ path: '.env.test', quiet: true }).parsed;
const ownerUrl = process.env.TEST_DATABASE_URL;
const appUrl = process.env.TEST_APP_DATABASE_URL || configured?.DATABASE_URL;
const workerUrl = process.env.TEST_WORKER_DATABASE_URL || configured?.WORKER_DATABASE_URL;
if (appUrl) process.env.DATABASE_URL = appUrl;
if (workerUrl) process.env.WORKER_DATABASE_URL = workerUrl;
process.env.APP_URL ??= 'https://app.example.test';
process.env.ENCRYPTION_KEY ??= 'a'.repeat(64);

const account = randomUUID(), owner = randomUUID(), admin = randomUUID(), agent = randomUUID();
const asAdmin: TenantContext & { userId: string } = { accountId: account, userId: admin, role: 'admin' };
const asAgent: TenantContext & { userId: string } = { accountId: account, userId: agent, role: 'agent' };
const product = randomUUID(), variant = randomUUID(), number = randomUUID(), connection = randomUUID();
const contacts = { buyer: randomUUID(), optedOut: randomUUID(), shop: randomUUID(), cart: randomUUID(), plain: randomUUID(), paused: randomUUID() };
const conversations: Record<string, string> = {};
const meta = { attempts: 1, maxAttempts: 5 };
let db: pg.Client;

const worker = <T,>(fn: (tx: TenantTransaction) => Promise<T>) => withTenant({ accountId: account, role: 'owner' }, fn, getWorkerPrisma());
const ADDRESS = { name: 'Test buyer', phone: '+919876543210', line1: '1 MG Road', city: 'Bengaluru', state: 'Karnataka', state_code: '29',
  postal_code: '560001', country: 'IN' };

/** A delivered (fulfilled) storefront order with one line of the reorderable product. */
async function deliveredOrder(contactId: string, optIn: boolean | null, status = 'fulfilled') {
  const id = randomUUID();
  await db.query(`INSERT INTO orders(id,account_id,source,contact_id,conversation_id,whatsapp_config_id,currency,subtotal_minor,shipping_minor,
      tax_minor,tax_inclusive,total_minor,status,priced_at,paid_at,amount_paid_minor,marketing_opt_in,marketing_opt_in_at,marketing_opt_in_version)
    VALUES($1,$2,'storefront',$3,$4,$5,'INR',49900,0,0,true,49900,$6,now() - interval '40 days',now() - interval '40 days',49900,$7,
      CASE WHEN $7::boolean IS NULL THEN NULL ELSE now() - interval '40 days' END, CASE WHEN $7::boolean IS NULL THEN NULL ELSE $8 END)`,
  [id, account, contactId, conversations[contactId], number, status, optIn, MARKETING_OPT_IN_VERSION]);
  await db.query(`INSERT INTO order_items(account_id,order_id,variant_id,sku,name,quantity,unit_price_minor,currency,line_total_minor)
    VALUES($1,$2,$3,'TUL-60','Tulsi drops',1,49900,'INR',49900)`, [account, id, variant]);
  return id;
}

const ledger = async (orderId: string, kind: string) => (await db.query(
  'SELECT status, reason FROM order_messages WHERE account_id=$1 AND order_id=$2 AND kind=$3', [account, orderId, kind])).rows[0];
const customerWrote = (contactId: string) => db.query(`INSERT INTO messages(account_id,conversation_id,sender_type,content_type,content_text)
  VALUES($1,$2,'customer','text','hi')`, [account, conversations[contactId]]);
const template = (name: string, category: string, status = 'APPROVED') => db.query(
  `INSERT INTO message_templates(account_id,user_id,name,language,category,status,body_text) VALUES($1,$2,$3,'en',$4,$5,'Hi {{1}}, time for more {{2}}?')`,
  [account, owner, name, category, status]);

async function shopSession(contactId: string) {
  const sessionId = randomUUID();
  await worker((tx) => issueSessionTx(tx, account, {
    sessionId, contactId, conversationId: null, whatsappConfigId: null, purpose: 'shop', orderId: null, ttlHours: 24, createdBy: null,
  }));
  await worker((tx) => updateCartTx(tx, account, sessionId, { expectedVersion: 1, lines: [{ variantId: variant, qty: 1 }] }));
  await worker((tx) => setAddressTx(tx, account, sessionId, { expectedVersion: 2, address: ADDRESS }));
  const quote = await worker(async (tx) => (await quoteSessionTx(tx, account, (await loadSession(tx, account, sessionId))!)).result);
  if (!quote.ok) throw new Error(`quote refused: ${quote.code}`);
  return { sessionId, version: 3, total: quote.quote.totalMinor };
}

const optInOf = async (orderId: string) => (await db.query(
  'SELECT marketing_opt_in, marketing_opt_in_version, marketing_opt_in_at IS NOT NULL AS stamped FROM orders WHERE id=$1', [orderId])).rows[0];

describe.skipIf(!ownerUrl || !appUrl || !workerUrl)('phase 9 repeat purchase and notice templates on PostgreSQL', { timeout: 120_000 }, () => {
  beforeAll(async () => {
    db = new pg.Client({ connectionString: ownerUrl });
    await db.connect();
    if (!/test/i.test((await db.query('SELECT current_database() AS name')).rows[0].name)) throw new Error('Requires an isolated test database');
    const role = await getPrisma().$queryRaw<{ role: string }[]>`SELECT current_user AS role`;
    if (role[0].role !== 'bodhinox_app') throw new Error('Requires constrained test app credentials');
    const users = [owner, admin, agent];
    await db.query("INSERT INTO auth_users(id,email,full_name,password_hash) SELECT x, x::text || '@example.invalid', 'P9 repeat', 'test-only-hash' FROM unnest($1::uuid[]) x", [users]);
    await db.query("INSERT INTO accounts(id,name,owner_user_id) VALUES($1,'P9 repeat',$2)", [account, owner]);
    await db.query("INSERT INTO account_subscriptions(account_id,plan_id) VALUES($1,'basic')", [account]);
    await db.query("INSERT INTO account_memberships(account_id,user_id,role) VALUES($1,$2,'owner'),($1,$3,'admin'),($1,$4,'agent')", [account, owner, admin, agent]);
    await db.query(`INSERT INTO whatsapp_config(id,account_id,user_id,phone_number_id,access_token,status,is_default)
      VALUES($1,$2,$3,$4,'test-token','connected',true)`, [number, account, owner, `pn-${account}`]);
    for (const [key, id] of Object.entries(contacts)) {
      await db.query(`INSERT INTO contacts(id,account_id,user_id,name,phone,opted_out_at) VALUES($1,$2,$3,$4,$5,$6)`,
        [id, account, owner, `Buyer ${key}`, `+14155${String(Object.keys(contacts).indexOf(key)).padStart(5, '0')}`,
          key === 'optedOut' ? new Date('2026-01-01T00:00:00Z') : null]);
      conversations[id] = (await db.query(`INSERT INTO conversations(account_id,user_id,contact_id,whatsapp_config_id) VALUES($1,$2,$3,$4) RETURNING id`,
        [account, owner, id, number])).rows[0].id;
    }
    await db.query(`INSERT INTO commerce_settings(account_id,currency,prices_include_tax,default_tax_rate_bps,checkout_enabled,reservation_minutes)
      VALUES($1,'INR',true,1800,true,15)`, [account]);
    // Online checkout needs a Razorpay connection (a link can be made); the link job never runs here.
    await db.query(`INSERT INTO payment_providers(account_id,provider,mode,key_id,key_secret_enc) VALUES($1,'razorpay','test','rzp_test_SHOP','enc')`, [account]);
    await db.query(`INSERT INTO shipping_rates(account_id,name,country,fee_minor) VALUES($1,'India','IN',5000)`, [account]);
    await db.query(`INSERT INTO shop_products(id,account_id,name,status,content_reviewed_at,repurchase_after_days)
      VALUES($1,$2,'Tulsi drops','published',now(),30)`, [product, account]);
    await db.query(`INSERT INTO shop_variants(id,account_id,product_id,sku,price_minor) VALUES($1,$2,$3,'TUL-60',49900)`, [variant, account, product]);
    await db.query(`INSERT INTO inventory_levels(account_id,variant_id,on_hand) VALUES($1,$2,100)`, [account, variant]);
    await template('reorder_offer', 'Marketing');
    await template('order_update', 'Utility');
  });

  beforeEach(() => {
    sends.text.mockReset().mockResolvedValue({ whatsapp_message_id: 'wamid.text' });
    sends.template.mockReset().mockResolvedValue({ whatsapp_message_id: 'wamid.template' });
  });

  afterAll(async () => {
    if (db) {
      await db.query('DELETE FROM outbound_intents WHERE account_id=$1', [account]);
      await db.query('DELETE FROM jobs WHERE tenant_id=$1', [account]);
      await db.query('DELETE FROM accounts WHERE id=$1', [account]);
      await db.query('DELETE FROM auth_users WHERE id=ANY($1::uuid[])', [[owner, admin, agent]]);
      await db.end();
    }
    await disconnectDatabases();
  });

  it('records the opt-in on storefront checkout: ticked, unticked, or unknown from an older client', async () => {
    const sessions = [await shopSession(contacts.shop), await shopSession(contacts.optedOut), await shopSession(contacts.cart)];
    const [yes, no, unknown] = await Promise.all(sessions.map((s, i) => placeOrder(account, s.sessionId, {
      expectedVersion: s.version, expectedTotalMinor: s.total, clientRequestId: randomUUID(),
      ...(i === 0 ? { marketingOptIn: true } : i === 1 ? { marketingOptIn: false } : {}),
    })));
    expect(await optInOf(yes.orderId)).toEqual({ marketing_opt_in: true, marketing_opt_in_version: MARKETING_OPT_IN_VERSION, stamped: true });
    expect(await optInOf(no.orderId)).toEqual({ marketing_opt_in: false, marketing_opt_in_version: MARKETING_OPT_IN_VERSION, stamped: true });
    expect(await optInOf(unknown.orderId)).toEqual({ marketing_opt_in: null, marketing_opt_in_version: null, stamped: false });
    // Once priced, the consent evidence cannot be rewritten.
    await expect(worker((tx) => tx.$executeRaw`UPDATE orders SET marketing_opt_in=true WHERE id=${no.orderId}::uuid`)).rejects.toThrow();
    // A non-boolean opt-in is refused before any work.
    const s = await shopSession(contacts.plain);
    await expect(placeOrder(account, s.sessionId, { expectedVersion: s.version, expectedTotalMinor: s.total, clientRequestId: randomUUID(),
      marketingOptIn: 'yes' as never })).rejects.toMatchObject({ code: 'invalid' });
  });

  it('records the opt-in on WhatsApp-cart checkout, in the update that prices the order', async () => {
    const orderId = randomUUID();
    await worker((tx) => recordWhatsAppOrder(tx, {
      accountId: account, orderId, metaMessageId: `wamid.${randomUUID()}`, contactId: contacts.cart, conversationId: conversations[contacts.cart],
      whatsappConfigId: null,
      order: { catalog_id: null, currency: 'INR', subtotal_minor: 1, note: null, items: [{ retailer_id: 'TUL-60', name: null, quantity: 1, unit_price_minor: 1 }] },
    }));
    const sessionId = randomUUID();
    await worker((tx) => issueSessionTx(tx, account, {
      sessionId, contactId: contacts.cart, conversationId: conversations[contacts.cart], whatsappConfigId: null, purpose: 'order', orderId,
      ttlHours: 24, createdBy: null,
    }));
    await worker((tx) => setAddressTx(tx, account, sessionId, { expectedVersion: 1, address: ADDRESS }));
    const quote = await worker(async (tx) => (await quoteSessionTx(tx, account, (await loadSession(tx, account, sessionId))!)).result);
    if (!quote.ok) throw new Error(`quote refused: ${quote.code}`);
    await placeOrder(account, sessionId, { expectedVersion: 2, expectedTotalMinor: quote.quote.totalMinor, clientRequestId: randomUUID(),
      marketingOptIn: true });
    expect(await optInOf(orderId)).toEqual({ marketing_opt_in: true, marketing_opt_in_version: MARKETING_OPT_IN_VERSION, stamped: true });
  });

  it('refuses the reorder reminder without explicit consent, or to a contact who ever opted out', async () => {
    const unknown = await deliveredOrder(contacts.buyer, null);
    const declined = await deliveredOrder(contacts.buyer, false);
    const optedOut = await deliveredOrder(contacts.optedOut, true);
    expect(await handleOrderFollowupJob(account, { orderId: unknown, kind: 'repeat_purchase' }, meta))
      .toEqual({ status: 'skipped', reason: 'no_marketing_consent' });
    expect(await handleOrderFollowupJob(account, { orderId: declined, kind: 'repeat_purchase' }, meta))
      .toEqual({ status: 'skipped', reason: 'no_marketing_consent' });
    // The opt-out predates the purchase: an order notice would still go, a marketing reminder never.
    expect(await handleOrderFollowupJob(account, { orderId: optedOut, kind: 'repeat_purchase' }, meta))
      .toEqual({ status: 'skipped', reason: 'opted_out' });
    expect(await ledger(unknown, 'repeat_purchase')).toEqual({ status: 'skipped', reason: 'no_marketing_consent' });
    expect(sends.template).not.toHaveBeenCalled();
    expect(sends.text).not.toHaveBeenCalled();
  });

  it('only an admin sets a notice template, and only of the kind\'s category', async () => {
    await expect(saveNoticeTemplate(asAdmin, { kind: 'repeat_purchase', template: { name: 'order_update', language: 'en' } }))
      .rejects.toMatchObject({ code: 'wrong_category' });
    await expect(saveNoticeTemplate(asAdmin, { kind: 'delivered', template: { name: 'reorder_offer', language: 'en' } }))
      .rejects.toMatchObject({ code: 'wrong_category' });
    await expect(saveNoticeTemplate(asAdmin, { kind: 'delivered', template: { name: 'missing', language: 'en' } }))
      .rejects.toMatchObject({ code: 'template_not_found' });
    await expect(saveNoticeTemplate(asAgent, { kind: 'delivered', template: { name: 'order_update', language: 'en' } })).rejects.toThrow();
    const view = await getNoticeTemplates(asAgent);
    expect(view.settings.every((s) => s.template_name === null)).toBe(true);
    expect(view.options.map((o) => `${o.name}:${o.category}`).sort()).toEqual(['order_update:UTILITY', 'reorder_offer:MARKETING']);
    const audits = (await db.query("SELECT count(*)::int AS n FROM audit_logs WHERE account_id=$1 AND action='commerce.notice_template_updated'", [account])).rows[0];
    expect(audits.n).toBe(0);
  });

  it('sends one reorder reminder with consent and a MARKETING template, never as free text', async () => {
    const order = await deliveredOrder(contacts.buyer, true);
    // No template yet: blocked even though nothing else refuses.
    expect(await handleOrderFollowupJob(account, { orderId: order, kind: 'repeat_purchase' }, meta)).toEqual({ status: 'blocked', reason: 'no_template' });
    // A UTILITY template placed behind the API's back is refused at send time.
    await db.query(`INSERT INTO order_notice_templates(account_id,kind,template_name,language) VALUES($1,'repeat_purchase','order_update','en')`, [account]);
    expect(await handleOrderFollowupJob(account, { orderId: order, kind: 'repeat_purchase' }, meta)).toEqual({ status: 'blocked', reason: 'category' });
    await saveNoticeTemplate(asAdmin, { kind: 'repeat_purchase', template: { name: 'reorder_offer', language: 'en' } });
    // The customer window is open, yet the reminder still goes as the reviewed marketing template.
    await customerWrote(contacts.buyer);
    expect(await handleOrderFollowupJob(account, { orderId: order, kind: 'repeat_purchase' }, meta)).toEqual({ status: 'sent', reason: null });
    expect(await handleOrderFollowupJob(account, { orderId: order, kind: 'repeat_purchase' }, meta)).toBeNull();
    expect(sends.text).not.toHaveBeenCalled();
    expect(sends.template).toHaveBeenCalledTimes(1);
    const args = sends.template.mock.calls[0][0];
    expect(args).toMatchObject({ templateName: 'reorder_offer', language: 'en', params: ['Buyer buyer', 'Tulsi drops'] });
    expect(args.serviceMessage).toBeUndefined();
    expect(await ledger(order, 'repeat_purchase')).toEqual({ status: 'sent', reason: null });
    const audit = (await db.query("SELECT metadata FROM audit_logs WHERE account_id=$1 AND action='commerce.notice_template_updated'", [account])).rows;
    expect(audit).toEqual([{ metadata: { kind: 'repeat_purchase', cleared: false } }]);
  });

  it('an agent takeover holds the reorder reminder back before any outbound intent, while order notices still go', async () => {
    const setNotice = (kind: string, name: string) => db.query(`INSERT INTO order_notice_templates(account_id,kind,template_name,language)
      VALUES($1,$2,$3,'en') ON CONFLICT(account_id,kind) DO UPDATE SET template_name=EXCLUDED.template_name`, [account, kind, name]);
    await setNotice('repeat_purchase', 'reorder_offer');
    await setNotice('delivered', 'order_update');
    await db.query('UPDATE conversations SET bot_paused=true WHERE id=$1', [conversations[contacts.paused]]);
    const order = await deliveredOrder(contacts.paused, true);
    const intents = async (kind: string) => (await db.query('SELECT count(*)::int AS n FROM outbound_intents WHERE account_id=$1 AND idempotency_key=$2',
      [account, `${account}:order:${order}:${kind}`])).rows[0].n;
    expect(await handleOrderFollowupJob(account, { orderId: order, kind: 'repeat_purchase' }, meta)).toEqual({ status: 'blocked', reason: 'bot_paused' });
    expect(await ledger(order, 'repeat_purchase')).toEqual({ status: 'blocked', reason: 'bot_paused' });
    expect(await intents('repeat_purchase')).toBe(0);
    expect(sends.template).not.toHaveBeenCalled();
    // A service notice is not held back by the takeover.
    expect(await handleOrderFollowupJob(account, { orderId: order, kind: 'delivered' }, meta)).toEqual({ status: 'sent', reason: null });
    expect(sends.template).toHaveBeenCalledWith(expect.objectContaining({ templateName: 'order_update', serviceMessage: true }));
    await db.query('UPDATE conversations SET bot_paused=false WHERE id=$1', [conversations[contacts.paused]]);
    // The later notice test starts with no delivered template.
    await db.query("DELETE FROM order_notice_templates WHERE account_id=$1 AND kind='delivered'", [account]);
  });

  it('a refunded or undelivered order gets no reorder reminder', async () => {
    const dispatched = await deliveredOrder(contacts.buyer, true, 'dispatched');
    expect(await handleOrderFollowupJob(account, { orderId: dispatched, kind: 'repeat_purchase' }, meta))
      .toEqual({ status: 'skipped', reason: 'stale_status' });
  });

  it('dates the reminder from delivery by the shortest repurchase interval', async () => {
    const order = await deliveredOrder(contacts.plain, true);
    const deliveredAt = new Date('2026-11-01T10:00:00Z');
    expect(await worker((tx) => repeatPurchaseDueAt(tx, account, order, deliveredAt))).toEqual(new Date('2026-12-01T10:00:00Z'));
    await db.query('UPDATE shop_products SET repurchase_after_days=NULL WHERE id=$1', [product]);
    expect(await worker((tx) => repeatPurchaseDueAt(tx, account, order, deliveredAt))).toBeNull();
    await db.query('UPDATE shop_products SET repurchase_after_days=30 WHERE id=$1', [product]);
  });

  it('order notices use the UTILITY template outside the window and the courier link inside it', async () => {
    const delivered = await deliveredOrder(contacts.plain, null);
    expect(await handleOrderFollowupJob(account, { orderId: delivered, kind: 'delivered' }, meta)).toEqual({ status: 'blocked', reason: 'no_template' });
    const other = await deliveredOrder(contacts.plain, null);
    await saveNoticeTemplate(asAdmin, { kind: 'delivered', template: { name: 'order_update', language: 'en' } });
    expect(await handleOrderFollowupJob(account, { orderId: other, kind: 'delivered' }, meta)).toEqual({ status: 'sent', reason: null });
    expect(sends.template).toHaveBeenCalledWith(expect.objectContaining({ templateName: 'order_update', serviceMessage: true }));

    const dispatched = await deliveredOrder(contacts.plain, null, 'dispatched');
    await db.query(`INSERT INTO courier_connections(id,account_id,api_email) VALUES($1,$2,'api@example.invalid')`, [connection, account]);
    await db.query(`INSERT INTO order_shipments(account_id,order_id,connection_id,reference,create_state,awb_state,awb,length_cm,breadth_cm,height_cm,weight_grams)
      VALUES($1,$2,$3,'bxabcdef123456','created','assigned','AWB12345',10,10,10,500)`, [account, dispatched, connection]);
    await customerWrote(contacts.plain);
    expect(await handleOrderFollowupJob(account, { orderId: dispatched, kind: 'dispatched' }, meta)).toEqual({ status: 'sent', reason: null });
    expect(sends.text).toHaveBeenCalledTimes(1);
    expect(sends.text.mock.calls[0][0].text).toContain('https://shiprocket.co/tracking/AWB12345');
  });
});
