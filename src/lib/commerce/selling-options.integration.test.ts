import { randomUUID } from 'node:crypto';
import { config } from 'dotenv';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// Meta is never called: the engine senders are fakes. Everything else (rows, RLS, triggers, stock, jobs) is real.
const sends = vi.hoisted(() => ({ text: vi.fn(), template: vi.fn() }));
vi.mock('@/lib/automations/meta-send', () => ({ engineSendText: sends.text, engineSendTemplate: sends.template }));

import { disconnectDatabases, getPrisma, getWorkerPrisma } from '@/lib/db/prisma';
import { withTenant, type TenantContext, type TenantTransaction } from '@/lib/db/tenant';
import { GET as download } from '@/app/api/public/shop/download/route';
import { POST as unlockRoute } from '@/app/api/public/store/[handle]/unlock/route';
import { CatalogueError, setBundleParts, upsertProduct, upsertVariant } from './catalogue/products';
import { placeOrder } from './checkout';
import { digitalDownloadUrl, queueDigitalDeliveryTx } from './digital-delivery';
import { handleOrderFollowupJob } from './order-followup';
import { createStockAlert, loadShopAll } from './public-shop';
import { recordOfflinePayment } from '@/lib/payments/offline';
import { getShopAccess, parseShopAccessInput, saveShopAccess, unlockShop, visitorMayEnterTx } from './shop-access';
import { accessCookieName, hashShopPassword, verifyAccessCookie } from './selling-tokens';
import { reserveTx, restockTx, releaseTx } from './stock';
import {
  issueSessionTx, loadOrderView, loadSession, loadVariants, quoteSessionTx, setAddressTx, updateCartTx,
} from './storefront';
import { StoreError } from './store-settings';

// Store plan Phase 8, batch 3 on PostgreSQL: pre-orders, bundles, digital products, scheduled publish and hide, and
// the shop password / coming-soon gate. Tenancy, roles and durability.
const configured = config({ path: '.env.test', quiet: true }).parsed;
const ownerUrl = process.env.TEST_DATABASE_URL;
const appUrl = process.env.TEST_APP_DATABASE_URL || configured?.DATABASE_URL;
const workerUrl = process.env.TEST_WORKER_DATABASE_URL || configured?.WORKER_DATABASE_URL;
if (appUrl) process.env.DATABASE_URL = appUrl;
if (workerUrl) process.env.WORKER_DATABASE_URL = workerUrl;
process.env.APP_URL = 'https://app.example.test';
process.env.ENCRYPTION_KEY ??= 'a'.repeat(64);

const accountA = randomUUID(), accountB = randomUUID();
const ownerA = randomUUID(), adminA = randomUUID(), agentA = randomUUID(), ownerB = randomUUID();
const users = [ownerA, adminA, agentA, ownerB];
const number = randomUUID();
const handleA = `p8c-${accountA.slice(0, 8)}`, handleB = `p8c-${accountB.slice(0, 8)}`;
const id = () => randomUUID();
const P = { tea: id(), oil: id(), bundle: id(), pre: id(), preStock: id(), dig: id(), soldOut: id(), cap: id(), liveA: id(), future: id(), expired: id(), windowed: id(), bundle2: id(), other: id() };
const V = { tea: id(), oil: id(), bundle: id(), pre: id(), preStock: id(), dig: id(), soldOut: id(), cap: id(), liveA: id(), future: id(), expired: id(), windowed: id(), partA: id(), partB: id(), bundle2: id(), other: id() };
const contacts = Array.from({ length: 60 }, () => id());
const conversations: Record<string, string> = {};
let db: pg.Client;
let nextContact = 0;

const asAdmin: TenantContext & { userId: string } = { accountId: accountA, userId: adminA, role: 'admin' };
const asAgent: TenantContext & { userId: string } = { accountId: accountA, userId: agentA, role: 'agent' };
const asOwnerB: TenantContext & { userId: string } = { accountId: accountB, userId: ownerB, role: 'owner' };
const worker = <T,>(fn: (tx: TenantTransaction) => Promise<T>, account = accountA) => withTenant({ accountId: account, role: 'owner' }, fn, getWorkerPrisma());
const app = <T,>(ctx: TenantContext, fn: (tx: TenantTransaction) => Promise<T>) => withTenant(ctx, fn);
const codeOf = (p: Promise<unknown>) => p.then(() => 'ok', (e) => (e instanceof CatalogueError || e instanceof StoreError ? e.code : `threw:${String(e?.message ?? e).slice(0, 80)}`));
const meta = { attempts: 1, maxAttempts: 5 };

const ADDRESS = { name: 'Test buyer', phone: '+919876543210', line1: '1 MG Road', city: 'Bengaluru', state: 'Karnataka', state_code: '29', postal_code: '560001', country: 'IN' };

const level = async (variantId: string) => (await db.query(
  'SELECT on_hand, reserved FROM inventory_levels WHERE account_id=$1 AND variant_id=$2', [accountA, variantId])).rows[0] as { on_hand: number; reserved: number };
const availability = async (variantId: string): Promise<number | null> => (await db.query(
  'SELECT shop_variant_availability($1::uuid,$2::uuid) AS n', [accountA, variantId])).rows[0].n;
const reservations = async (orderId: string) => Object.fromEntries((await db.query(
  `SELECT variant_id, quantity, status FROM stock_reservations WHERE account_id=$1 AND order_id=$2`, [accountA, orderId])).rows.map((r) => [r.variant_id, `${r.quantity}:${r.status}`]));

/** A shop session for a fresh contact with the cart and (unless digital) an address; returns what placeOrder needs. */
async function session(lines: Array<{ variantId: string; qty: number }>, options: { address?: boolean; contact?: string } = {}) {
  const contactId = options.contact ?? contacts[nextContact++];
  const sessionId = id();
  await worker((tx) => issueSessionTx(tx, accountA, {
    sessionId, contactId, conversationId: conversations[contactId] ?? null, whatsappConfigId: conversations[contactId] ? number : null,
    purpose: 'shop', orderId: null, ttlHours: 24, createdBy: null,
  }));
  await worker((tx) => updateCartTx(tx, accountA, sessionId, { expectedVersion: 1, lines }));
  let version = 2;
  if (options.address !== false) {
    await worker((tx) => setAddressTx(tx, accountA, sessionId, { expectedVersion: 2, address: ADDRESS }));
    version = 3;
  }
  const result = await worker(async (tx) => (await quoteSessionTx(tx, accountA, (await loadSession(tx, accountA, sessionId))!)).result);
  if (!result.ok) throw new Error(`quote refused: ${result.code}`);
  return { sessionId, contactId, version, quote: result.quote };
}
const place = (s: Awaited<ReturnType<typeof session>>) => placeOrder(accountA, s.sessionId, {
  expectedVersion: s.version, expectedTotalMinor: s.quote.totalMinor, clientRequestId: id(),
});
const pay = (orderId: string, totalMinor: number) => recordOfflinePayment(asAdmin, orderId, {
  amount: (totalMinor / 100).toFixed(2), method: 'cash', reference: '', clientRequestId: id(),
});
const ledger = async (orderId: string, kind: string) => (await db.query(
  'SELECT status, reason FROM order_messages WHERE account_id=$1 AND order_id=$2 AND kind=$3', [accountA, orderId, kind])).rows[0];
