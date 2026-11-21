import { randomUUID } from 'node:crypto';
import { config } from 'dotenv';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// Store plan Phase 3 package 2 on PostgreSQL: the abandoned-cart reminder (queued when a
// session first gets items, sent once, never after an order, never to a blocked contact,
// never across workspaces) and the COD confirmation (pending on placement, buttons sent
// once, answered only by the order's own contact, replay-safe, a "no" does not cancel).
// Meta is never called: the engine senders are fakes.
const sends = vi.hoisted(() => ({ text: vi.fn(), template: vi.fn(), interactive: vi.fn() }));
vi.mock('@/lib/automations/meta-send', () => ({
  engineSendText: sends.text, engineSendTemplate: sends.template, engineSendInteractive: sends.interactive,
}));

import { disconnectDatabases, getPrisma, getWorkerPrisma } from '@/lib/db/prisma';
import { withTenant, type TenantContext, type TenantTransaction } from '@/lib/db/tenant';
import { handleAbandonedCartJob, handleCodConfirmJob, handleCodConfirmReply } from './cart-followup-jobs';
import { placeOrder } from './checkout';
import { saveNoticeTemplate } from './notice-templates';
import { listOrders } from './orders';
import { getStoreSettings, parseStoreSettings, saveStoreSettings } from './store-settings';
import { issueSessionTx, loadSession, quoteSessionTx, setAddressTx, setPaymentMethodTx, updateCartTx } from './storefront';

const configured = config({ path: '.env.test', quiet: true }).parsed;
const ownerUrl = process.env.TEST_DATABASE_URL;
const appUrl = process.env.TEST_APP_DATABASE_URL || configured?.DATABASE_URL;
const workerUrl = process.env.TEST_WORKER_DATABASE_URL || configured?.WORKER_DATABASE_URL;
if (appUrl) process.env.DATABASE_URL = appUrl;
if (workerUrl) process.env.WORKER_DATABASE_URL = workerUrl;
process.env.APP_URL ??= 'https://app.example.test';
process.env.ENCRYPTION_KEY ??= 'a'.repeat(64);

const account = randomUUID(), other = randomUUID(), owner = randomUUID(), admin = randomUUID(), agent = randomUUID();
const asAdmin: TenantContext & { userId: string } = { accountId: account, userId: admin, role: 'admin' };
const asAgent: TenantContext & { userId: string } = { accountId: account, userId: agent, role: 'agent' };
const product = randomUUID(), variant = randomUUID(), otherProduct = randomUUID(), otherVariant = randomUUID(), number = randomUUID(), otherNumber = randomUUID();
const names = ['buyer', 'blocked', 'optedOut', 'late', 'lateTemplate', 'cod', 'codTwo', 'codThree', 'stranger', 'otherShop'] as const;
const contacts = Object.fromEntries(names.map((n) => [n, randomUUID()])) as Record<(typeof names)[number], string>;
const conversations: Record<string, string> = {};
const meta = { attempts: 1, maxAttempts: 5 };
let db: pg.Client;

const worker = <T,>(fn: (tx: TenantTransaction) => Promise<T>) => withTenant({ accountId: account, role: 'owner' }, fn, getWorkerPrisma());
const otherWorker = <T,>(fn: (tx: TenantTransaction) => Promise<T>) => withTenant({ accountId: other, role: 'owner' }, fn, getWorkerPrisma());
const ADDRESS = { name: 'Test buyer', phone: '+919876543210', line1: '1 MG Road', city: 'Bengaluru', state: 'Karnataka', state_code: '29',
  postal_code: '560001', country: 'IN' };

const customerWrote = (contactId: string, ago = '1 minute') => db.query(
  `INSERT INTO messages(account_id,conversation_id,sender_type,content_type,content_text,created_at)
   VALUES($1,$2,'customer','text','hi', now() - $3::interval)`, [account, conversations[contactId], ago]);

/** An open shop session (the cart write queues the reminder when the store has a delay set). */
async function shopSession(contactId: string, ac = account, run = worker, line = variant) {
  const sessionId = randomUUID();
  await run((tx) => issueSessionTx(tx, ac, {
    sessionId, contactId, conversationId: null, whatsappConfigId: null, purpose: 'shop', orderId: null, ttlHours: 24, createdBy: null,
  }));
  await run((tx) => updateCartTx(tx, ac, sessionId, { expectedVersion: 1, lines: [{ variantId: line, qty: 1 }] }));
  return sessionId;
}

