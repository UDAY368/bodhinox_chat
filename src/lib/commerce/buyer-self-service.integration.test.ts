import { randomUUID } from 'node:crypto';
import { config } from 'dotenv';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// Store plan Phase 8, batch 5 on PostgreSQL: a buyer's return and exchange requests from the order page (identified by the
// session token, one open request per line, idempotent, staff approve before anything else happens), checkout extras on the
// order, the contact-based one-tap repeat, and the wishlist price-drop nudge (consent, window and template rules, once per
// drop, an uncertain send never repeated). Meta is never called: the engine senders are fakes.
const sends = vi.hoisted(() => ({ text: vi.fn(), template: vi.fn() }));
vi.mock('@/lib/automations/meta-send', () => ({ engineSendText: sends.text, engineSendTemplate: sends.template }));

import { POST as returnsRoute } from '@/app/api/public/shop/[token]/returns/route';
import { GET as wishlistGet, POST as wishlistPost } from '@/app/api/public/shop/[token]/wishlist/route';
import { PUT as extrasRoute } from '@/app/api/public/shop/[token]/extras/route';
import { PUT as repeatRoute } from '@/app/api/public/shop/[token]/repeat/route';
import { GET as viewRoute } from '@/app/api/public/shop/[token]/route';
import { disconnectDatabases, getPrisma, getWorkerPrisma } from '@/lib/db/prisma';
import { withTenant, type TenantContext, type TenantTransaction } from '@/lib/db/tenant';
import { upsertVariant } from './catalogue/products';
import { getBuyerSettings, parseBuyerSettings, saveBuyerSettings, type BuyerSettings } from './buyer-settings';
import { placeOrder } from './checkout';
import { localToday } from './checkout-extras';
import { saveNoticeTemplate } from './notice-templates';
import { exportOrdersCsv } from './order-export';
import { handlePriceDropJob } from './price-drop-jobs';
import { approveReturn, createReturn, getReturn, receiveReturn, rejectReturn } from './returns';
import { issueSessionTx, loadSession, quoteSessionTx, setAddressTx, updateCartTx } from './storefront';

const configured = config({ path: '.env.test', quiet: true }).parsed;
const ownerUrl = process.env.TEST_DATABASE_URL;
const appUrl = process.env.TEST_APP_DATABASE_URL || configured?.DATABASE_URL;
const workerUrl = process.env.TEST_WORKER_DATABASE_URL || configured?.WORKER_DATABASE_URL;
const authUrl = process.env.TEST_AUTH_DATABASE_URL || configured?.AUTH_DATABASE_URL;
if (appUrl) process.env.DATABASE_URL = appUrl;
if (workerUrl) process.env.WORKER_DATABASE_URL = workerUrl;
if (authUrl) process.env.AUTH_DATABASE_URL = authUrl;
process.env.APP_URL ??= 'https://app.example.test';
process.env.ENCRYPTION_KEY ??= 'a'.repeat(64);
const ORIGIN = new URL(process.env.APP_URL).origin;

const account = randomUUID(), other = randomUUID(), owner = randomUUID(), admin = randomUUID(), agent = randomUUID(), viewer = randomUUID();
const asAdmin: TenantContext & { userId: string } = { accountId: account, userId: admin, role: 'admin' };
const asAgent: TenantContext & { userId: string } = { accountId: account, userId: agent, role: 'agent' };
const asViewer: TenantContext & { userId: string } = { accountId: account, userId: viewer, role: 'viewer' };
const asOther: TenantContext & { userId: string } = { accountId: other, userId: owner, role: 'owner' };
const number = randomUUID(), otherNumber = randomUUID();
const names = ['buyer', 'buyer2', 'optedOut', 'blocked', 'paused', 'late', 'otherBuyer'] as const;
type Name = (typeof names)[number];
const contacts = Object.fromEntries(names.map((n) => [n, randomUUID()])) as Record<Name, string>;
const conversations: Record<string, string> = {};
const ids = Object.fromEntries(['product', 'productQ', 'foreignProduct', 'small', 'large', 'quirky', 'foreignVariant'].map((n) => [n, randomUUID()])) as Record<string, string>;
const orders = Object.fromEntries(['delivered', 'old', 'cod', 'paid', 'buyer2', 'foreign'].map((n) => [n, randomUUID()])) as Record<string, string>;
const items = Object.fromEntries(['delivered1', 'delivered2', 'delivered3', 'old', 'cod', 'paid', 'buyer2', 'foreign'].map((n) => [n, randomUUID()])) as Record<string, string>;
const handle = `p8b5-${account.slice(0, 8)}`;
let db: pg.Client;
let ip = 0;
const tokens: Record<string, string> = {};

const worker = <T,>(fn: (tx: TenantTransaction) => Promise<T>, ac: string = account) => withTenant({ accountId: ac, role: 'owner' }, fn, getWorkerPrisma());
const params = (token: string) => ({ params: Promise.resolve({ token }) });
const request = (method: 'GET' | 'POST' | 'PUT', body?: unknown, origin: string | null = ORIGIN) => new Request(`${ORIGIN}/api/public/shop/x`, {
  method, headers: { 'content-type': 'application/json', ...(origin ? { origin } : {}), 'x-forwarded-for': `203.0.113.${(ip++ % 200) + 1}` },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});
const call = async (route: (r: Request, c: ReturnType<typeof params>) => Promise<Response>, token: string, method: 'GET' | 'POST' | 'PUT', body?: unknown, origin?: string | null) => {
  const res = await route(request(method, body, origin), params(token));
  return { status: res.status, body: (await res.json()) as ReturnType<typeof JSON.parse> };
};
const askReturn = (token: string, lines: unknown[], over: Record<string, unknown> = {}) =>
  call(returnsRoute, token, 'POST', { clientRequestId: randomUUID(), reason: 'damaged', lines, ...over });

const customerWrote = (who: Name, ago = '1 minute') => db.query(
  `INSERT INTO messages(account_id,conversation_id,sender_type,content_type,content_text,created_at) VALUES($1,$2,'customer','text','hi', now() - $3::interval)`,
  [account, conversations[contacts[who]], ago]);