const customerWrote = (contactId: string) => db.query(`INSERT INTO messages(account_id,conversation_id,sender_type,content_type,content_text)
  VALUES($1,$2,'customer','text','hi')`, [accountA, conversations[contactId]]);
const downloadGet = (url: string) => download(new Request(url));
// A fresh client address per run: the durable rate limits live in the database and outlast a run.
const ip = `203.0.113.${Math.floor(Math.random() * 250) + 1}`;

describe.skipIf(!ownerUrl || !appUrl || !workerUrl)('phase 8 batch 3: selling options on PostgreSQL', { timeout: 240_000 }, () => {
  beforeAll(async () => {
    db = new pg.Client({ connectionString: ownerUrl });
    await db.connect();
    if (!/test/i.test((await db.query('SELECT current_database() AS name')).rows[0].name)) throw new Error('Requires an isolated test database');
    const role = await getPrisma().$queryRaw<{ role: string }[]>`SELECT current_user AS role`;
    if (role[0].role !== 'bodhinox_app') throw new Error('Requires constrained test app credentials');
    await db.query("INSERT INTO auth_users(id,email,full_name,password_hash) SELECT x, x::text || '@example.invalid', 'P8 selling', 'test-only-hash' FROM unnest($1::uuid[]) x", [users]);
    await db.query("INSERT INTO accounts(id,name,owner_user_id) VALUES($1,'Selling A',$2),($3,'Selling B',$4)", [accountA, ownerA, accountB, ownerB]);
    await db.query("INSERT INTO account_subscriptions(account_id,plan_id) VALUES($1,'basic'),($2,'basic')", [accountA, accountB]);
    await db.query(`INSERT INTO account_memberships(account_id,user_id,role) VALUES ($1,$2,'owner'),($1,$3,'admin'),($1,$4,'agent'),($5,$6,'owner')`,
      [accountA, ownerA, adminA, agentA, accountB, ownerB]);
    await db.query(`INSERT INTO whatsapp_config(id,account_id,user_id,phone_number_id,access_token,status,is_default)
      VALUES($1,$2,$3,$4,'test-token','connected',true)`, [number, accountA, ownerA, `pn-${accountA}`]);
    for (const [i, contactId] of contacts.entries()) {
      await db.query('INSERT INTO contacts(id,account_id,user_id,name,phone) VALUES($1,$2,$3,$4,$5)', [contactId, accountA, ownerA, `Buyer ${i}`, `+1415777${String(i).padStart(4, '0')}`]);
      conversations[contactId] = (await db.query('INSERT INTO conversations(account_id,user_id,contact_id,whatsapp_config_id) VALUES($1,$2,$3,$4) RETURNING id',
        [accountA, ownerA, contactId, number])).rows[0].id;
    }
    await db.query(`INSERT INTO commerce_settings(account_id,currency,prices_include_tax,default_tax_rate_bps,checkout_enabled,reservation_minutes)
      VALUES($1,'INR',false,1800,true,15),($2,'INR',true,1800,true,15)`, [accountA, accountB]);
    await db.query(`INSERT INTO payment_providers(account_id,provider,mode,key_id,key_secret_enc) VALUES($1,'razorpay','test','rzp_test_SELL','enc')`, [accountA]);
    await db.query(`INSERT INTO shipping_rates(account_id,name,country,fee_minor) VALUES($1,'India','IN',5000)`, [accountA]);
    await db.query(`INSERT INTO shop_storefronts(account_id,handle,published,whatsapp_phone,whatsapp_config_id) VALUES($1,$2,true,'919800000000',$3),($4,$5,true,NULL,NULL)`,
      [accountA, handleA, number, accountB, handleB]);

    const product = (pid: string, name: string, extra = '') => db.query(
      `INSERT INTO shop_products(id,account_id,name,status,content_reviewed_at${extra ? ',' + extra.split('=')[0] : ''}) VALUES($1,$2,$3,'published',now()${extra ? ',' + extra.split('=')[1] : ''})`, [pid, accountA, name]);
    await product(P.tea, 'Tea'); await product(P.oil, 'Oil'); await product(P.pre, 'Pre-order lamp'); await product(P.preStock, 'Pre-order stocked');
    await product(P.soldOut, 'Sold out'); await product(P.cap, 'Capped'); await product(P.liveA, 'Live');
    await product(P.bundle2, 'Bundle two');
    await db.query(`UPDATE shop_products SET is_bundle=true WHERE id=ANY($1::uuid[])`, [[P.bundle2]]);
    await db.query(`INSERT INTO shop_products(id,account_id,name,status,content_reviewed_at,is_bundle) VALUES($1,$2,'Gift set','published',now(),true)`, [P.bundle, accountA]);
    await db.query(`INSERT INTO shop_products(id,account_id,name,status,content_reviewed_at,is_digital,digital_url) VALUES($1,$2,'Recipe book','published',now(),true,'https://files.example.test/book.pdf')`, [P.dig, accountA]);
    await db.query(`INSERT INTO shop_products(id,account_id,name,status,content_reviewed_at,publish_at) VALUES($1,$2,'Future','published',now(),now() + interval '1 day')`, [P.future, accountA]);
    await db.query(`INSERT INTO shop_products(id,account_id,name,status,content_reviewed_at,hide_at) VALUES($1,$2,'Expired','published',now(),now() - interval '1 hour')`, [P.expired, accountA]);
    await db.query(`INSERT INTO shop_products(id,account_id,name,status,content_reviewed_at,publish_at,hide_at) VALUES($1,$2,'Windowed','published',now(),now() - interval '1 day',now() + interval '1 day')`, [P.windowed, accountA]);
    await db.query(`INSERT INTO shop_products(id,account_id,name,status,content_reviewed_at) VALUES($1,$2,'Other shop','published',now())`, [P.other, accountB]);

    const variant = (vid: string, pid: string, sku: string, price: number, extra: { track?: boolean; preorder?: boolean; date?: string; cap?: number } = {}) => db.query(
      `INSERT INTO shop_variants(id,account_id,product_id,sku,price_minor,track_inventory,preorder,preorder_ship_date,preorder_cap) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [vid, accountA, pid, sku, price, extra.track ?? true, extra.preorder ?? false, extra.date ?? null, extra.cap ?? null]);
    await variant(V.tea, P.tea, 'TEA', 10000); await variant(V.oil, P.oil, 'OIL', 20000);
    await variant(V.bundle, P.bundle, 'GIFT', 50000, { track: false });
    await variant(V.pre, P.pre, 'LAMP', 30000, { preorder: true, date: '2027-01-15', cap: 3 });
    await variant(V.preStock, P.preStock, 'LAMP-S', 30000, { preorder: true, date: '2027-02-01' });
    await variant(V.dig, P.dig, 'BOOK', 20000, { track: false });
    await variant(V.soldOut, P.soldOut, 'SOLD', 10000);
    await variant(V.cap, P.cap, 'CAP', 10000, { preorder: true, date: '2027-03-01', cap: 2 });
    await variant(V.liveA, P.liveA, 'LIVE', 10000, { track: false });
    await variant(V.future, P.future, 'FUT', 10000, { track: false }); await variant(V.expired, P.expired, 'EXP', 10000, { track: false });
    await variant(V.windowed, P.windowed, 'WIN', 10000, { track: false });
    await variant(V.partA, P.tea, 'PART-A', 1000); await variant(V.partB, P.oil, 'PART-B', 1000);
    await variant(V.bundle2, P.bundle2, 'GIFT-2', 9000, { track: false });
    await db.query(`INSERT INTO shop_variants(id,account_id,product_id,sku,price_minor) VALUES($1,$2,$3,'OTHER-1',10000)`, [V.other, accountB, P.other]);
    await db.query(`INSERT INTO inventory_levels(account_id,variant_id,on_hand) VALUES($1,$2,6),($1,$3,3),($1,$4,0),($1,$5,1),($1,$6,0),($1,$7,4),($1,$8,100),($1,$9,0)`,
      [accountA, V.tea, V.oil, V.pre, V.preStock, V.soldOut, V.partA, V.partB, V.cap]);
    // The bundle: 2 tea + 1 oil (3 whole bundles). Bundle two: 2 of part A (4 on hand: 2 bundles) + 1 of part B.
    await db.query(`INSERT INTO shop_bundle_parts(account_id,product_id,part_variant_id,quantity,position) VALUES($1,$2,$3,2,0),($1,$2,$4,1,1),($1,$5,$6,2,0),($1,$5,$7,1,1)`,
      [accountA, P.bundle, V.tea, V.oil, P.bundle2, V.partA, V.partB]);
  });

  beforeEach(() => {
    sends.text.mockReset().mockResolvedValue({ whatsapp_message_id: 'wamid.text' });
    sends.template.mockReset().mockResolvedValue({ whatsapp_message_id: 'wamid.template' });
  });

  afterAll(async () => {
    if (db) {
      await db.query('DELETE FROM outbound_intents WHERE account_id=ANY($1::uuid[])', [[accountA, accountB]]);
      await db.query('DELETE FROM jobs WHERE tenant_id=ANY($1::uuid[])', [[accountA, accountB]]);
      await db.query('DELETE FROM accounts WHERE id=ANY($1::uuid[])', [[accountA, accountB]]);
      await db.query('DELETE FROM auth_users WHERE id=ANY($1::uuid[])', [users]);
      await db.end();
    }
    await disconnectDatabases();
  });

  // ------------------------------------------------------------------ availability

  it('reads availability from one rule: bundle parts, pre-order cap, stock, or no limit', async () => {
    expect(await availability(V.tea)).toBe(6);
    expect(await availability(V.bundle)).toBe(3); // min(floor(6/2), floor(3/1))
    expect(await availability(V.pre)).toBe(3); // the cap, nothing sold yet
    expect(await availability(V.preStock)).toBeNull(); // pre-order with no cap
    expect(await availability(V.dig)).toBeNull(); // a download has no stock
    expect(await availability(V.soldOut)).toBe(0);
    // A bundle with no parts sells nothing.
    await db.query(`INSERT INTO shop_products(id,account_id,name,status,is_bundle) VALUES($1,$2,'Empty bundle','draft',true)`, [P.other.replace(/^./, 'e'), accountA]);
    await db.query(`INSERT INTO shop_variants(id,account_id,product_id,sku,price_minor,track_inventory) VALUES($1,$2,$3,'EMPTY-B',1000,false)`, ['e' + V.other.slice(1), accountA, P.other.replace(/^./, 'e')]);
    expect(await availability('e' + V.other.slice(1))).toBe(0);
  });

  // ------------------------------------------------------------------ bundles

  it('a bundle reserves every part, at the bundle price, and the order keeps the bundle line', async () => {
    const s = await session([{ variantId: V.bundle, qty: 2 }]);
    // The bundle is priced like any variant: its own price, not the parts'.
    expect(s.quote).toMatchObject({ subtotalMinor: 100000, preorderShipDate: null, digitalOnly: false });
    expect(s.quote.lines).toHaveLength(1);
    const placed = await place(s);
    expect(await reservations(placed.orderId)).toEqual({ [V.tea]: '4:held', [V.oil]: '2:held' });
    expect(await level(V.tea)).toEqual({ on_hand: 6, reserved: 4 });
    expect(await level(V.oil)).toEqual({ on_hand: 3, reserved: 2 });
    expect((await db.query('SELECT variant_id, quantity FROM order_items WHERE order_id=$1', [placed.orderId])).rows).toEqual([{ variant_id: V.bundle, quantity: 2 }]);
    // What is left: 1 whole bundle.
    expect(await availability(V.bundle)).toBe(1);
    bundleOrder = placed.orderId;
  });
  let bundleOrder = '';

  it('is all or nothing: a bundle that one part cannot cover takes nothing from the other', async () => {
    const before = [await level(V.tea), await level(V.oil)];
    const s = await session([{ variantId: V.bundle, qty: 2 }, { variantId: V.tea, qty: 1 }]);
    await expect(place(s)).rejects.toMatchObject({ code: 'out_of_stock' });
    expect([await level(V.tea), await level(V.oil)]).toEqual(before);
    expect((await db.query('SELECT count(*)::int AS n FROM orders WHERE contact_id=$1', [s.contactId])).rows[0].n).toBe(0);
    expect((await db.query('SELECT count(*)::int AS n FROM stock_reservations WHERE account_id=$1 AND order_id IS NOT NULL AND status=$2 AND variant_id=$3',
      [accountA, 'held', V.tea])).rows[0].n).toBe(1);
  });

  it('never sells more bundles than the parts allow when many buyers arrive at once', async () => {
    // Bundle two: part A 4 on hand at 2 each = 2 bundles; part B has plenty. Six buyers, one bundle each.
    const sessions = await Promise.all(Array.from({ length: 6 }, () => session([{ variantId: V.bundle2, qty: 1 }])));
    const results = await Promise.all(sessions.map((s) => codeOf(place(s))));
    expect(results.filter((r) => r === 'ok')).toHaveLength(2);
    expect(results.filter((r) => r === 'out_of_stock')).toHaveLength(4);
    // The four losers took nothing from part B: exactly the two winners' units are reserved.
    expect(await level(V.partA)).toEqual({ on_hand: 4, reserved: 4 });
    expect(await level(V.partB)).toEqual({ on_hand: 100, reserved: 2 });
    expect(await availability(V.bundle2)).toBe(0);
  });

  it('cancelling an unpaid bundle order gives the parts back', async () => {
    await worker((tx) => releaseTx(tx, accountA, bundleOrder, 'cancelled'));
    expect(await level(V.tea)).toEqual({ on_hand: 6, reserved: 0 });
    expect(await level(V.oil)).toEqual({ on_hand: 3, reserved: 0 });
    expect(await reservations(bundleOrder)).toEqual({ [V.tea]: '4:released', [V.oil]: '2:released' });
    expect(await availability(V.bundle)).toBe(3);
  });

  it('a paid bundle takes its parts off the shelf and a return puts them back', async () => {
    const s = await session([{ variantId: V.bundle, qty: 1 }]);
    const placed = await place(s);
    await pay(placed.orderId, s.quote.totalMinor);
    expect(await level(V.tea)).toEqual({ on_hand: 4, reserved: 0 });
    expect(await level(V.oil)).toEqual({ on_hand: 2, reserved: 0 });
    // A return of the one bundle restocks 2 tea and 1 oil, never a stock level for the bundle itself.
    await worker((tx) => restockTx(tx, accountA, { orderId: placed.orderId, lines: [{ variantId: V.bundle, quantity: 1 }], kind: 'return_restock' }));
    expect(await level(V.tea)).toEqual({ on_hand: 6, reserved: 0 });
    expect(await level(V.oil)).toEqual({ on_hand: 3, reserved: 0 });
    expect((await db.query('SELECT count(*)::int AS n FROM inventory_levels WHERE account_id=$1 AND variant_id=$2', [accountA, V.bundle])).rows[0].n).toBe(0);
  });

  it('returns what was sold, not the bundle as it is now', async () => {
    const s = await session([{ variantId: V.bundle, qty: 1 }]);
    const placed = await place(s);
    expect((await db.query('SELECT bundle_parts FROM order_items WHERE order_id=$1', [placed.orderId])).rows[0].bundle_parts)
      .toEqual([{ variant_id: V.tea, quantity: 2 }, { variant_id: V.oil, quantity: 1 }]);
    await pay(placed.orderId, s.quote.totalMinor);
    expect(await level(V.tea)).toEqual({ on_hand: 4, reserved: 0 });
    // The store changes the bundle afterwards: one tea and two oil.
    await app(asAdmin, (tx) => setBundleParts(tx, accountA, adminA, P.bundle, { parts: [{ variant_id: V.tea, quantity: 1 }, { variant_id: V.oil, quantity: 2 }] }));
    await worker((tx) => restockTx(tx, accountA, { orderId: placed.orderId, lines: [{ variantId: V.bundle, quantity: 1 }], kind: 'return_restock' }));
    expect(await level(V.tea)).toEqual({ on_hand: 6, reserved: 0 });
    expect(await level(V.oil)).toEqual({ on_hand: 3, reserved: 0 });
    await app(asAdmin, (tx) => setBundleParts(tx, accountA, adminA, P.bundle, { parts: [{ variant_id: V.tea, quantity: 2 }, { variant_id: V.oil, quantity: 1 }] }));
  });

  it('refuses a bundle with no parts or an archived part, reserving nothing', async () => {
    await db.query('UPDATE shop_variants SET archived_at=now() WHERE id=$1', [V.oil]);
    await expect(worker((tx) => reserveTx(tx, accountA, bundleOrder, [{ variantId: V.bundle, quantity: 1 }], null))).rejects.toMatchObject({ code: 'out_of_stock' });
    expect(await availability(V.bundle)).toBe(0);
    await db.query('UPDATE shop_variants SET archived_at=NULL WHERE id=$1', [V.oil]);
  });

  it('keeps parts physical and flat: no nested bundle, no download or own product as a part', async () => {
    await expect(db.query(`INSERT INTO shop_bundle_parts(account_id,product_id,part_variant_id,quantity) VALUES($1,$2,$3,1)`, [accountA, P.bundle, V.bundle2])).rejects.toThrow(/bundle_part_invalid/);
    await expect(db.query(`INSERT INTO shop_bundle_parts(account_id,product_id,part_variant_id,quantity) VALUES($1,$2,$3,1)`, [accountA, P.bundle, V.dig])).rejects.toThrow(/bundle_part_invalid/);
    await expect(db.query(`INSERT INTO shop_bundle_parts(account_id,product_id,part_variant_id,quantity) VALUES($1,$2,$3,1)`, [accountA, P.tea, V.oil])).rejects.toThrow(/bundle_not_enabled/);
    // A product already used as a part cannot become a bundle.
    await expect(db.query('UPDATE shop_products SET is_bundle=true WHERE id=$1', [P.tea])).rejects.toThrow(/bundle_part_invalid/);
    // Another workspace's variant cannot be a part.
    await expect(db.query(`INSERT INTO shop_bundle_parts(account_id,product_id,part_variant_id,quantity) VALUES($1,$2,$3,1)`, [accountA, P.bundle, V.other])).rejects.toThrow();
  });

  it('lets an admin set the parts through the service and refuses an agent and another workspace', async () => {
    const product = await app(asAdmin, (tx) => setBundleParts(tx, accountA, adminA, P.bundle, { parts: [{ variant_id: V.tea, quantity: 2 }, { variant_id: V.oil, quantity: 1 }] }));
    expect(product).toMatchObject({ is_bundle: true, bundle_available: 3 });
    expect(product.bundle_parts.map((p) => [p.sku, p.quantity, p.available])).toEqual([['TEA', 2, 6], ['OIL', 1, 3]]);
    expect(await codeOf(app(asAdmin, (tx) => setBundleParts(tx, accountA, adminA, P.bundle, { parts: [{ variant_id: V.tea, quantity: 0 }] })))).toBe('invalid');
    expect(await codeOf(app(asAdmin, (tx) => setBundleParts(tx, accountA, adminA, P.bundle, { parts: [{ variant_id: V.tea, quantity: 1 }, { variant_id: V.tea, quantity: 1 }] })))).toBe('invalid');
    expect(await codeOf(app(asAdmin, (tx) => setBundleParts(tx, accountA, adminA, P.bundle, { parts: [{ variant_id: V.other, quantity: 1 }] })))).toBe('invalid');
    expect(await codeOf(app(asAdmin, (tx) => setBundleParts(tx, accountA, adminA, P.tea, { parts: [] })))).toBe('invalid');
    // The agent's write is refused by row security (the parts stay as they were).
    await expect(app(asAgent, (tx) => setBundleParts(tx, accountA, agentA, P.bundle, { parts: [{ variant_id: V.tea, quantity: 5 }] }))).rejects.toThrow();
    expect((await db.query('SELECT sum(quantity)::int AS n FROM shop_bundle_parts WHERE product_id=$1', [P.bundle])).rows[0].n).toBe(3);
    // Another workspace sees none of it and cannot reach the product.
    expect(await app(asOwnerB, (tx) => tx.$queryRaw`SELECT 1 FROM shop_bundle_parts`)).toEqual([]);
    expect(await codeOf(app(asOwnerB, (tx) => setBundleParts(tx, accountB, ownerB, P.bundle, { parts: [] })))).toBe('not_found');
  });

  // ------------------------------------------------------------------ pre-orders

  it('sells a pre-order past zero stock with the ship date on the quote, the line and the order', async () => {
    const s = await session([{ variantId: V.pre, qty: 2 }]);
    expect(s.quote.lines[0]).toMatchObject({ preorderShipDate: '2027-01-15' });
    expect(s.quote.preorderShipDate).toBe('2027-01-15');
    const placed = await place(s);
    expect((await db.query(`SELECT to_char(preorder_ship_date,'YYYY-MM-DD') AS d FROM orders WHERE id=$1`, [placed.orderId])).rows[0].d).toBe('2027-01-15');
    expect((await db.query(`SELECT to_char(preorder_ship_date,'YYYY-MM-DD') AS d FROM order_items WHERE order_id=$1`, [placed.orderId])).rows[0].d).toBe('2027-01-15');
    // Nothing was on the shelf, so nothing is reserved; the stock row is untouched.
    expect(await reservations(placed.orderId)).toEqual({});
    expect(await level(V.pre)).toEqual({ on_hand: 0, reserved: 0 });
    const view = await worker((tx) => loadOrderView(tx, accountA, placed.orderId));
    expect(view).toMatchObject({ preorderShipDate: '2027-01-15', lines: [{ shipsBy: '2027-01-15' }] });
    expect(await availability(V.pre)).toBe(1);
    preOrder = placed.orderId;
  });
  let preOrder = '';

  it('stops at the cap, counts open orders only, and frees units when an order is cancelled', async () => {
    const tooMany = await session([{ variantId: V.pre, qty: 2 }]);
    await expect(place(tooMany)).rejects.toMatchObject({ code: 'out_of_stock' });
    const last = await session([{ variantId: V.pre, qty: 1 }]);
    await place(last);
    expect(await availability(V.pre)).toBe(0);
    expect((await worker((tx) => loadVariants(tx, accountA, [V.pre]))).get(V.pre)?.available).toBe(0);
    await db.query(`UPDATE orders SET status='cancelled' WHERE id=$1`, [preOrder]);
    expect(await availability(V.pre)).toBe(2);
  });

  it('two buyers racing for the last capped units take turns: the cap holds', async () => {
    // Cap 2, nobody has ordered yet: five single-unit orders at once.
    const sessions = await Promise.all(Array.from({ length: 5 }, () => session([{ variantId: V.cap, qty: 1 }])));
    const results = await Promise.all(sessions.map((s) => codeOf(place(s))));
    expect([...results].sort()).toEqual(['ok', 'ok', 'out_of_stock', 'out_of_stock', 'out_of_stock']);
    expect(await availability(V.cap)).toBe(0);
  });

  it('reserves what is on the shelf and promises the rest on a pre-order variant', async () => {
    const s = await session([{ variantId: V.preStock, qty: 3 }]);
    const placed = await place(s);
    expect(await reservations(placed.orderId)).toEqual({ [V.preStock]: '1:held' });
    expect(await level(V.preStock)).toEqual({ on_hand: 1, reserved: 1 });
    expect((await db.query('SELECT preorder_ship_date IS NOT NULL AS pre FROM orders WHERE id=$1', [placed.orderId])).rows[0].pre).toBe(true);
    // Releasing the hold gives back only the unit that was reserved.
    await worker((tx) => releaseTx(tx, accountA, placed.orderId, 'cancelled'));
    expect(await level(V.preStock)).toEqual({ on_hand: 1, reserved: 0 });
  });

  it('keeps back-in-stock alerts for variants that are really sold out, never for a pre-order', async () => {
    expect(await createStockAlert(handleA, { variantId: V.pre, clientIp: ip }).catch((e: { code?: string }) => e.code)).toBe('variant_unavailable');
    expect(await createStockAlert(handleA, { variantId: V.preStock, clientIp: ip }).catch((e: { code?: string }) => e.code)).toBe('variant_unavailable');
    expect(await createStockAlert(handleA, { variantId: V.bundle, clientIp: ip }).catch((e: { code?: string }) => e.code)).toBe('variant_unavailable');
    expect(await createStockAlert(handleA, { variantId: V.soldOut, clientIp: ip })).toMatchObject({ whatsappUrl: expect.stringContaining('NOTIFY') });
  });

  it('only an admin can change pre-order, bundle and digital settings, and bad ones are refused', async () => {
    const before = (await db.query('SELECT is_digital, is_bundle FROM shop_products WHERE id=$1', [P.tea])).rows[0];
    // An agent: row security leaves the row alone (the update changes nothing and the service says conflict).
    expect(await codeOf(app(asAgent, (tx) => upsertProduct(tx, accountA, agentA, P.tea, { is_digital: true, digital_url: 'https://x.example.test/a.pdf' })))).not.toBe('ok');
    expect((await db.query('SELECT is_digital, is_bundle FROM shop_products WHERE id=$1', [P.tea])).rows[0]).toEqual(before);
    expect(await codeOf(app(asAgent, (tx) => upsertVariant(tx, accountA, agentA, P.tea, V.tea, { preorder: true, preorder_ship_date: '2027-01-01' })))).not.toBe('ok');
    expect((await db.query('SELECT preorder FROM shop_variants WHERE id=$1', [V.tea])).rows[0].preorder).toBe(false);
    // An admin: needs a ship date, a real cap, a physical product.
    expect(await codeOf(app(asAdmin, (tx) => upsertVariant(tx, accountA, adminA, P.tea, V.tea, { preorder: true })))).toBe('invalid');
    expect(await codeOf(app(asAdmin, (tx) => upsertVariant(tx, accountA, adminA, P.tea, V.tea, { preorder: true, preorder_ship_date: '2027-02-31' })))).toBe('invalid');
    expect(await codeOf(app(asAdmin, (tx) => upsertVariant(tx, accountA, adminA, P.tea, V.tea, { preorder: true, preorder_ship_date: '2027-02-01', preorder_cap: 0 })))).toBe('invalid');
    expect(await codeOf(app(asAdmin, (tx) => upsertVariant(tx, accountA, adminA, P.dig, V.dig, { preorder: true, preorder_ship_date: '2027-02-01' })))).toBe('invalid');
    expect(await codeOf(app(asAdmin, (tx) => upsertVariant(tx, accountA, adminA, P.tea, V.tea, { preorder: true, preorder_ship_date: '2027-02-01', preorder_cap: 5 })))).toBe('ok');
    expect(await codeOf(app(asAdmin, (tx) => upsertVariant(tx, accountA, adminA, P.tea, V.tea, { preorder: false })))).toBe('ok');
    // A product cannot be both a bundle and a download, and a download needs exactly one source.
    expect(await codeOf(app(asAdmin, (tx) => upsertProduct(tx, accountA, adminA, P.dig, { is_bundle: true })))).toBe('invalid');
    expect(await codeOf(app(asAdmin, (tx) => upsertProduct(tx, accountA, adminA, P.liveA, { is_digital: true })))).toBe('invalid');
    expect(await codeOf(app(asAdmin, (tx) => upsertProduct(tx, accountA, adminA, P.liveA, { is_digital: true, digital_url: 'http://insecure.example.test/a' })))).toBe('invalid');
    expect(await codeOf(app(asAdmin, (tx) => upsertProduct(tx, accountA, adminA, P.liveA, { is_digital: true, digital_url: 'https://u:p@x.example.test/a' })))).toBe('invalid');
  });

  // ------------------------------------------------------------------ digital products

  it('prices a digital cart with no address and places it with nothing to ship', async () => {
    const s = await session([{ variantId: V.dig, qty: 1 }], { address: false });
    expect(s.quote).toMatchObject({ digitalOnly: true, shippingMinor: 0, subtotalMinor: 20000, totalMinor: 23600 });
    const placed = await place(s);
    const { rows: [order] } = await db.query('SELECT shipping_address, shipping_minor::int AS shipping, delivery_method, status FROM orders WHERE id=$1', [placed.orderId]);
    expect(order).toEqual({ shipping_address: null, shipping: 0, delivery_method: 'ship', status: 'awaiting_payment' });
    expect(await reservations(placed.orderId)).toEqual({});
    // Cash on delivery is not offered for a download.
    const cod = await worker(async (tx) => (await quoteSessionTx(tx, accountA, { ...(await loadSession(tx, accountA, s.sessionId))!, payment_method: 'cod' })).result);
    expect(cod).toEqual({ ok: false, code: 'cod_unavailable' });
    // Unpaid: no download link for the buyer yet.
    expect((await worker((tx) => loadOrderView(tx, accountA, placed.orderId)))?.digitalDownloadUrl).toBeNull();
    await db.query(`DELETE FROM jobs WHERE tenant_id=$1 AND dedupe_key=$2`, [accountA, `ofu:${placed.orderId}:digital_delivery`]);
    unpaidDigital = { orderId: placed.orderId, total: s.quote.totalMinor };
  });
  let unpaidDigital = { orderId: '', total: 0 };

  it('queues exactly one delivery job when the order is paid, and none for an order without a download', async () => {
    await pay(unpaidDigital.orderId, unpaidDigital.total);
    const key = `ofu:${unpaidDigital.orderId}:digital_delivery`;
    expect((await db.query('SELECT count(*)::int AS n FROM jobs WHERE tenant_id=$1 AND dedupe_key=$2', [accountA, key])).rows[0].n).toBe(1);
    // A replayed confirmation queues nothing more.
    await worker((tx) => queueDigitalDeliveryTx(tx, accountA, unpaidDigital.orderId));
    expect((await db.query('SELECT count(*)::int AS n FROM jobs WHERE tenant_id=$1 AND dedupe_key=$2', [accountA, key])).rows[0].n).toBe(1);
    const view = await worker((tx) => loadOrderView(tx, accountA, unpaidDigital.orderId));
    expect(view?.digitalDownloadUrl).toMatch(/\/api\/public\/shop\/download\?a=/);
  });

  it('sends the signed link once inside the window, and a replay does not send again', async () => {
    const s = await session([{ variantId: V.dig, qty: 1 }], { address: false });
    const placed = await place(s);
    await pay(placed.orderId, s.quote.totalMinor);
    await customerWrote(s.contactId);
    expect(await handleOrderFollowupJob(accountA, { orderId: placed.orderId, kind: 'digital_delivery' }, meta)).toEqual({ status: 'sent', reason: null });
    expect(sends.text).toHaveBeenCalledTimes(1);
    const text = String(sends.text.mock.calls[0][0].text);
    const link = /https?:\/\/\S+\/api\/public\/shop\/download\?\S+/.exec(text)?.[0];
    expect(link, text).toBeTruthy();
    expect(text).not.toContain('files.example.test');
    expect(await handleOrderFollowupJob(accountA, { orderId: placed.orderId, kind: 'digital_delivery' }, meta)).toBeNull();
    expect(sends.text).toHaveBeenCalledTimes(1);
    expect(await ledger(placed.orderId, 'digital_delivery')).toEqual({ status: 'sent', reason: null });

    // The link: valid -> the file; another order's id with this signature -> 404; stretched expiry -> 404.
    const ok = await downloadGet(link!);
    expect(ok.status).toBe(302);
    expect(ok.headers.get('location')).toBe('https://files.example.test/book.pdf');
    const url = new URL(link!);
    const swapped = new URL(link!);
    swapped.searchParams.set('o', unpaidDigital.orderId);
    expect((await downloadGet(swapped.toString())).status).toBe(404);
    url.searchParams.set('e', String(Date.now() + 10 * 86_400_000 * 100));
    expect((await downloadGet(url.toString())).status).toBe(404);
    paidDigital = { orderId: placed.orderId, link: link! };
  });
  let paidDigital = { orderId: '', link: '' };

  it('refuses an expired link, an unpaid order and a fully refunded order', async () => {
    // Expired: a link signed in the past.
    const { downloadQuery } = await import('./selling-tokens');
    const expired = `https://app.example.test/api/public/shop/download?${downloadQuery({ accountId: accountA, orderId: paidDigital.orderId }, new Date(Date.now() - 1000))}`;
    expect((await downloadGet(expired)).status).toBe(410);
    // Unpaid.
    const s = await session([{ variantId: V.dig, qty: 1 }], { address: false });
    const unpaid = await place(s);
    expect((await downloadGet(digitalDownloadUrl(accountA, unpaid.orderId))).status).toBe(404);
    // Fully refunded.
    expect((await downloadGet(paidDigital.link)).status).toBe(302);
    await db.query(`UPDATE orders SET refund_state='full' WHERE id=$1`, [paidDigital.orderId]);
    expect((await downloadGet(paidDigital.link)).status).toBe(404);
    await db.query(`UPDATE orders SET refund_state='none' WHERE id=$1`, [paidDigital.orderId]);
    // Another workspace's id with a validly signed link for its own order reaches nothing of ours.
    expect((await downloadGet(digitalDownloadUrl(accountB, paidDigital.orderId))).status).toBe(404);
  });

  it('shows "needs a template" outside the window and sends with an approved utility template once one is set', async () => {
    const s = await session([{ variantId: V.dig, qty: 1 }], { address: false });
    const placed = await place(s);
    await pay(placed.orderId, s.quote.totalMinor);
    // The buyer wrote long ago: the 24 hour window is closed.
    await db.query(`INSERT INTO messages(account_id,conversation_id,sender_type,content_type,content_text,created_at) VALUES($1,$2,'customer','text','old',now() - interval '3 days')`, [accountA, conversations[s.contactId]]);
    expect(await handleOrderFollowupJob(accountA, { orderId: placed.orderId, kind: 'digital_delivery' }, meta)).toEqual({ status: 'blocked', reason: 'no_template' });
    expect(sends.text).not.toHaveBeenCalled();
    expect(sends.template).not.toHaveBeenCalled();
    expect(await ledger(placed.orderId, 'digital_delivery')).toEqual({ status: 'blocked', reason: 'no_template' });
    // Set an approved UTILITY template: the same message now goes out as a template, with the link as {{4}}.
    await db.query(`INSERT INTO message_templates(account_id,user_id,name,language,category,status,body_text,waba_id) VALUES($1,$2,'digital_link','en','Utility','APPROVED','Hi {{1}}, your {{2}} ({{3}}): {{4}}',NULL)`, [accountA, ownerA]);
    await db.query(`INSERT INTO order_notice_templates(account_id,kind,template_name,language) VALUES($1,'digital_delivery','digital_link','en')`, [accountA]);
    expect(await handleOrderFollowupJob(accountA, { orderId: placed.orderId, kind: 'digital_delivery' }, meta)).toEqual({ status: 'sent', reason: null });
    expect(sends.template).toHaveBeenCalledTimes(1);
    expect(sends.template.mock.calls[0][0].params[3]).toMatch(/\/api\/public\/shop\/download\?a=/);
    await db.query(`DELETE FROM order_notice_templates WHERE account_id=$1 AND kind='digital_delivery'`, [accountA]);
  });

  it('never sends again after an uncertain outcome: it asks for a check instead', async () => {
    const s = await session([{ variantId: V.dig, qty: 1 }], { address: false });
    const placed = await place(s);
    await pay(placed.orderId, s.quote.totalMinor);
    await customerWrote(s.contactId);
    sends.text.mockRejectedValue(new Error('socket hang up'));
    const last = { attempts: 5, maxAttempts: 5 };
    expect(await handleOrderFollowupJob(accountA, { orderId: placed.orderId, kind: 'digital_delivery' }, last)).toEqual({ status: 'outcome_unknown', reason: 'uncertain' });
    expect(sends.text).toHaveBeenCalledTimes(1);
    // The retry (and any later one) reads the intent and never calls the sender again.
    expect(await handleOrderFollowupJob(accountA, { orderId: placed.orderId, kind: 'digital_delivery' }, last)).toEqual({ status: 'outcome_unknown', reason: 'uncertain' });
    sends.text.mockResolvedValue({ whatsapp_message_id: 'wamid.late' });
    await handleOrderFollowupJob(accountA, { orderId: placed.orderId, kind: 'digital_delivery' }, last);
    expect(sends.text).toHaveBeenCalledTimes(1);
    expect(await ledger(placed.orderId, 'digital_delivery')).toEqual({ status: 'outcome_unknown', reason: 'uncertain' });
  });

  it('skips the message for an order that was refunded in full', async () => {
    const s = await session([{ variantId: V.dig, qty: 1 }], { address: false });
    const placed = await place(s);
    await pay(placed.orderId, s.quote.totalMinor);
    await customerWrote(s.contactId);
    await db.query(`UPDATE orders SET refund_state='full' WHERE id=$1`, [placed.orderId]);
    expect(await handleOrderFollowupJob(accountA, { orderId: placed.orderId, kind: 'digital_delivery' }, meta)).toEqual({ status: 'skipped', reason: 'refunded' });
    expect(sends.text).not.toHaveBeenCalled();
  });

  // ------------------------------------------------------------------ scheduled publish and hide

  it('shows products to the public only inside their publish and hide window, with no job running', async () => {
    const listed = async () => ((await loadShopAll(handleA))?.products ?? []).map((p) => p.name);
    const names = await listed();
    expect(names).toEqual(expect.arrayContaining(['Live', 'Windowed']));
    expect(names).not.toContain('Future');
    expect(names).not.toContain('Expired');
    const variants = await worker((tx) => loadVariants(tx, accountA, [V.liveA, V.future, V.expired, V.windowed]));
    expect([V.liveA, V.future, V.expired, V.windowed].map((v) => variants.get(v)?.sellable)).toEqual([true, false, false, true]);
    // A scheduled product cannot be put in a cart, and time moving is enough to open and close it.
    const s = await session([{ variantId: V.liveA, qty: 1 }]);
    await expect(worker((tx) => updateCartTx(tx, accountA, s.sessionId, { expectedVersion: s.version, lines: [{ variantId: V.future, qty: 1 }] })))
      .rejects.toMatchObject({ code: 'variant_unavailable' });
    await db.query(`UPDATE shop_products SET publish_at=now() - interval '1 second' WHERE id=$1`, [P.future]);
    await db.query(`UPDATE shop_products SET hide_at=now() - interval '1 second' WHERE id=$1`, [P.windowed]);
    const later = await listed();
    expect(later).toContain('Future');
    expect(later).not.toContain('Windowed');
    await db.query(`UPDATE shop_products SET publish_at=now() + interval '1 day' WHERE id=$1`, [P.future]);
  });

  it('lets only an admin set the schedule, and refuses a hide time before the publish time', async () => {
    const at = (offsetDays: number) => new Date(Date.now() + offsetDays * 86_400_000).toISOString();
    expect(await codeOf(app(asAgent, (tx) => upsertProduct(tx, accountA, agentA, P.liveA, { publish_at: at(1) })))).not.toBe('ok');
    expect((await db.query('SELECT publish_at FROM shop_products WHERE id=$1', [P.liveA])).rows[0].publish_at).toBeNull();
    expect(await codeOf(app(asAdmin, (tx) => upsertProduct(tx, accountA, adminA, P.liveA, { publish_at: at(3), hide_at: at(2) })))).toBe('invalid');
    expect(await codeOf(app(asAdmin, (tx) => upsertProduct(tx, accountA, adminA, P.liveA, { publish_at: 'soon' })))).toBe('invalid');
    const saved = await app(asAdmin, (tx) => upsertProduct(tx, accountA, adminA, P.liveA, { publish_at: at(-1), hide_at: at(2) }));
    expect(saved.publish_at).not.toBeNull();
    expect(saved.hide_at).not.toBeNull();
    const cleared = await app(asAdmin, (tx) => upsertProduct(tx, accountA, adminA, P.liveA, { publish_at: null, hide_at: null }));
    expect([cleared.publish_at, cleared.hide_at]).toEqual([null, null]);
    // The database rejects a window that closes before it opens, whoever writes it.
    await expect(db.query(`UPDATE shop_products SET publish_at=now() + interval '2 days', hide_at=now() + interval '1 day' WHERE id=$1`, [P.liveA])).rejects.toThrow(/schedule_check/);
  });

  // ------------------------------------------------------------------ shop password and coming soon

  it('lets an admin set the mode, never returns the hash, and refuses an agent and another workspace', async () => {
    expect(await getShopAccess(asAgent)).toEqual({ mode: 'open', passwordSet: false, comingSoonMessage: null, shopSaved: true });
    await expect(saveShopAccess(asAgent, parseShopAccessInput({ mode: 'coming_soon' }))).rejects.toThrow(/role/i);
    expect((await db.query('SELECT access_mode FROM shop_storefronts WHERE account_id=$1', [accountA])).rows[0].access_mode).toBe('open');
    expect((await getShopAccess(asAdmin)).mode).toBe('open');
    expect(await codeOf(saveShopAccess(asAdmin, parseShopAccessInput({ mode: 'password' })))).toBe('password_required');
    expect(() => parseShopAccessInput({ mode: 'password', password: 'abc' })).toThrow(StoreError);
    expect(() => parseShopAccessInput({ mode: 'locked' })).toThrow(StoreError);
    const view = await saveShopAccess(asAdmin, parseShopAccessInput({ mode: 'password', password: 'tulsi-2026' }));
    expect(view).toEqual({ mode: 'password', passwordSet: true, comingSoonMessage: null, shopSaved: true });
    expect(JSON.stringify(view)).not.toMatch(/scrypt|hash/i);
    const stored = (await db.query('SELECT password_hash AS h FROM shop_access_secrets WHERE account_id=$1', [accountA])).rows[0].h as string;
    expect(stored).toMatch(/^scrypt\$/);
    expect(stored).not.toContain('tulsi');
    // Another workspace's admin changes only its own shop.
    expect((await getShopAccess(asOwnerB)).mode).toBe('open');
    await saveShopAccess(asOwnerB, parseShopAccessInput({ mode: 'coming_soon', comingSoonMessage: 'Back soon' }));
    expect((await getShopAccess(asAdmin)).mode).toBe('password');
    expect((await db.query('SELECT access_mode FROM shop_storefronts WHERE account_id=$1', [accountB])).rows[0].access_mode).toBe('coming_soon');
    // The app role cannot read the other workspace's shop row at all.
    expect(await app(asAdmin, (tx) => tx.$queryRaw`SELECT 1 FROM shop_storefronts WHERE account_id=${accountB}::uuid`)).toEqual([]);
  });

  it('blocks the public shop without the cookie, and lets inbound WhatsApp claims through in password mode only', async () => {
    expect(await loadShopAll(handleA)).toBeNull();
    expect(await worker((tx) => visitorMayEnterTx(tx, accountA, 'visitor'))).toBe(false);
    expect(await worker((tx) => visitorMayEnterTx(tx, accountA, 'inbound'))).toBe(true);
    expect(await createStockAlert(handleA, { variantId: V.soldOut, clientIp: ip })).toBeNull();
    await saveShopAccess(asAdmin, parseShopAccessInput({ mode: 'coming_soon', comingSoonMessage: 'Opening 1 January' }));
    expect(await loadShopAll(handleA)).toBeNull();
    expect(await worker((tx) => visitorMayEnterTx(tx, accountA, 'inbound'))).toBe(false);
    expect((await app(asAgent, (tx) => tx.$queryRaw<{ m: string }[]>`SELECT coming_soon_message AS m FROM shop_storefronts WHERE account_id=${accountA}::uuid`))[0].m).toBe('Opening 1 January');
  });

  it('checks the password in constant time, sets a cookie for this shop only, and limits attempts', async () => {
    await saveShopAccess(asAdmin, parseShopAccessInput({ mode: 'password', password: 'tulsi-2026' }));
    const ip = `198.51.100.${Math.floor(Math.random() * 200) + 1}`;
    await expect(unlockShop(accountA, handleA, 'wrong-one', ip)).rejects.toMatchObject({ code: 'wrong_password' });
    await expect(unlockShop(accountA, handleA, 12345, ip)).rejects.toMatchObject({ code: 'wrong_password' });
    const reply = await unlockShop(accountA, handleA, 'tulsi-2026', ip);
    expect(reply?.cookie.name).toBe(accessCookieName(handleA));
    const stored = (await db.query('SELECT password_hash AS h FROM shop_access_secrets WHERE account_id=$1', [accountA])).rows[0].h as string;
    expect(verifyAccessCookie(reply!.cookie.value, handleA, stored, new Date())).toBe(true);
    // The cookie is for this shop: it is worth nothing for another handle, and nothing after a password change.
    expect(verifyAccessCookie(reply!.cookie.value, handleB, stored, new Date())).toBe(false);
    expect(verifyAccessCookie(reply!.cookie.value, handleA, hashShopPassword('a-new-password'), new Date())).toBe(false);
    // A shop that is not in password mode has nothing to unlock.
    expect(await unlockShop(accountB, handleB, 'tulsi-2026', ip)).toBeNull();
    // The eleventh attempt from one address is stopped before the password is looked at.
    const same = `198.51.100.${Math.floor(Math.random() * 200) + 1}`;
    for (let i = 0; i < 10; i++) await unlockShop(accountA, handleA, 'nope-nope', same).catch(() => undefined);
    await expect(unlockShop(accountA, handleA, 'tulsi-2026', same)).rejects.toMatchObject({ status: 429 });
  });

  it('the unlock route sets an httpOnly cookie on success and nothing on a wrong password', async () => {
    const call = (password: string, ip: string) => unlockRoute(new Request(`https://app.example.test/api/public/store/${handleA}/unlock`, {
      method: 'POST', headers: { origin: 'https://app.example.test', 'content-type': 'application/json', 'x-forwarded-for': ip }, body: JSON.stringify({ password }),
    }), { params: Promise.resolve({ handle: handleA }) });
    const bad = await call('wrong-one', '192.0.2.50');
    expect(bad.status).toBe(403);
    expect(bad.headers.get('set-cookie')).toBeNull();
    const good = await call('tulsi-2026', '192.0.2.51');
    expect(good.status).toBe(200);
    const cookie = good.headers.get('set-cookie') ?? '';
    expect(cookie).toContain(`${accessCookieName(handleA)}=`);
    expect(cookie.toLowerCase()).toContain('httponly');
    expect(cookie.toLowerCase()).toContain('samesite=lax');
    expect(JSON.stringify(await good.json())).toBe('{"ok":true}');
    // A cross-site request is refused before the password is read.
    const cross = await unlockRoute(new Request(`https://app.example.test/api/public/store/${handleA}/unlock`, {
      method: 'POST', headers: { origin: 'https://evil.example.test', 'content-type': 'application/json' }, body: JSON.stringify({ password: 'tulsi-2026' }),
    }), { params: Promise.resolve({ handle: handleA }) });
    expect(cross.status).toBeGreaterThanOrEqual(400);
    expect(cross.headers.get('set-cookie')).toBeNull();
  });

  it('opens the shop again when the mode goes back to open', async () => {
    await saveShopAccess(asAdmin, parseShopAccessInput({ mode: 'open' }));
    expect((await loadShopAll(handleA))?.products.length).toBeGreaterThan(0);
    expect(await worker((tx) => visitorMayEnterTx(tx, accountA, 'visitor'))).toBe(true);
    // The password is kept, so switching back to password mode needs no new one.
    expect(await getShopAccess(asAdmin)).toMatchObject({ mode: 'open', passwordSet: true });
  });
});