/** A COD order placed from a shop session. */
async function codOrder(contactId: string) {
  const sessionId = await shopSession(contactId);
  await worker((tx) => setAddressTx(tx, account, sessionId, { expectedVersion: 2, address: ADDRESS }));
  await worker((tx) => setPaymentMethodTx(tx, account, sessionId, { expectedVersion: 3, paymentMethod: 'cod' }));
  const quote = await worker(async (tx) => (await quoteSessionTx(tx, account, (await loadSession(tx, account, sessionId))!)).result);
  if (!quote.ok) throw new Error(`quote refused: ${quote.code}`);
  const placed = await placeOrder(account, sessionId, { expectedVersion: 4, expectedTotalMinor: quote.quote.totalMinor, clientRequestId: randomUUID() });
  return { sessionId, orderId: placed.orderId };
}

const session = async (id: string) => (await db.query(
  'SELECT reminded_at, reminder_skip FROM storefront_sessions WHERE id=$1', [id])).rows[0] as { reminded_at: Date | null; reminder_skip: string | null };
const job = async (type: string, key: string) => (await db.query('SELECT payload, run_at FROM jobs WHERE type=$1 AND dedupe_key=$2', [type, key])).rows;
const order = async (id: string) => (await db.query('SELECT status, cod_confirmation FROM orders WHERE id=$1', [id])).rows[0];
const events = async (id: string) => (await db.query(
  "SELECT kind FROM order_events WHERE order_id=$1 AND kind LIKE 'cod_customer_%' ORDER BY created_at", [id])).rows.map((r) => r.kind);
const ledger = async (id: string) => (await db.query(
  "SELECT status, reason FROM order_messages WHERE order_id=$1 AND kind='cod_confirm'", [id])).rows[0];
const setStore = (sql: string) => db.query(`UPDATE commerce_settings SET ${sql} WHERE account_id=$1`, [account]);