const returnRows = async (orderId: string) => (await db.query('SELECT * FROM order_returns WHERE order_id=$1 ORDER BY created_at', [orderId])).rows;
const buyerSettings = (over: Partial<BuyerSettings> = {}): BuyerSettings => ({
  buyer_returns_enabled: true, price_drop_nudges_enabled: false, note_enabled: false, gift_message_enabled: false, delivery_date_enabled: false,
  lead_days: 1, window_days: 14, slots: [], custom_fields: [], ...over,
});

async function pricedOrder(id: string, contact: string, status: string, over: { ac?: string; payment?: string; deliveredAgo?: string; conv?: string | null } = {}) {
  const ac = over.ac ?? account;
  await db.query(`INSERT INTO orders(id,account_id,source,contact_id,conversation_id,whatsapp_config_id,currency,subtotal_minor,shipping_minor,tax_minor,tax_inclusive,total_minor,
      status,priced_at,paid_at,amount_paid_minor,payment_method,dispatched_at,delivered_at)
    VALUES($1,$2,'storefront',$3,$4,$5,'INR',120000,0,0,true,120000,$6,now() - interval '10 days',
      CASE WHEN $7='cod' THEN NULL ELSE now() - interval '10 days' END, CASE WHEN $7='cod' THEN 0 ELSE 120000 END,$7,now() - interval '9 days',
      CASE WHEN $6='fulfilled' THEN now() - $8::interval END)`,
  [id, ac, contact, over.conv ?? null, ac === account ? number : otherNumber, status, over.payment ?? 'online', over.deliveredAgo ?? '2 days']);
}
const orderItem = (id: string, orderId: string, variantId: string, qty: number, ac = account) => db.query(
  `INSERT INTO order_items(id,account_id,order_id,variant_id,sku,name,quantity,unit_price_minor,currency,line_total_minor) VALUES($1,$2,$3,$4,'SKU','Thing',$5,40000,'INR',$6)`,
  [id, ac, orderId, variantId, qty, qty * 40000]);

async function session(contactId: string, over: { orderId?: string | null; purpose?: 'shop' | 'status'; ac?: string } = {}) {
  const ac = over.ac ?? account;
  const issued = await worker((tx) => issueSessionTx(tx, ac, {
    sessionId: randomUUID(), contactId, conversationId: null, whatsappConfigId: null, purpose: over.purpose ?? 'status', orderId: over.orderId ?? null, ttlHours: 24, createdBy: null,
  }), ac);
  return { id: issued.sessionId, token: issued.url.split('/shop/')[1] };
}

const ADDRESS = { name: 'Asha Rao', phone: '+919876543210', line1: '12 Lake View Road', city: 'Bengaluru', state: 'Karnataka', state_code: '29', postal_code: '560001', country: 'IN' };
async function readySession(contactId: string) {
  const s = await session(contactId, { purpose: 'shop' });
  await worker((tx) => updateCartTx(tx, account, s.id, { expectedVersion: 1, lines: [{ variantId: ids.small, qty: 1 }] }));
  await worker((tx) => setAddressTx(tx, account, s.id, { expectedVersion: 2, address: ADDRESS }));
  return s;
}
const versionOf = async (sessionId: string) => (await worker(async (tx) => (await loadSession(tx, account, sessionId))!.version));