describe.skipIf(!ownerUrl || !appUrl || !workerUrl)('store phase 3 abandoned cart and COD confirmation on PostgreSQL', { timeout: 120_000 }, () => {
  beforeAll(async () => {
    db = new pg.Client({ connectionString: ownerUrl });
    await db.connect();
    if (!/test/i.test((await db.query('SELECT current_database() AS name')).rows[0].name)) throw new Error('Requires an isolated test database');
    const role = await getPrisma().$queryRaw<{ role: string }[]>`SELECT current_user AS role`;
    if (role[0].role !== 'bodhinox_app') throw new Error('Requires constrained test app credentials');
    await db.query("INSERT INTO auth_users(id,email,full_name,password_hash) SELECT x, x::text || '@example.invalid', 'P3 cart', 'test-only-hash' FROM unnest($1::uuid[]) x",
      [[owner, admin, agent]]);
    await db.query("INSERT INTO accounts(id,name,owner_user_id) VALUES($1,'P3 cart',$3),($2,'P3 other',$3)", [account, other, owner]);
    await db.query("INSERT INTO account_subscriptions(account_id,plan_id) VALUES($1,'basic'),($2,'basic')", [account, other]);
    await db.query("INSERT INTO account_memberships(account_id,user_id,role) VALUES($1,$2,'owner'),($1,$3,'admin'),($1,$4,'agent'),($5,$2,'owner')",
      [account, owner, admin, agent, other]);
    await db.query(`INSERT INTO whatsapp_config(id,account_id,user_id,phone_number_id,access_token,status,is_default)
      VALUES($1,$2,$3,$4,'test-token','connected',true),($5,$6,$3,$7,'test-token','connected',true)`,
    [number, account, owner, `pn-${account}`, otherNumber, other, `pn-${other}`]);
    for (const [i, key] of names.entries()) {
      const ac = key === 'otherShop' ? other : account;
      await db.query(`INSERT INTO contacts(id,account_id,user_id,name,phone,blocked_at,opted_out_at) VALUES($1,$2,$3,$4,$5,$6,$7)`,
        [contacts[key], ac, owner, `Buyer ${key}`, `+14155${String(i).padStart(5, '0')}`,
          key === 'blocked' ? new Date() : null, key === 'optedOut' ? new Date('2026-01-01T00:00:00Z') : null]);
      conversations[contacts[key]] = (await db.query(`INSERT INTO conversations(account_id,user_id,contact_id,whatsapp_config_id) VALUES($1,$2,$3,$4) RETURNING id`,
        [ac, owner, contacts[key], key === 'otherShop' ? otherNumber : number])).rows[0].id;
    }
    await db.query(`INSERT INTO commerce_settings(account_id,currency,prices_include_tax,default_tax_rate_bps,checkout_enabled,reservation_minutes,
        cod_enabled,cod_fee_minor,abandoned_cart_delay_minutes,cod_confirm_enabled)
      VALUES($1,'INR',true,1800,true,15,true,0,60,true),($2,'INR',true,1800,true,15,true,0,30,true)`, [account, other]);
    await db.query(`INSERT INTO shipping_rates(account_id,name,country,fee_minor) VALUES($1,'India','IN',5000),($2,'India','IN',5000)`, [account, other]);
    await db.query(`INSERT INTO shop_products(id,account_id,name,status,content_reviewed_at) VALUES($1,$2,'Tulsi drops','published',now())`, [product, account]);
    await db.query(`INSERT INTO shop_variants(id,account_id,product_id,sku,price_minor) VALUES($1,$2,$3,'TUL-60',49900)`, [variant, account, product]);
    await db.query(`INSERT INTO shop_products(id,account_id,name,status,content_reviewed_at) VALUES($1,$2,'Other drops','published',now())`, [otherProduct, other]);
    await db.query(`INSERT INTO shop_variants(id,account_id,product_id,sku,price_minor) VALUES($1,$2,$3,'OTH-1',9900)`, [otherVariant, other, otherProduct]);
    await db.query(`INSERT INTO inventory_levels(account_id,variant_id,on_hand) VALUES($1,$2,1000)`, [other, otherVariant]);
    await db.query(`INSERT INTO inventory_levels(account_id,variant_id,on_hand) VALUES($1,$2,1000)`, [account, variant]);
    for (const [name, category] of [['cart_offer', 'Marketing'], ['cod_ask', 'Utility']])
      await db.query(`INSERT INTO message_templates(account_id,user_id,name,language,category,status,body_text)
        VALUES($1,$2,$3,'en',$4,'APPROVED','Hi {{1}}, your order {{2}}')`, [account, owner, name, category]);
  });

  beforeEach(() => {
    sends.text.mockReset().mockResolvedValue({ whatsapp_message_id: 'wamid.text' });
    sends.template.mockReset().mockResolvedValue({ whatsapp_message_id: 'wamid.template' });
    sends.interactive.mockReset().mockResolvedValue({ whatsapp_message_id: 'wamid.buttons' });
  });

  afterAll(async () => {
    if (db) {
      await db.query('DELETE FROM outbound_intents WHERE account_id=ANY($1::uuid[])', [[account, other]]);
      await db.query('DELETE FROM jobs WHERE tenant_id=ANY($1::uuid[])', [[account, other]]);
      await db.query('DELETE FROM accounts WHERE id=ANY($1::uuid[])', [[account, other]]);
      await db.query('DELETE FROM auth_users WHERE id=ANY($1::uuid[])', [[owner, admin, agent]]);
      await db.end();
    }
    await disconnectDatabases();
  });

  it('lets an admin set the delay and the COD confirmation, and refuses an agent', async () => {
    const body = { currency: 'INR', prices_include_tax: true, default_tax_rate_bps: 1800, reservation_minutes: 15, checkout_enabled: true,
      low_stock_default: 5, document_prefix: 'RCPT', return_window_days: 7 };
    const saved = await saveStoreSettings(asAdmin, parseStoreSettings({ ...body, abandoned_cart_delay_minutes: 90, cod_confirm_enabled: false }));
    expect(saved).toMatchObject({ abandoned_cart_delay_minutes: 90, cod_confirm_enabled: false });
    // A client that does not send the fields keeps what is stored.
    expect(await saveStoreSettings(asAdmin, parseStoreSettings(body))).toMatchObject({ abandoned_cart_delay_minutes: 90, cod_confirm_enabled: false });
    await expect(saveStoreSettings(asAgent, parseStoreSettings({ ...body, abandoned_cart_delay_minutes: 30, cod_confirm_enabled: true }))).rejects.toThrow();
    expect(await getStoreSettings(asAgent)).toMatchObject({ abandoned_cart_delay_minutes: 90, cod_confirm_enabled: false });
    // The table refuses a delay outside 30..2880 even if code let it through; the app role cannot write the columns as an agent.
    await expect(db.query('UPDATE commerce_settings SET abandoned_cart_delay_minutes=10 WHERE account_id=$1', [account])).rejects.toThrow(/abandoned_delay_check/);
    await expect(withTenant(asAgent, (tx) => tx.$executeRaw`UPDATE commerce_settings SET cod_confirm_enabled=true WHERE account_id=${account}::uuid`)).resolves.toBe(0);
    expect((await db.query('SELECT cod_confirm_enabled FROM commerce_settings WHERE account_id=$1', [account])).rows[0].cod_confirm_enabled).toBe(false);
    await setStore('abandoned_cart_delay_minutes=60, cod_confirm_enabled=true');
  });

  it('queues one reminder when a session first gets items, and none when the store has the reminder off', async () => {
    const id = await shopSession(contacts.buyer);
    const [queued] = await job('commerce.abandoned_cart', `abandon:${id}`);
    expect(queued.payload).toEqual({ sessionId: id });
    const minutes = (new Date(queued.run_at).getTime() - Date.now()) / 60_000;
    expect(minutes).toBeGreaterThan(58);
    expect(minutes).toBeLessThan(61);
    // Changing the cart later does not queue a second one.
    await worker((tx) => updateCartTx(tx, account, id, { expectedVersion: 2, lines: [{ variantId: variant, qty: 3 }] }));
    expect(await job('commerce.abandoned_cart', `abandon:${id}`)).toHaveLength(1);
    // Off at that moment: nothing queued.
    await setStore('abandoned_cart_delay_minutes=NULL');
    const off = await shopSession(contacts.buyer);
    expect(await job('commerce.abandoned_cart', `abandon:${off}`)).toHaveLength(0);
    await setStore('abandoned_cart_delay_minutes=60');
  });

  it('sends the reminder once inside the window, and a replay or a rerun never sends again', async () => {
    const id = await shopSession(contacts.buyer);
    await customerWrote(contacts.buyer);
    expect(await handleAbandonedCartJob(account, { sessionId: id })).toBe('sent');
    expect(sends.text).toHaveBeenCalledTimes(1);
    expect(sends.text.mock.calls[0][0]).toMatchObject({ accountId: account, contactId: contacts.buyer, conversationId: conversations[contacts.buyer] });
    expect(sends.text.mock.calls[0][0].text).toContain(`${new URL(process.env.APP_URL!).origin}/shop/`);
    expect((await session(id)).reminded_at).not.toBeNull();
    // The job runs again: the session already has its reminder.
    expect(await handleAbandonedCartJob(account, { sessionId: id })).toBeNull();
    // A crash after the send but before the record: the accepted intent settles it without a second send.
    await db.query('UPDATE storefront_sessions SET reminded_at=NULL WHERE id=$1', [id]);
    expect(await handleAbandonedCartJob(account, { sessionId: id })).toBe('sent');
    expect(sends.text).toHaveBeenCalledTimes(1);
    expect((await session(id)).reminded_at).not.toBeNull();
  });

  it('links a shop session of an open, published shop to its themed checkout, and a password shop to /shop/<token>', async () => {
    const origin = new URL(process.env.APP_URL!).origin;
    const handle = `p3-${account.slice(0, 8)}`;
    await db.query("INSERT INTO shop_storefronts(account_id,handle,published) VALUES($1,$2,true)", [account, handle]);
    try {
      const open = await shopSession(contacts.buyer);
      await customerWrote(contacts.buyer);
      expect(await handleAbandonedCartJob(account, { sessionId: open })).toBe('sent');
      expect(sends.text.mock.calls[0][0].text).toMatch(new RegExp(`${origin}/s/${handle}/checkout/[A-Za-z0-9_-]{43}`));

      await db.query("UPDATE shop_storefronts SET access_mode='password' WHERE account_id=$1", [account]);
      const locked = await shopSession(contacts.buyer);
      expect(await handleAbandonedCartJob(account, { sessionId: locked })).toBe('sent');
      expect(sends.text.mock.calls[1][0].text).toContain(`${origin}/shop/`);
      expect(sends.text.mock.calls[1][0].text).not.toContain(`/s/${handle}/`);
    } finally {
      await db.query('DELETE FROM shop_storefronts WHERE account_id=$1', [account]);
    }
  });

  it('records an uncertain send for staff and never repeats it', async () => {
    const id = await shopSession(contacts.buyer);
    sends.text.mockRejectedValueOnce(new Error('socket hang up'));
    expect(await handleAbandonedCartJob(account, { sessionId: id })).toBe('outcome_unknown');
    expect(await session(id)).toMatchObject({ reminded_at: null, reminder_skip: 'outcome_unknown' });
    await handleAbandonedCartJob(account, { sessionId: id });
    expect(sends.text).toHaveBeenCalledTimes(1);
  });

  it('does not send after the order was placed, nor to a blocked or opted-out contact', async () => {
    const placed = await codOrder(contacts.codTwo);
    await customerWrote(contacts.codTwo);
    expect(await handleAbandonedCartJob(account, { sessionId: placed.sessionId })).toBe('order_placed');
    expect((await session(placed.sessionId)).reminded_at).toBeNull();

    const blocked = await shopSession(contacts.blocked);
    await customerWrote(contacts.blocked);
    expect(await handleAbandonedCartJob(account, { sessionId: blocked })).toBe('contact_blocked');
    const optedOut = await shopSession(contacts.optedOut);
    await customerWrote(contacts.optedOut);
    expect(await handleAbandonedCartJob(account, { sessionId: optedOut })).toBe('opted_out');
    expect(await session(blocked)).toMatchObject({ reminded_at: null, reminder_skip: 'contact_blocked' });
    // The reminder is switched off before it is due, or the store closed: skipped with a code.
    const closed = await shopSession(contacts.buyer);
    await setStore('abandoned_cart_delay_minutes=NULL');
    expect(await handleAbandonedCartJob(account, { sessionId: closed })).toBe('disabled');
    await setStore('abandoned_cart_delay_minutes=60');
    expect(sends.text).not.toHaveBeenCalled();
    expect(sends.template).not.toHaveBeenCalled();
  });

  it('never touches another workspace\'s session, whichever workspace runs the job', async () => {
    const theirs = await shopSession(contacts.otherShop, other, otherWorker, otherVariant);
    await db.query(`INSERT INTO messages(account_id,conversation_id,sender_type,content_type,content_text) VALUES($1,$2,'customer','text','hi')`,
      [other, conversations[contacts.otherShop]]);
    // Their session (queued by their own 30 minute setting) is invisible to our workspace's job.
    expect(await job('commerce.abandoned_cart', `abandon:${theirs}`)).toHaveLength(1);
    expect(await handleAbandonedCartJob(account, { sessionId: theirs })).toBeNull();
    expect((await session(theirs)).reminded_at).toBeNull();
    expect(sends.text).not.toHaveBeenCalled();
    // Run by its own workspace it is sent, to its own contact and conversation.
    expect(await handleAbandonedCartJob(other, { sessionId: theirs })).toBe('sent');
    expect(sends.text.mock.calls[0][0]).toMatchObject({ accountId: other, contactId: contacts.otherShop });
  });

  it('outside the window sends only an approved marketing template, and records why when none is set', async () => {
    const noTemplate = await shopSession(contacts.late);
    await customerWrote(contacts.late, '2 days');
    expect(await handleAbandonedCartJob(account, { sessionId: noTemplate })).toBe('no_template');
    expect(await session(noTemplate)).toMatchObject({ reminded_at: null, reminder_skip: 'no_template' });
    expect(sends.text).not.toHaveBeenCalled();

    // A utility template cannot be chosen for the marketing reminder; an admin picks the marketing one.
    await expect(saveNoticeTemplate(asAdmin, { kind: 'abandoned_cart', template: { name: 'cod_ask', language: 'en' } })).rejects.toMatchObject({ code: 'wrong_category' });
    await saveNoticeTemplate(asAdmin, { kind: 'abandoned_cart', template: { name: 'cart_offer', language: 'en' } });
    const withTemplate = await shopSession(contacts.lateTemplate);
    await customerWrote(contacts.lateTemplate, '2 days');
    expect(await handleAbandonedCartJob(account, { sessionId: withTemplate })).toBe('sent');
    expect(sends.template).toHaveBeenCalledTimes(1);
    const args = sends.template.mock.calls[0][0];
    expect(args).toMatchObject({ templateName: 'cart_offer', contactId: contacts.lateTemplate });
    expect(args.params[1]).toContain(`${new URL(process.env.APP_URL!).origin}/shop/`);
    expect(sends.text).not.toHaveBeenCalled();
  });

  it('marks a COD order pending and queues the confirmation only when the store asks', async () => {
    const asked = await codOrder(contacts.cod);
    expect((await order(asked.orderId)).cod_confirmation).toBe('pending');
    expect(await job('commerce.cod_confirm', `cod_confirm:${asked.orderId}`)).toEqual([expect.objectContaining({ payload: { orderId: asked.orderId } })]);

    await setStore('cod_confirm_enabled=false');
    const notAsked = await codOrder(contacts.codThree);
    expect((await order(notAsked.orderId)).cod_confirmation).toBeNull();
    expect(await job('commerce.cod_confirm', `cod_confirm:${notAsked.orderId}`)).toHaveLength(0);
    await setStore('cod_confirm_enabled=true');
    // The priced-order freeze does not stop the worker from writing the answer later.
    await expect(worker((tx) => tx.$executeRaw`UPDATE orders SET cod_confirmation='pending' WHERE id=${notAsked.orderId}::uuid`)).resolves.toBe(1);
    await expect(db.query("UPDATE orders SET cod_confirmation='maybe' WHERE id=$1", [asked.orderId])).rejects.toThrow(/cod_confirmation_check/);
  });

  it('sends the Yes / Cancel buttons once inside the window, with ids that name the order', async () => {
    const { orderId } = await codOrder(contacts.cod);
    await customerWrote(contacts.cod);
    expect(await handleCodConfirmJob(account, { orderId }, meta)).toEqual({ status: 'sent', reason: null });
    expect(sends.interactive).toHaveBeenCalledTimes(1);
    const payload = sends.interactive.mock.calls[0][0].payload;
    expect(payload.buttons.map((b: { id: string }) => b.id)).toEqual([`codc:${orderId}:yes`, `codc:${orderId}:no`]);
    expect(payload.buttons.every((b: { title: string }) => b.title.length <= 20)).toBe(true);
    expect(await ledger(orderId)).toEqual({ status: 'sent', reason: null });
    // A rerun of the job sends nothing more.
    expect(await handleCodConfirmJob(account, { orderId }, meta)).toBeNull();
    expect(sends.interactive).toHaveBeenCalledTimes(1);
  });

  it('outside the window leaves the order pending: blocked without a UTILITY template, a template send with one', async () => {
    const { orderId } = await codOrder(contacts.late);
    expect(await handleCodConfirmJob(account, { orderId }, meta)).toEqual({ status: 'blocked', reason: 'no_template' });
    expect((await order(orderId)).cod_confirmation).toBe('pending');
    expect(sends.interactive).not.toHaveBeenCalled();
    await saveNoticeTemplate(asAdmin, { kind: 'cod_confirm', template: { name: 'cod_ask', language: 'en' } });
    // A blocked ledger row is not final: the job can run again once a template is set.
    expect(await handleCodConfirmJob(account, { orderId }, meta)).toEqual({ status: 'sent', reason: null });
    expect(sends.template).toHaveBeenCalledTimes(1);
    expect(sends.template.mock.calls[0][0]).toMatchObject({ templateName: 'cod_ask', serviceMessage: true });
    expect((await order(orderId)).cod_confirmation).toBe('pending');
  });

  it('records a Yes from the order\'s own contact once; a replay and a later No change nothing', async () => {
    const { orderId } = await codOrder(contacts.cod);
    const tap = (replyId: string, contactId = contacts.cod, accountId = account) => handleCodConfirmReply({
      accountId, contactId, conversationId: conversations[contactId], replyId });
    // Someone else in the same workspace, and the same id from another workspace: ignored, falls through.
    expect(await tap(`codc:${orderId}:yes`, contacts.stranger)).toEqual({ handled: false, outcome: 'ignored' });
    expect(await tap(`codc:${orderId}:yes`, contacts.otherShop, other)).toEqual({ handled: false, outcome: 'ignored' });
    expect(await tap('qr_' + randomUUID())).toEqual({ handled: false, outcome: 'ignored' });
    expect(await tap(`codc:${randomUUID()}:yes`)).toEqual({ handled: false, outcome: 'ignored' });
    expect((await order(orderId)).cod_confirmation).toBe('pending');
    expect(sends.text).not.toHaveBeenCalled();

    expect(await tap(`codc:${orderId}:yes`)).toEqual({ handled: true, outcome: 'confirmed' });
    expect(await order(orderId)).toEqual({ status: 'confirmed', cod_confirmation: 'confirmed' });
    expect(await events(orderId)).toEqual(['cod_customer_confirmed']);
    expect(sends.text).toHaveBeenCalledTimes(1);
    expect(sends.text.mock.calls[0][0]).toMatchObject({ contactId: contacts.cod, serviceMessage: true });
    // The webhook is delivered again: handled, but neither the answer nor the thank-you is repeated.
    expect(await tap(`codc:${orderId}:yes`)).toEqual({ handled: true, outcome: 'confirmed' });
    expect(sends.text).toHaveBeenCalledTimes(1);
    expect(await events(orderId)).toEqual(['cod_customer_confirmed']);
    // A contradicting tap after the answer is ignored.
    expect(await tap(`codc:${orderId}:no`)).toEqual({ handled: false, outcome: 'ignored' });
    expect((await order(orderId)).cod_confirmation).toBe('confirmed');
  });

  it('records a No as declined without cancelling the order, and shows it to staff in the list', async () => {
    const { orderId } = await codOrder(contacts.codTwo);
    const result = await handleCodConfirmReply({ accountId: account, contactId: contacts.codTwo, conversationId: conversations[contacts.codTwo],
      replyId: `codc:${orderId}:no` });
    expect(result).toEqual({ handled: true, outcome: 'declined' });
    expect(await order(orderId)).toEqual({ status: 'confirmed', cod_confirmation: 'declined' });
    expect(await events(orderId)).toEqual(['cod_customer_declined']);
    // Stock stays held until staff decide.
    expect((await db.query("SELECT status FROM stock_reservations WHERE order_id=$1", [orderId])).rows).toEqual([{ status: 'held' }]);

    const declined = await listOrders(asAgent, { codConfirmation: 'declined' });
    expect(declined.orders.map((o) => o.id)).toContain(orderId);
    expect(declined.orders.every((o) => o.cod_confirmation === 'declined')).toBe(true);
    const pending = await listOrders(asAgent, { codConfirmation: 'pending' });
    expect(pending.orders.map((o) => o.id)).not.toContain(orderId);
    expect(pending.orders.every((o) => o.cod_confirmation === 'pending')).toBe(true);
  });

  it('keeps a confirmation answer out of an agent\'s hands and another workspace\'s sight', async () => {
    const { orderId } = await codOrder(contacts.codThree);
    await expect(withTenant(asAgent, (tx) => tx.$executeRaw`UPDATE orders SET cod_confirmation='confirmed' WHERE id=${orderId}::uuid`)).rejects.toThrow();
    await expect(withTenant(asAdmin, (tx) => tx.$executeRaw`UPDATE orders SET cod_confirmation='confirmed' WHERE id=${orderId}::uuid`)).rejects.toThrow();
    expect((await order(orderId)).cod_confirmation).toBe('pending');
    const theirs = await listOrders({ accountId: other, userId: owner, role: 'admin' }, { codConfirmation: 'pending' });
    expect(theirs.orders.map((o) => o.id)).not.toContain(orderId);
  });
});