describe.skipIf(!ownerUrl || !appUrl || !workerUrl)('store phase 8 batch 5: buyer self-service on PostgreSQL', { timeout: 180_000 }, () => {
  beforeAll(async () => {
    db = new pg.Client({ connectionString: ownerUrl });
    await db.connect();
    if (!/test/i.test((await db.query('SELECT current_database() AS name')).rows[0].name)) throw new Error('Requires an isolated test database');
    const role = await getPrisma().$queryRaw<{ role: string }[]>`SELECT current_user AS role`;
    if (role[0].role !== 'bodhinox_app') throw new Error('Requires constrained test app credentials');
    await db.query("INSERT INTO auth_users(id,email,full_name,password_hash) SELECT x, x::text || '@example.invalid', 'P8B5', 'test-only-hash' FROM unnest($1::uuid[]) x", [[owner, admin, agent, viewer]]);
    await db.query("INSERT INTO accounts(id,name,owner_user_id) VALUES($1,'P8B5 shop',$3),($2,'P8B5 other',$3)", [account, other, owner]);
    await db.query("INSERT INTO account_subscriptions(account_id,plan_id) VALUES($1,'basic'),($2,'basic')", [account, other]);
    await db.query("INSERT INTO account_memberships(account_id,user_id,role) VALUES($1,$2,'owner'),($1,$3,'admin'),($1,$4,'agent'),($1,$5,'viewer'),($6,$2,'owner')",
      [account, owner, admin, agent, viewer, other]);
    await db.query(`INSERT INTO whatsapp_config(id,account_id,user_id,phone_number_id,access_token,status,is_default) VALUES($1,$2,$3,$4,'test-token','connected',true),($5,$6,$3,$7,'test-token','connected',true)`,
      [number, account, owner, `pn-${account}`, otherNumber, other, `pn-${other}`]);
    for (const [i, key] of names.entries()) {
      const ac = key === 'otherBuyer' ? other : account;
      await db.query(`INSERT INTO contacts(id,account_id,user_id,name,phone,opted_out_at,blocked_at) VALUES($1,$2,$3,$4,$5,$6,$7)`,
        [contacts[key], ac, owner, `Buyer ${key}`, `+14157${String(i).padStart(5, '0')}`, key === 'optedOut' ? new Date('2026-01-01T00:00:00Z') : null, key === 'blocked' ? new Date('2026-01-01T00:00:00Z') : null]);
      conversations[contacts[key]] = (await db.query(`INSERT INTO conversations(account_id,user_id,contact_id,whatsapp_config_id,bot_paused) VALUES($1,$2,$3,$4,$5) RETURNING id`,
        [ac, owner, contacts[key], key === 'otherBuyer' ? otherNumber : number, key === 'paused'])).rows[0].id;
    }
    await db.query(`INSERT INTO commerce_settings(account_id,currency,prices_include_tax,default_tax_rate_bps,checkout_enabled,return_window_days) VALUES($1,'INR',true,1800,true,7),($2,'INR',true,1800,true,7)`, [account, other]);
    await db.query(`INSERT INTO payment_providers(account_id,provider,mode,key_id,key_secret_enc) VALUES($1,'razorpay','test','rzp_test_B5','enc')`, [account]);
    await db.query(`INSERT INTO shipping_rates(account_id,name,country,fee_minor) VALUES($1,'India','IN',5000)`, [account]);
    await db.query(`INSERT INTO shop_products(id,account_id,name,status,content_reviewed_at) VALUES($1,$4,'Tulsi drops','published',now()),($2,$4,'Neem soap','published',now()),($3,$5,'Foreign','published',now())`,
      [ids.product, ids.productQ, ids.foreignProduct, account, other]);
    await db.query(`INSERT INTO shop_variants(id,account_id,product_id,sku,price_minor,track_inventory,option_values) VALUES
      ($1,$5,$4,'TUL-S',40000,false,'{"Size":"30ml"}'),($2,$5,$4,'TUL-L',45000,false,'{"Size":"60ml"}'),($3,$5,$6,'NEEM-1',20000,false,'{}')`,
    [ids.small, ids.large, ids.quirky, ids.product, account, ids.productQ]);
    await db.query(`INSERT INTO shop_variants(id,account_id,product_id,sku,price_minor,track_inventory) VALUES($1,$2,$3,'FOR-1',100,false)`, [ids.foreignVariant, other, ids.foreignProduct]);
    await db.query(`INSERT INTO shop_storefronts(account_id,handle,published,template,whatsapp_config_id,whatsapp_phone) VALUES($1,$2,true,'wellness',$3,'919800000000')`, [account, handle, number]);

    await pricedOrder(orders.delivered, contacts.buyer, 'fulfilled', { conv: conversations[contacts.buyer] });
    await orderItem(items.delivered1, orders.delivered, ids.small, 3);
    await orderItem(items.delivered2, orders.delivered, ids.quirky, 1);
    await orderItem(items.delivered3, orders.delivered, ids.small, 1);
    await pricedOrder(orders.old, contacts.buyer, 'fulfilled', { deliveredAgo: '30 days' });
    await orderItem(items.old, orders.old, ids.small, 1);
    await pricedOrder(orders.cod, contacts.buyer, 'dispatched', { payment: 'cod' });
    await orderItem(items.cod, orders.cod, ids.small, 1);
    await pricedOrder(orders.paid, contacts.buyer, 'paid');
    await orderItem(items.paid, orders.paid, ids.small, 1);
    await pricedOrder(orders.buyer2, contacts.buyer2, 'fulfilled');
    await orderItem(items.buyer2, orders.buyer2, ids.small, 2);
    await pricedOrder(orders.foreign, contacts.otherBuyer, 'fulfilled', { ac: other });
    await orderItem(items.foreign, orders.foreign, ids.foreignVariant, 1, other);

    tokens.buyer = (await session(contacts.buyer, { orderId: orders.delivered })).token;
    tokens.old = (await session(contacts.buyer, { orderId: orders.old })).token;
    tokens.cod = (await session(contacts.buyer, { orderId: orders.cod })).token;
    tokens.paid = (await session(contacts.buyer, { orderId: orders.paid })).token;
    tokens.buyer2 = (await session(contacts.buyer2, { orderId: orders.buyer2 })).token;
    // A session of buyer2 that points at buyer's order (it must never reach it).
    tokens.mismatch = (await session(contacts.buyer2, { orderId: orders.delivered })).token;
    tokens.foreign = (await session(contacts.otherBuyer, { orderId: orders.foreign, ac: other })).token;
    for (const key of ['buyer', 'buyer2', 'optedOut', 'blocked', 'paused', 'late'] as const) await customerWrote(key);
  });

  beforeEach(() => {
    sends.text.mockReset().mockResolvedValue({ whatsapp_message_id: 'wamid.text' });
    sends.template.mockReset().mockResolvedValue({ whatsapp_message_id: 'wamid.template' });
  });

  afterAll(async () => {
    if (db) {
      await db.query('DELETE FROM outbound_intents WHERE account_id=ANY($1::uuid[])', [[account, other]]);
      await db.query('DELETE FROM jobs WHERE tenant_id=ANY($1::uuid[])', [[account, other]]);
      await db.query('DELETE FROM accounts WHERE id=ANY($1::uuid[])', [[account, other]]);
      await db.query('DELETE FROM auth_users WHERE id=ANY($1::uuid[])', [[owner, admin, agent, viewer]]);
      await db.end();
    }
    await disconnectDatabases();
  });

  // ------------------------------------------------------------------ settings
  it('keeps the buyer settings admin-only and per workspace, and refuses a body outside the fixed caps', async () => {
    expect(await getBuyerSettings(asAgent)).toMatchObject({ buyer_returns_enabled: false, price_drop_nudges_enabled: false, slots: [], custom_fields: [] });
    // An agent cannot write them (the database refuses it), and nothing was saved.
    await expect(saveBuyerSettings(asAgent, buyerSettings())).rejects.toThrow();
    await expect(saveBuyerSettings(asViewer, buyerSettings())).rejects.toThrow();
    expect((await db.query('SELECT count(*)::int AS n FROM shop_buyer_settings WHERE account_id=$1', [account])).rows[0].n).toBe(0);
    for (const bad of [{ slots: Array.from({ length: 7 }, (_, i) => ({ id: `s${i}`, label: 'x' })) }, { lead_days: 99 },
      { custom_fields: Array.from({ length: 6 }, (_, i) => ({ id: `f${i}`, label: 'x', type: 'text', required: false })) }])
      expect(() => parseBuyerSettings({ ...buyerSettings(), ...bad })).toThrow(expect.objectContaining({ code: 'extras_invalid' }));
    // The table's own caps hold even for a raw write.
    await expect(db.query(`INSERT INTO shop_buyer_settings(account_id,slots) VALUES($1,$2::jsonb)`, [other, JSON.stringify(Array.from({ length: 7 }, () => ({ id: 'a', label: 'b' })))])).rejects.toThrow();

    // Off by default: a request is refused until an admin turns it on.
    expect((await askReturn(tokens.buyer, [{ order_item_id: items.delivered1, qty: 1 }])).body.code).toBe('returns_unavailable');
    await saveBuyerSettings(asAdmin, buyerSettings());
    expect(await getBuyerSettings(asAgent)).toMatchObject({ buyer_returns_enabled: true });
    // Another workspace's settings are its own.
    expect(await getBuyerSettings(asOther)).toMatchObject({ buyer_returns_enabled: false });
    expect((await db.query("SELECT count(*)::int AS n FROM audit_logs WHERE account_id=$1 AND action='commerce.buyer_settings_updated'", [account])).rows[0].n).toBe(1);
  });

  // ------------------------------------------------------------------ buyer return requests
  it('opens a request from the order page once, answers a replay with the same request, and shows it on the page', async () => {
    const clientRequestId = randomUUID();
    const body = { clientRequestId, reason: 'size_fit', note: 'too small', lines: [{ order_item_id: items.delivered1, qty: 2 }] };
    const first = await call(returnsRoute, tokens.buyer, 'POST', body);
    expect(first.status).toBe(200);
    expect(first.body.created).toBe(true);
    expect(first.body.order.returns.requests).toHaveLength(1);
    expect(first.body.order.returns.requests[0]).toMatchObject({ status: 'requested', pendingApproval: true, reason: 'size_fit', exchange: false });
    const [row] = await returnRows(orders.delivered);
    expect(row).toMatchObject({ source: 'buyer', status: 'requested', reason: 'size_fit', contact_id: contacts.buyer, approved_at: null, refund_id: null, restocked_at: null });
    expect(row.items).toEqual([{ order_item_id: items.delivered1, qty: 2 }]);
    expect((await db.query("SELECT actor FROM order_events WHERE order_id=$1 AND kind='return_requested'", [orders.delivered])).rows).toEqual([{ actor: 'customer' }]);

    // The same request again (a double tap or a retry) is the same return, never a second one.
    const again = await call(returnsRoute, tokens.buyer, 'POST', body);
    expect(again.status).toBe(200);
    expect(again.body.created).toBe(false);
    expect(await returnRows(orders.delivered)).toHaveLength(1);
    // Even after the window closed, a replay answers the request that was made.
    await db.query("UPDATE orders SET delivered_at=now() - interval '30 days' WHERE id=$1", [orders.delivered]);
    try { expect((await call(returnsRoute, tokens.buyer, 'POST', body)).body.created).toBe(false); }
    finally { await db.query("UPDATE orders SET delivered_at=now() - interval '2 days' WHERE id=$1", [orders.delivered]); }
    // The page's own view of the order now lists it and offers what is left.
    const view = await call(viewRoute, tokens.buyer, 'GET');
    expect(view.body.order.returns.lines.find((l: { id: string }) => l.id === items.delivered1)).toMatchObject({ remaining: 1, open: true });
    expect(view.body.order.returns.requests).toHaveLength(1);
  });

  it('holds one open request per line, and refuses more units than were ordered', async () => {
    const line = (id: string, qty: number) => [{ order_item_id: id, qty }];
    expect((await askReturn(tokens.buyer, line(items.delivered1, 1))).body.code).toBe('return_line_open');
    expect((await askReturn(tokens.buyer, line(items.delivered3, 2))).body.code).toBe('return_quantity');
    expect((await askReturn(tokens.buyer, line(items.old, 1))).body.code).toBe('invalid');
    expect((await askReturn(tokens.buyer, [])).status).toBe(400);
    expect((await askReturn(tokens.buyer, line(items.delivered2, 1), { reason: 'whatever' })).status).toBe(400);
    // Two requests for the same line at once: exactly one gets it.
    const racing = await Promise.all([askReturn(tokens.buyer, line(items.delivered2, 1)), askReturn(tokens.buyer, line(items.delivered2, 1))]);
    expect(racing.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(racing.find((r) => r.status === 409)!.body.code).toBe('return_line_open');
    expect((await returnRows(orders.delivered)).filter((r) => r.items[0].order_item_id === items.delivered2)).toHaveLength(1);
  });

  it('refuses outside the window, for an unpaid cash-on-delivery parcel, before dispatch, and from another contact or workspace', async () => {
    const line = (id: string) => [{ order_item_id: id, qty: 1 }];
    expect((await askReturn(tokens.old, line(items.old))).body.code).toBe('return_window_closed');
    expect((await askReturn(tokens.cod, line(items.cod))).body.code).toBe('returns_unavailable');
    expect((await askReturn(tokens.paid, line(items.paid))).body.code).toBe('returns_unavailable');
    // A session of another contact that points at this order never reaches it.
    expect((await askReturn(tokens.mismatch, line(items.delivered3))).body.code).toBe('returns_unavailable');
    // The other workspace has not turned requests on; once it has, its buyer still cannot use an item of this workspace's order.
    expect((await askReturn(tokens.foreign, line(items.foreign))).body.code).toBe('returns_unavailable');
    await saveBuyerSettings(asOther, buyerSettings());
    expect((await askReturn(tokens.foreign, line(items.delivered3))).body.code).toBe('invalid');
    // Nothing was stored for any of these, a stranger's token is the plain 404, and another origin is refused.
    expect((await returnRows(orders.old)).length + (await returnRows(orders.cod)).length + (await returnRows(orders.paid)).length + (await returnRows(orders.foreign)).length).toBe(0);
    expect((await askReturn('a'.repeat(43), line(items.delivered3))).status).toBe(404);
    expect((await call(returnsRoute, tokens.buyer, 'POST', { clientRequestId: randomUUID(), reason: 'damaged', lines: line(items.delivered3) }, 'https://evil.example')).status).toBe(403);
    expect(await returnRows(orders.delivered)).toHaveLength(2);
  });

  it('asks for a replacement variant of the same product only, in stock and on sale', async () => {
    const exchangeLine = (variantId: string) => [{ order_item_id: items.delivered3, qty: 1, exchange_variant_id: variantId }];
    expect((await askReturn(tokens.buyer, exchangeLine(ids.quirky))).body.code).toBe('exchange_unavailable');
    expect((await askReturn(tokens.buyer, exchangeLine(ids.foreignVariant))).body.code).toBe('exchange_unavailable');
    expect((await askReturn(tokens.buyer, exchangeLine(randomUUID()))).body.code).toBe('exchange_unavailable');
    const ok = await askReturn(tokens.buyer, exchangeLine(ids.large), { reason: 'size_fit' });
    expect(ok.status).toBe(200);
    expect(ok.body.order.returns.requests.some((r: { exchange: boolean }) => r.exchange)).toBe(true);
    const row = (await returnRows(orders.delivered)).find((r) => r.exchange);
    expect(row.exchange).toEqual({ [items.delivered3]: ids.large });
    // The order page offers the sibling variant, not another product's.
    const view = await call(viewRoute, tokens.buyer, 'GET');
    expect(view.body.order.returns.lines.find((l: { id: string }) => l.id === items.delivered1).exchangeOptions).toEqual([{ variantId: ids.large, label: '60ml' }]);
  });

  // ------------------------------------------------------------------ staff
  it('lets staff approve before anything moves, keeps replays idempotent, and makes the replacement order for an exchange once', async () => {
    const [plain, , exchange] = (await returnRows(orders.delivered)).sort((a, b) => (a.exchange ? 1 : 0) - (b.exchange ? 1 : 0));
    const racedLine = (await returnRows(orders.delivered)).find((r) => !r.exchange && r.items[0].order_item_id === items.delivered2);
    // Not approved yet: it cannot be received.
    await expect(receiveReturn(asAgent, racedLine.id)).rejects.toMatchObject({ code: 'bad_transition' });
    // A viewer cannot approve; nor can another workspace's staff, who do not even see it.
    await expect(approveReturn(asViewer, plain.id)).rejects.toThrow(/role/i);
    await expect(approveReturn(asOther, plain.id)).rejects.toMatchObject({ code: 'not_found' });

    const approved = await approveReturn(asAgent, racedLine.id);
    expect(approved).toMatchObject({ status: 'requested', pending_approval: false, source: 'buyer' });
    expect((await approveReturn(asAdmin, racedLine.id)).approved_at).toBe(approved.approved_at);
    expect(await receiveReturn(asAgent, racedLine.id)).toMatchObject({ status: 'received' });
    await expect(approveReturn(asAgent, racedLine.id)).rejects.toMatchObject({ code: 'bad_transition' });
    // Staff may also reject an unapproved request; nothing was refunded or restocked by any of this.
    expect(await rejectReturn(asAgent, plain.id)).toMatchObject({ status: 'rejected' });
    expect((await db.query('SELECT count(*)::int AS n FROM customer_refunds WHERE order_id=$1', [orders.delivered])).rows[0].n).toBe(0);
    expect((await db.query('SELECT count(*)::int AS n FROM inventory_movements WHERE order_id=$1', [orders.delivered])).rows[0].n).toBe(0);
    // A rejected line is free again for the buyer.
    expect((await askReturn(tokens.buyer, [{ order_item_id: items.delivered1, qty: 3 }])).status).toBe(200);

    // The exchange: approving makes one replacement order through the manual-order path.
    const before = (await db.query("SELECT count(*)::int AS n FROM orders WHERE account_id=$1 AND source='manual'", [account])).rows[0].n;
    const done = await approveReturn(asAgent, exchange.id);
    expect(done.exchange_order_id).not.toBeNull();
    const replacement = (await db.query('SELECT source, contact_id, status, total_minor FROM orders WHERE id=$1', [done.exchange_order_id])).rows[0];
    expect(replacement).toMatchObject({ source: 'manual', contact_id: contacts.buyer, status: 'confirmed' });
    expect((await db.query('SELECT variant_id, quantity FROM order_items WHERE order_id=$1', [done.exchange_order_id])).rows).toEqual([{ variant_id: ids.large, quantity: 1 }]);
    // Approving again, by someone else, finds the same order and makes no second one.
    expect((await approveReturn(asAdmin, exchange.id)).exchange_order_id).toBe(done.exchange_order_id);
    expect((await db.query("SELECT count(*)::int AS n FROM orders WHERE account_id=$1 AND source='manual'", [account])).rows[0].n).toBe(before + 1);
    expect(await getReturn(asAgent, exchange.id)).toMatchObject({ exchange_order_id: done.exchange_order_id, status: 'requested' });
  });

  it('keeps a staff-made return as it was: no approval needed, and the approve action refuses it', async () => {
    const made = await createReturn(asAgent, orders.buyer2, { items: [{ order_item_id: items.buyer2, qty: 1 }] });
    expect(made).toMatchObject({ source: 'staff', pending_approval: false, exchange: null });
    await expect(approveReturn(asAgent, made.id)).rejects.toMatchObject({ code: 'bad_transition' });
    expect(await receiveReturn(asAgent, made.id)).toMatchObject({ status: 'received' });
    // The buyer sees the staff-made request on their own order page too, and cannot take its units twice.
    expect((await askReturn(tokens.buyer2, [{ order_item_id: items.buyer2, qty: 2 }])).body.code).toBe('return_line_open');
  });

  // ------------------------------------------------------------------ checkout extras
  it('puts the buyer\'s extras on the order, checked again when placing, and in the export without changing the price', async () => {
    await saveBuyerSettings(asAdmin, buyerSettings({
      buyer_returns_enabled: true, note_enabled: true, gift_message_enabled: true, delivery_date_enabled: true, lead_days: 2, window_days: 10,
      slots: [{ id: 'am', label: '9am - 12pm' }, { id: 'pm', label: '2pm - 6pm' }],
      custom_fields: [{ id: 'wrap', label: 'Gift wrap', type: 'checkbox', required: false, options: [] },
        { id: 'size', label: 'Box', type: 'select', required: true, options: ['Small', 'Large'] }],
    }));
    const s = await readySession(contacts.late);
    const view0 = await call(viewRoute, s.token, 'GET');
    expect(view0.body.extras).toMatchObject({ note: true, giftMessage: true, deliveryDate: true, slots: [{ id: 'am' }, { id: 'pm' }], fields: [{ id: 'wrap' }, { id: 'size' }] });
    const quote = await worker(async (tx) => (await quoteSessionTx(tx, account, (await loadSession(tx, account, s.id))!)).result);
    if (!quote.ok) throw new Error('quote refused');
    const placeWith = (version: number) => placeOrder(account, s.id, { expectedVersion: version, expectedTotalMinor: quote.quote.totalMinor, clientRequestId: randomUUID() });
    const putExtras = async (extras: unknown) => call(extrasRoute, s.token, 'PUT', { expectedVersion: await versionOf(s.id), extras });
    // The workspace has no timezone row here, so "today" is India's.
    const day = (n: number) => new Date(new Date(`${localToday(new Date(), 'Asia/Kolkata')}T00:00:00Z`).getTime() + n * 86_400_000).toISOString().slice(0, 10);

    // A date too soon, a slot that does not exist and an unlisted choice are refused with the field.
    expect(await putExtras({ delivery_date: day(1), slot_id: 'am' })).toMatchObject({ status: 400, body: { code: 'extras_invalid', field: 'delivery_date' } });
    expect(await putExtras({ delivery_date: day(4), slot_id: 'night' })).toMatchObject({ status: 400, body: { field: 'slot_id' } });
    expect(await putExtras({ custom: { size: 'Huge' } })).toMatchObject({ status: 400, body: { field: 'custom.size' } });
    expect(await putExtras({ total_minor: 1 })).toMatchObject({ status: 400 });
    // Required fields are enforced when placing, not while typing.
    expect((await putExtras({ note: 'Ring twice' })).status).toBe(200);
    await expect(placeWith(await versionOf(s.id))).rejects.toMatchObject({ code: 'extras_invalid' });
    expect((await putExtras({ note: '=HYPERLINK("http://x")', gift_message: 'Happy birthday', delivery_date: day(4), slot_id: 'pm', custom: { wrap: true, size: 'Large' } })).status).toBe(200);
    // The shop turns a slot off between typing and placing: the order is not placed with it.
    await saveBuyerSettings(asAdmin, buyerSettings({ delivery_date_enabled: true, lead_days: 2, window_days: 10, slots: [{ id: 'am', label: '9am - 12pm' }],
      note_enabled: true, gift_message_enabled: true, custom_fields: [{ id: 'size', label: 'Box', type: 'select', required: true, options: ['Small', 'Large'] },
        { id: 'wrap', label: 'Gift wrap', type: 'checkbox', required: false, options: [] }] }));
    await expect(placeWith(await versionOf(s.id))).rejects.toMatchObject({ code: 'extras_invalid' });
    expect((await putExtras({ note: '=HYPERLINK("http://x")', gift_message: 'Happy birthday', delivery_date: day(4), slot_id: 'am', custom: { wrap: true, size: 'Large' } })).status).toBe(200);

    const placed = await placeWith(await versionOf(s.id));
    expect(placed.created).toBe(true);
    const stored = (await db.query('SELECT buyer_extras, total_minor FROM orders WHERE id=$1', [placed.orderId])).rows[0];
    expect(stored.buyer_extras).toEqual({
      note: '=HYPERLINK("http://x")', gift_message: 'Happy birthday', delivery_date: day(4), delivery_slot: '9am - 12pm',
      custom: [{ label: 'Box', value: 'Large' }, { label: 'Gift wrap', value: 'yes' }],
    });
    // Not part of pricing: the total is exactly what the quote showed.
    expect(Number(stored.total_minor)).toBe(quote.quote.totalMinor);
    // A replayed place answers the same order, with nothing changed.
    expect((await placeOrder(account, s.id, { expectedVersion: await versionOf(s.id), expectedTotalMinor: quote.quote.totalMinor, clientRequestId: randomUUID() })).orderId).toBe(placed.orderId);

    // Staff see it on the order and in the CSV (formula-guarded); the buyer sees it on their order page.
    const csv = (await exportOrdersCsv(asAgent, {})).csv;
    expect(csv.split('\r\n')[0]).toContain('"order_note","gift_message","delivery_date","delivery_slot","custom_fields"');
    expect(csv).toContain(`"'=HYPERLINK(""http://x"")","Happy birthday","${day(4)}","9am - 12pm","Box: Large; Gift wrap: yes"`);
    const page = await call(viewRoute, s.token, 'GET');
    expect(page.body.order.extras).toMatchObject({ gift_message: 'Happy birthday', delivery_slot: '9am - 12pm' });
    // Another workspace's staff cannot see it.
    expect((await exportOrdersCsv(asOther, {})).csv).not.toContain('Happy birthday');
    await saveBuyerSettings(asAdmin, buyerSettings());
  });

  // ------------------------------------------------------------------ one tap
  it('offers a repeat buyer their own last destination in one tap, and never anyone else\'s', async () => {
    // The contact placed an order above (note: contact "late"). A new shop session of that contact gets a short summary only.
    const again = await session(contacts.late, { purpose: 'shop' });
    await worker((tx) => updateCartTx(tx, account, again.id, { expectedVersion: 1, lines: [{ variantId: ids.small, qty: 1 }] }));
    const first = await call(viewRoute, again.token, 'GET');
    expect(first.body.repeat).toEqual({ name: 'Asha Rao', city: 'Bengaluru', postalCode: '560001', deliveryMethod: 'ship' });
    expect(JSON.stringify(first.body)).not.toContain('Lake View');
    expect(JSON.stringify(first.body)).not.toContain('9876543210');
    expect(first.body.address).toBeNull();

    // One tap copies it on the server; the page then holds the address like any entered one.
    const tapped = await call(repeatRoute, again.token, 'PUT', { expectedVersion: first.body.version });
    expect(tapped.status).toBe(200);
    expect(tapped.body.address).toMatchObject({ line1: '12 Lake View Road', city: 'Bengaluru' });
    expect(tapped.body.repeat).toBeNull();

    // A contact with no earlier order has nothing to repeat, and cannot get another contact's address.
    const stranger = await session(contacts.paused, { purpose: 'shop' });
    await worker((tx) => updateCartTx(tx, account, stranger.id, { expectedVersion: 1, lines: [{ variantId: ids.small, qty: 1 }] }));
    const strangerView = await call(viewRoute, stranger.token, 'GET');
    expect(strangerView.body.repeat).toBeNull();
    expect(JSON.stringify(strangerView.body)).not.toContain('Lake View');
    expect((await call(repeatRoute, stranger.token, 'PUT', { expectedVersion: strangerView.body.version })).body.code).toBe('repeat_unavailable');
    // Nor does a token that does not exist show anything.
    expect((await call(viewRoute, 'b'.repeat(43), 'GET')).status).toBe(404);
    // A foreign workspace's contact with the same shape of session sees none of this workspace's data.
    const foreign = await session(contacts.otherBuyer, { purpose: 'shop', ac: other });
    expect((await call(viewRoute, foreign.token, 'GET')).body.repeat).toBeNull();
  });

  // ------------------------------------------------------------------ wishlist and price drops
  const dropJobs = async (variantId: string) => (await db.query("SELECT payload FROM jobs WHERE type='commerce.price_drop' AND payload->>'variantId'=$1 ORDER BY created_at", [variantId])).rows
    .map((r) => r.payload as { variantId: string; fromMinor: number; toMinor: number; key: string });
  const setPrice = (variantId: string, priceMinor: number) => withTenant({ accountId: account, userId: admin, role: 'admin' }, (tx) =>
    upsertVariant(tx, account, admin, ids.product, variantId, { price_minor: priceMinor }));
  const nudges = async () => (await db.query('SELECT contact_id, status, reason FROM shop_price_nudges WHERE account_id=$1 ORDER BY created_at', [account])).rows;

  it('saves a wishlist for the identified contact only, once per variant, up to 50, and reads it back', async () => {
    const save = (token: string, action: string, extra: Record<string, unknown> = {}) => call(wishlistPost, token, 'POST', { action, ...extra });
    for (const who of ['buyer', 'optedOut', 'blocked', 'paused', 'late'] as const) {
      const s = await session(contacts[who], { purpose: 'shop' });
      tokens[`wish_${who}`] = s.token;
      expect((await save(s.token, 'add', { variantId: ids.small })).body.items).toHaveLength(1);
    }
    // The same variant twice is one row; a variant that is not on sale, another workspace's, or a bad id is refused.
    expect((await save(tokens.wish_buyer, 'add', { variantId: ids.small })).body.items).toHaveLength(1);
    expect((await save(tokens.wish_buyer, 'add', { variantId: ids.foreignVariant })).body.code).toBe('variant_unavailable');
    expect((await save(tokens.wish_buyer, 'add', { variantId: 'nope' })).status).toBe(400);
    expect((await save(tokens.wish_buyer, 'dance')).status).toBe(400);
    const list = await call(wishlistGet, tokens.wish_buyer, 'GET');
    expect(list.body).toMatchObject({ currency: 'INR', items: [{ variantId: ids.small, name: 'Tulsi drops', options: '30ml', priceMinor: 40000, available: true }] });
    // Nobody else's list is reachable: another contact and another workspace see their own.
    expect((await call(wishlistGet, tokens.wish_late, 'GET')).body.items).toHaveLength(1);
    const foreign = await session(contacts.otherBuyer, { purpose: 'shop', ac: other });
    expect((await call(wishlistGet, foreign.token, 'GET')).body.items).toEqual([]);
    expect((await call(wishlistPost, tokens.wish_buyer, 'POST', { action: 'add', variantId: ids.small }, 'https://evil.example')).status).toBe(403);
    // A browser's own list is saved once through 'sync' (variants that are gone are skipped); removing works.
    expect((await save(tokens.wish_buyer, 'sync', { variantIds: [ids.large, ids.foreignVariant, ids.small] })).body.items.map((i: { variantId: string }) => i.variantId).sort()).toEqual([ids.large, ids.small].sort());
    expect((await save(tokens.wish_buyer, 'remove', { variantId: ids.large })).body.items).toHaveLength(1);
    // The cap: 50 saved variants for a contact, then it is full.
    const many = await db.query(`INSERT INTO shop_variants(account_id,product_id,sku,price_minor,track_inventory) SELECT $1,$2,'MANY-'||g,1000,false FROM generate_series(1,50) g RETURNING id`, [account, ids.productQ]);
    const capped = await session(contacts.buyer2, { purpose: 'shop' });
    expect((await save(capped.token, 'sync', { variantIds: many.rows.map((r) => r.id) })).body.items).toHaveLength(50);
    expect((await save(capped.token, 'add', { variantId: ids.small })).body.code).toBe('wishlist_full');
    expect((await save(capped.token, 'add', { variantId: many.rows[0].id })).status).toBe(200);
  });

  it('queues a price-drop job in the price-saving transaction, only for a lower price on a wishlisted variant', async () => {
    expect(await dropJobs(ids.small)).toEqual([]);
    await setPrice(ids.small, 42000);
    expect(await dropJobs(ids.small)).toEqual([]);
    await setPrice(ids.small, 30000);
    const [job, ...rest] = await dropJobs(ids.small);
    expect(rest).toEqual([]);
    expect(job).toMatchObject({ variantId: ids.small, fromMinor: 42000, toMinor: 30000 });
    expect(job.key).toMatch(new RegExp(`^price-drop:${ids.small}:42000:30000:`));
    expect((await db.query('SELECT dedupe_key FROM jobs WHERE payload->>\'key\'=$1', [job.key])).rows).toEqual([{ dedupe_key: job.key }]);
    // A variant nobody saved queues nothing, even for a big drop.
    await withTenant({ accountId: account, userId: admin, role: 'admin' }, (tx) => upsertVariant(tx, account, admin, ids.productQ, ids.quirky, { price_minor: 100 }));
    expect(await dropJobs(ids.quirky)).toEqual([]);
  });

  it('sends no nudge unless the shop turned them on', async () => {
    const [job] = await dropJobs(ids.small);
    expect(await handlePriceDropJob(account, job)).toEqual({ sent: 0, closed: 0, skipped: 0 });
    expect(sends.text).not.toHaveBeenCalled();
    expect(await nudges()).toEqual([]);
    expect((await db.query('SELECT count(*)::int AS n FROM shop_price_drops WHERE account_id=$1', [account])).rows[0].n).toBe(0);
  });

  it('nudges each contact who may be messaged once per drop, and records why it did not message the others', async () => {
    await saveBuyerSettings(asAdmin, buyerSettings({ price_drop_nudges_enabled: true }));
    const [job] = await dropJobs(ids.small);
    // 'late' wrote two days ago (window closed, no template), 'paused' has an agent in the chat, opted-out and blocked contacts never get one.
    await db.query('DELETE FROM messages WHERE conversation_id=$1', [conversations[contacts.late]]);
    await customerWrote('late', '2 days');
    const result = await handlePriceDropJob(account, job);
    expect(result).toEqual({ sent: 1, closed: 4, skipped: 0 });
    expect(sends.text).toHaveBeenCalledTimes(1);
    expect(sends.text.mock.calls[0][0]).toMatchObject({ accountId: account, contactId: contacts.buyer, conversationId: conversations[contacts.buyer] });
    const text = String(sends.text.mock.calls[0][0].text);
    expect(text).toContain('Tulsi drops (30ml)');
    expect(text).toContain(`/s/${handle}/p/${ids.product}`);
    expect(sends.template).not.toHaveBeenCalled();
    const byContact = Object.fromEntries((await nudges()).map((n) => [n.contact_id, `${n.status}:${n.reason ?? ''}`]));
    expect(byContact).toEqual({
      [contacts.buyer]: 'sent:', [contacts.optedOut]: 'closed:opted_out', [contacts.blocked]: 'closed:contact_blocked',
      [contacts.paused]: 'closed:bot_paused', [contacts.late]: 'closed:no_template',
    });

    // The job runs again (a retry): nobody is messaged twice and nothing new is written.
    expect(await handlePriceDropJob(account, job)).toEqual({ sent: 0, closed: 0, skipped: 5 });
    expect(sends.text).toHaveBeenCalledTimes(1);
    expect(await nudges()).toHaveLength(5);
    expect((await db.query('SELECT count(*)::int AS n FROM shop_price_drops WHERE account_id=$1', [account])).rows[0].n).toBe(1);
    // A crash after the send but before the record: the accepted intent settles the row without a second send.
    await db.query("UPDATE shop_price_nudges SET status='pending', reason=NULL, settled_at=NULL WHERE contact_id=$1", [contacts.buyer]);
    expect(await handlePriceDropJob(account, job)).toEqual({ sent: 1, closed: 0, skipped: 4 });
    expect(sends.text).toHaveBeenCalledTimes(1);
  });

  it('sends the approved marketing template outside the window, and waits a week before nudging the same variant again', async () => {
    await db.query(`INSERT INTO message_templates(account_id,user_id,name,language,category,status,body_text)
      VALUES($1,$2,'price_offer','en','Marketing','APPROVED','Hi {{1}}, {{2}} is now {{3}}: {{4}}'),($1,$2,'price_util','en','Utility','APPROVED','Hi {{1}}')`, [account, owner]);
    await expect(saveNoticeTemplate(asAdmin, { kind: 'price_drop', template: { name: 'price_util', language: 'en' } })).rejects.toMatchObject({ code: 'wrong_category' });
    await saveNoticeTemplate(asAdmin, { kind: 'price_drop', template: { name: 'price_offer', language: 'en' } });
    // A second drop (30000 -> 25000) on the variant for the contact whose window is closed: the template is used.
    await db.query("DELETE FROM shop_price_nudges WHERE contact_id=$1", [contacts.late]);
    await setPrice(ids.small, 25000);
    const second = (await dropJobs(ids.small)).find((j) => j.toMinor === 25000)!;
    const result = await handlePriceDropJob(account, second);
    // buyer was nudged 0 days ago (cooldown), late gets the template, the rest stay closed.
    expect(result).toEqual({ sent: 1, closed: 4, skipped: 0 });
    expect(sends.template).toHaveBeenCalledTimes(1);
    expect(sends.template.mock.calls[0][0]).toMatchObject({ templateName: 'price_offer', contactId: contacts.late });
    expect(JSON.stringify(sends.template.mock.calls[0][0].params)).toContain(`/s/${handle}/p/${ids.product}`);
    expect(sends.text).not.toHaveBeenCalled();
    const rows = (await db.query(`SELECT contact_id, status, reason FROM shop_price_nudges n JOIN shop_price_drops d ON d.id=n.drop_id AND d.account_id=n.account_id
      WHERE d.to_minor=25000`)).rows;
    expect(rows.find((r) => r.contact_id === contacts.buyer)).toMatchObject({ status: 'closed', reason: 'cooldown' });
    expect(rows.find((r) => r.contact_id === contacts.late)).toMatchObject({ status: 'sent' });
  });

  it('records an uncertain send for staff and never repeats it; ignores a drop that no longer holds or is under 5%', async () => {
    await db.query("DELETE FROM shop_price_nudges WHERE contact_id=$1", [contacts.late]);
    await db.query('DELETE FROM shop_price_drops WHERE to_minor=25000');
    await db.query("DELETE FROM outbound_intents WHERE account_id=$1", [account]);
    const second = (await dropJobs(ids.small)).find((j) => j.toMinor === 25000)!;
    sends.template.mockRejectedValueOnce(new Error('socket hang up'));
    expect((await handlePriceDropJob(account, second)).closed).toBeGreaterThanOrEqual(1);
    const late = (await nudges()).filter((n) => n.contact_id === contacts.late).pop()!;
    expect(late).toMatchObject({ status: 'closed', reason: 'outcome_unknown' });
    const calls = sends.template.mock.calls.length;
    await handlePriceDropJob(account, second);
    expect(sends.template.mock.calls.length).toBe(calls);
    expect(sends.text).not.toHaveBeenCalled();

    // Under 5% (a pure no-op), and a price that went back up before the job ran.
    expect(await handlePriceDropJob(account, { ...second, key: `${second.key}:small`, fromMinor: 25000, toMinor: 24000 })).toEqual({ sent: 0, closed: 0, skipped: 0 });
    await setPrice(ids.small, 41000);
    const stale = { ...second, key: `${second.key}:stale`, fromMinor: 45000, toMinor: 30000 };
    expect(await handlePriceDropJob(account, stale)).toEqual({ sent: 0, closed: 0, skipped: 0 });
    expect((await db.query('SELECT count(*)::int AS n FROM shop_price_drops WHERE source_key=ANY($1::text[])', [[`${second.key}:small`, stale.key]])).rows[0].n).toBe(0);
  });

  it('keeps the wishlist tables out of the app role\'s hands and inside the tenant', async () => {
    // The app role (admin writes) can read wishlist rows of its own workspace only and cannot write them.
    const own = await withTenant(asAdmin, (tx) => tx.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM shop_wishlist_items`);
    expect(own[0].n).toBeGreaterThan(0);
    const foreign = await withTenant(asOther, (tx) => tx.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM shop_wishlist_items`);
    expect(foreign[0].n).toBe(0);
    await expect(withTenant(asAdmin, (tx) => tx.$executeRaw`INSERT INTO shop_wishlist_items(account_id,contact_id,variant_id) VALUES(${account}::uuid,${contacts.buyer}::uuid,${ids.large}::uuid)`)).rejects.toThrow();
    await expect(withTenant(asAdmin, (tx) => tx.$executeRaw`DELETE FROM shop_price_nudges`)).rejects.toThrow();
    // The worker, as another workspace, cannot save a contact of this workspace (the composite key refuses it).
    await expect(worker((tx) => tx.$executeRaw`INSERT INTO shop_wishlist_items(account_id,contact_id,variant_id) VALUES(${other}::uuid,${contacts.buyer}::uuid,${ids.foreignVariant}::uuid)`, other)).rejects.toThrow();
  });
});
