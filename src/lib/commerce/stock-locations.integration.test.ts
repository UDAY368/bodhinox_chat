import { randomUUID } from 'node:crypto';
import { config } from 'dotenv';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { disconnectDatabases, getPrisma, getWorkerPrisma } from '@/lib/db/prisma';
import { withTenant, type TenantContext, type TenantTransaction } from '@/lib/db/tenant';
import { CatalogueError } from './catalogue/products';
import { placeOrder } from './checkout';
import { getDeliveryOptions, saveDeliveryOptions, type DeliveryOptions } from './delivery-options';
import {
  changePurchaseOrderStatus, createPurchaseOrder, getPurchaseOrder, listPurchaseOrders, receivePurchaseOrder, updatePurchaseOrder,
} from './purchase-orders';
import { adjustTx } from './stock';
import { createLocation, listLocations, listTransfers, transferStock, updateLocation, variantLocations } from './stock-locations';
import { issueSessionTx, loadOrderView, loadSession, loadStorefrontView, quoteSessionTx, setAddressTx, setDeliveryMethodTx, updateCartTx } from './storefront';
import { StoreError } from './store-settings';

// Store plan Phase 8, batch 2 on PostgreSQL: stock locations and transfers, purchase orders that receive
// into stock, and pickup / local delivery priced by the checkout. Tenancy, roles and durability.
const configured = config({ path: '.env.test', quiet: true }).parsed;
const ownerUrl = process.env.TEST_DATABASE_URL;
const appUrl = process.env.TEST_APP_DATABASE_URL || configured?.DATABASE_URL;
const workerUrl = process.env.TEST_WORKER_DATABASE_URL || configured?.WORKER_DATABASE_URL;
if (appUrl) process.env.DATABASE_URL = appUrl;
if (workerUrl) process.env.WORKER_DATABASE_URL = workerUrl;
process.env.APP_URL ??= 'https://app.example.test';
process.env.ENCRYPTION_KEY ??= 'a'.repeat(64);

const accountA = randomUUID(), accountB = randomUUID();
const ownerA = randomUUID(), adminA = randomUUID(), agentA = randomUUID(), ownerB = randomUUID();
const users = [ownerA, adminA, agentA, ownerB];
const productA = randomUUID(), productB = randomUUID();
const tea = randomUUID(), oil = randomUUID(), soap = randomUUID(), busy = randomUUID(), gone = randomUUID(), other = randomUUID();
const contacts = Array.from({ length: 4 }, () => randomUUID());
let db: pg.Client;

const asAdmin = { accountId: accountA, userId: adminA, role: 'admin' } as const;
const asAgent = { accountId: accountA, userId: agentA, role: 'agent' } as const;
const asOwnerB = { accountId: accountB, userId: ownerB, role: 'owner' } as const;
const worker = <T,>(fn: (tx: TenantTransaction) => Promise<T>, account = accountA) => withTenant({ accountId: account, role: 'owner' }, fn, getWorkerPrisma());
const app = <T,>(ctx: TenantContext, fn: (tx: TenantTransaction) => Promise<T>) => withTenant(ctx, fn);
const codeOf = (p: Promise<unknown>) => p.then(() => 'ok', (e) => (e instanceof CatalogueError || e instanceof StoreError ? e.code : `threw:${String(e?.message ?? e).slice(0, 80)}`));
const key = () => `k-${randomUUID()}`;

const onHand = async (variantId: string): Promise<number> => (await db.query(
  'SELECT on_hand FROM inventory_levels WHERE account_id=$1 AND variant_id=$2', [accountA, variantId])).rows[0].on_hand;

/** Every location is at or above zero and the locations sum to the sellable total, read both from the tables and through the module. */
async function expectBalanced(variantId: string) {
  const total = await onHand(variantId);
  const { rows: [placed] } = await db.query(
    'SELECT COALESCE(sum(quantity),0)::int AS sum, COALESCE(min(quantity),0)::int AS lowest FROM stock_location_levels WHERE account_id=$1 AND variant_id=$2',
    [accountA, variantId]);
  expect(placed.lowest).toBeGreaterThanOrEqual(0);
  expect(placed.sum).toBeLessThanOrEqual(total);
  const held = await variantLocations(asAdmin, variantId);
  expect(held.every((h) => h.quantity >= 0)).toBe(true);
  expect(held.reduce((s, h) => s + h.quantity, 0)).toBe(total);
  return Object.fromEntries(held.map((h) => [h.name, h.quantity]));
}

const address = (postal: string) => ({
  name: 'Test buyer', phone: '+919876543210', line1: '1 MG Road', city: 'Bengaluru', state: 'Karnataka', state_code: '29', postal_code: postal, country: 'IN',
});

/** A shop session with a cart, an address and a delivery method; returns its id, version and quote. */
async function readySession(contactId: string, postal: string, method: 'ship' | 'pickup' | 'local') {
  const sessionId = randomUUID();
  await worker((tx) => issueSessionTx(tx, accountA, {
    sessionId, contactId, conversationId: null, whatsappConfigId: null, purpose: 'shop', orderId: null, ttlHours: 24, createdBy: null,
  }));
  await worker((tx) => updateCartTx(tx, accountA, sessionId, { expectedVersion: 1, lines: [{ variantId: soap, qty: 2 }] }));
  await worker((tx) => setAddressTx(tx, accountA, sessionId, { expectedVersion: 2, address: address(postal) }));
  let version = 3;
  if (method !== 'ship') {
    await worker((tx) => setDeliveryMethodTx(tx, accountA, sessionId, { expectedVersion: 3, deliveryMethod: method }));
    version = 4;
  }
  const result = await worker(async (tx) => (await quoteSessionTx(tx, accountA, (await loadSession(tx, accountA, sessionId))!)).result);
  if (!result.ok) throw new Error(`quote refused: ${result.code}`);
  return { sessionId, version, quote: result.quote };
}

describe.skipIf(!ownerUrl || !appUrl || !workerUrl)('phase 8 batch 2: stock locations, purchase orders and delivery options on PostgreSQL', { timeout: 180_000 }, () => {
  let main = '', shelf = '', shed = '';

  beforeAll(async () => {
    db = new pg.Client({ connectionString: ownerUrl });
    await db.connect();
    if (!/test/i.test((await db.query('SELECT current_database() AS name')).rows[0].name)) throw new Error('Requires an isolated test database');
    const role = await getPrisma().$queryRaw<{ role: string }[]>`SELECT current_user AS role`;
    if (role[0].role !== 'bodhinox_app') throw new Error('Requires constrained test app credentials');
    await db.query("INSERT INTO auth_users(id,email,full_name,password_hash) SELECT x, x::text || '@example.invalid', 'P8 loc', 'test-only-hash' FROM unnest($1::uuid[]) x", [users]);
    await db.query("INSERT INTO accounts(id,name,owner_user_id) VALUES($1,'Loc A',$2),($3,'Loc B',$4)", [accountA, ownerA, accountB, ownerB]);
    await db.query("INSERT INTO account_subscriptions(account_id,plan_id) VALUES($1,'basic'),($2,'basic')", [accountA, accountB]);
    await db.query(`INSERT INTO account_memberships(account_id,user_id,role) VALUES ($1,$2,'owner'),($1,$3,'admin'),($1,$4,'agent'),($5,$6,'owner')`,
      [accountA, ownerA, adminA, agentA, accountB, ownerB]);
    await db.query(`INSERT INTO contacts(id,account_id,user_id,name,phone)
      SELECT c, $2, $3, 'Buyer', '1415666' || lpad(n::text, 4, '0') FROM unnest($1::uuid[]) WITH ORDINALITY AS t(c, n)`, [contacts, accountA, ownerA]);
    await db.query(`INSERT INTO commerce_settings(account_id,currency,prices_include_tax,default_tax_rate_bps,checkout_enabled,reservation_minutes)
      VALUES($1,'INR',false,1000,true,15),($2,'INR',true,1800,true,15)`, [accountA, accountB]);
    await db.query(`INSERT INTO payment_providers(account_id,provider,mode,key_id,key_secret_enc) VALUES($1,'razorpay','test','rzp_test_LOC','enc')`, [accountA]);
    await db.query(`INSERT INTO shipping_rates(account_id,name,country,fee_minor) VALUES($1,'India','IN',5000)`, [accountA]);
    await db.query(`INSERT INTO shop_products(id,account_id,name,status,content_reviewed_at) VALUES($1,$2,'Loc goods','published',now()),($3,$4,'Other goods','published',now())`,
      [productA, accountA, productB, accountB]);
    await db.query(`INSERT INTO shop_variants(id,account_id,product_id,sku,price_minor) VALUES
      ($1,$7,$8,'LOC-TEA',10000),($2,$7,$8,'LOC-OIL',20000),($3,$7,$8,'LOC-SOAP',30000),($4,$7,$8,'LOC-BUSY',40000),($5,$7,$8,'LOC-GONE',50000),($6,$9,$10,'OTH-1',10000)`,
      [tea, oil, soap, busy, gone, other, accountA, productA, accountB, productB]);
    await db.query(`INSERT INTO inventory_levels(account_id,variant_id,on_hand) VALUES($1,$2,10),($1,$3,6),($1,$4,50),($1,$5,10),($1,$6,0),($7,$8,9)`,
      [accountA, tea, oil, soap, busy, gone, accountB, other]);
  });

  afterAll(async () => {
    if (db) {
      await db.query('DELETE FROM jobs WHERE tenant_id=ANY($1::uuid[])', [[accountA, accountB]]);
      await db.query('DELETE FROM accounts WHERE id=ANY($1::uuid[])', [[accountA, accountB]]);
      await db.query('DELETE FROM auth_users WHERE id=ANY($1::uuid[])', [users]);
      await db.end();
    }
    await disconnectDatabases();
  });

  // ------------------------------------------------------------------ locations

  it('makes one default location that holds all existing stock, and changes no stock number', async () => {
    const [first, again] = await Promise.all([listLocations(asAdmin), listLocations(asAgent)]);
    expect(first).toHaveLength(1);
    expect(again).toHaveLength(1);
    expect(first[0]).toMatchObject({ is_default: true, active: true, units: 76 });
    main = first[0].id;
    expect((await db.query('SELECT count(*)::int AS n FROM stock_locations WHERE account_id=$1', [accountA])).rows[0].n).toBe(1);
    expect(await onHand(tea)).toBe(10);
    expect(await expectBalanced(tea)).toEqual({ [first[0].name]: 10 });
  });

  it('lets an admin add locations and refuses an agent, a duplicate name and the app role itself', async () => {
    shelf = (await createLocation(asAdmin, { name: 'Shelf' })).id;
    shed = (await createLocation(asAdmin, { name: 'Shed' })).id;
    expect(await codeOf(createLocation(asAdmin, { name: 'shelf' }))).toBe('name_taken');
    await expect(createLocation(asAgent, { name: 'Sneaky' })).rejects.toThrow(/role|turned off/i);
    await expect(updateLocation(asAgent, shelf, { active: false })).rejects.toThrow(/role|turned off/i);
    // The app role has no write grant on any stock table, even for an admin: only the worker writes.
    await expect(app(asAdmin, (tx) => tx.$executeRaw`INSERT INTO stock_locations(account_id,name) VALUES(${accountA}::uuid,'Direct')`)).rejects.toThrow();
    await expect(app(asAdmin, (tx) => tx.$executeRaw`UPDATE stock_location_levels SET quantity=99 WHERE account_id=${accountA}::uuid`)).rejects.toThrow();
    expect((await listLocations(asAdmin)).map((l) => l.name).sort()).toEqual(expect.arrayContaining(['Shed', 'Shelf']));
  });

  it('moves stock between locations without changing the total', async () => {
    expect(await transferStock(asAdmin, { clientKey: key(), fromLocationId: main, toLocationId: shelf, variantId: tea, quantity: 4, note: null }))
      .toMatchObject({ replayed: false });
    expect(await onHand(tea)).toBe(10);
    expect(await expectBalanced(tea)).toMatchObject({ Shelf: 4, Shed: 0 });
    await transferStock(asAdmin, { clientKey: key(), fromLocationId: shelf, toLocationId: shed, variantId: tea, quantity: 3, note: 'restock the shed' });
    await transferStock(asAdmin, { clientKey: key(), fromLocationId: shed, toLocationId: main, variantId: tea, quantity: 1, note: null });
    const held = await expectBalanced(tea);
    expect(held).toMatchObject({ Shelf: 1, Shed: 2 });
    expect(Object.values(held).reduce((s, q) => s + q, 0)).toBe(10);
    expect((await app(asAgent, (tx) => listTransfers(tx, accountA))).length).toBe(3);
  });

  it('a replayed transfer key does not move the stock twice, and a reused key is refused', async () => {
    const input = { clientKey: key(), fromLocationId: main, toLocationId: shelf, variantId: oil, quantity: 2, note: null };
    const first = await transferStock(asAdmin, input);
    const replay = await transferStock(asAdmin, input);
    expect(replay).toEqual({ transferId: first.transferId, replayed: true });
    // Two copies of the same request at once: one applies, the other replays.
    const twin = { ...input, clientKey: key(), quantity: 1 };
    const both = await Promise.all([transferStock(asAdmin, twin), transferStock(asAdmin, twin)]);
    expect(both.filter((r) => !r.replayed)).toHaveLength(1);
    expect(both[0].transferId).toBe(both[1].transferId);
    expect(await expectBalanced(oil)).toMatchObject({ Shelf: 3 });
    expect(await codeOf(transferStock(asAdmin, { ...input, quantity: 5 }))).toBe('key_reused');
    expect((await db.query('SELECT count(*)::int AS n FROM stock_transfers WHERE account_id=$1 AND variant_id=$2', [accountA, oil])).rows[0].n).toBe(2);
  });

  it('refuses a transfer the source cannot cover and leaves nothing behind', async () => {
    const before = await expectBalanced(oil);
    const k = key();
    expect(await codeOf(transferStock(asAdmin, { clientKey: k, fromLocationId: shelf, toLocationId: shed, variantId: oil, quantity: 4, note: null }))).toBe('insufficient_stock');
    expect(await codeOf(transferStock(asAdmin, { clientKey: key(), fromLocationId: main, toLocationId: shed, variantId: oil, quantity: 4, note: null }))).toBe('insufficient_stock');
    expect(await codeOf(transferStock(asAdmin, { clientKey: key(), fromLocationId: main, toLocationId: main, variantId: oil, quantity: 1, note: null }))).toBe('invalid');
    expect(await expectBalanced(oil)).toEqual(before);
    // The refused request rolled back whole: its key was not burnt.
    expect((await db.query('SELECT count(*)::int AS n FROM stock_transfers WHERE account_id=$1 AND client_key=$2', [accountA, k])).rows[0].n).toBe(0);
  });

  it('concurrent transfers never take a location below zero', async () => {
    // 10 units, all at the default location. Eight transfers of 3 out of it and four of 2 between the others, all at once.
    const out = Array.from({ length: 8 }, () => codeOf(transferStock(asAdmin, { clientKey: key(), fromLocationId: main, toLocationId: shelf, variantId: busy, quantity: 3, note: null })));
    const across = Array.from({ length: 4 }, () => codeOf(transferStock(asAdmin, { clientKey: key(), fromLocationId: shelf, toLocationId: shed, variantId: busy, quantity: 2, note: null })));
    const results = await Promise.all([...out, ...across]);
    const moved = results.slice(0, 8).filter((r) => r === 'ok').length;
    expect(moved).toBe(3);
    expect(results.every((r) => r === 'ok' || r === 'insufficient_stock')).toBe(true);
    const crossed = results.slice(8).filter((r) => r === 'ok').length;
    const held = await expectBalanced(busy);
    expect(held).toMatchObject({ Shelf: 9 - crossed * 2, Shed: crossed * 2 });
    expect(await onHand(busy)).toBe(10);
  });

  it('a sale or write-off that the default location cannot cover takes the rest from the other locations', async () => {
    // tea: 10 on hand, Shelf 1, Shed 2, default 7. Writing off 8 empties the default location and takes 1 from Shelf (first by position).
    await worker((tx) => adjustTx(tx, accountA, { variantId: tea, delta: -8, kind: 'write_off', reason: 'damaged', actorUserId: adminA }));
    expect(await onHand(tea)).toBe(2);
    const held = await expectBalanced(tea);
    expect(held).toMatchObject({ Shelf: 0, Shed: 2 });
    // New stock lands at the default location.
    await worker((tx) => adjustTx(tx, accountA, { variantId: tea, delta: 5, kind: 'receipt', reason: null, actorUserId: adminA }));
    expect(await expectBalanced(tea)).toMatchObject({ Shelf: 0, Shed: 2 });
    expect(await onHand(tea)).toBe(7);
  });

  it('the database itself refuses a location row that would break the total', async () => {
    await expect(db.query('UPDATE stock_location_levels SET quantity=quantity+100 WHERE account_id=$1 AND variant_id=$2 AND location_id=$3', [accountA, tea, shed]))
      .rejects.toThrow(/stock_location_overflow/);
    await expect(db.query('INSERT INTO stock_location_levels(account_id,location_id,variant_id,quantity) VALUES($1,$2,$3,1)', [accountA, main, tea]))
      .rejects.toThrow(/stock_location_default_row/);
    await expect(db.query('UPDATE stock_location_levels SET quantity=-1 WHERE account_id=$1 AND variant_id=$2 AND location_id=$3', [accountA, tea, shed]))
      .rejects.toThrow();
    await expectBalanced(tea);
  });

  it('keeps a location that holds stock, and the default one, switched on', async () => {
    expect(await codeOf(updateLocation(asAdmin, shed, { active: false }))).toBe('location_in_use');
    expect(await codeOf(updateLocation(asAdmin, main, { active: false }))).toBe('location_in_use');
    const spare = await createLocation(asAdmin, { name: 'Spare' });
    expect((await updateLocation(asAdmin, spare.id, { active: false })).active).toBe(false);
    expect(await codeOf(transferStock(asAdmin, { clientKey: key(), fromLocationId: main, toLocationId: spare.id, variantId: tea, quantity: 1, note: null }))).toBe('location_inactive');
  });

  it('another workspace cannot see or move this stock', async () => {
    const theirs = await listLocations(asOwnerB);
    expect(theirs).toHaveLength(1);
    expect(theirs[0]).toMatchObject({ is_default: true, units: 9 });
    expect(theirs[0].id).not.toBe(main);
    expect(await app(asOwnerB, (tx) => listTransfers(tx, accountB))).toEqual([]);
    expect(await app(asOwnerB, (tx) => tx.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM stock_location_levels`)).toEqual([{ n: 0 }]);
    expect(await app(asOwnerB, (tx) => tx.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM stock_transfers`)).toEqual([{ n: 0 }]);
    const before = await expectBalanced(tea);
    // A's location ids and A's variant, from B: not found, and nothing moves.
    expect(await codeOf(transferStock(asOwnerB, { clientKey: key(), fromLocationId: shed, toLocationId: shelf, variantId: tea, quantity: 1, note: null }))).toBe('not_found');
    expect(await codeOf(transferStock(asOwnerB, { clientKey: key(), fromLocationId: theirs[0].id, toLocationId: shelf, variantId: other, quantity: 1, note: null }))).toBe('not_found');
    expect(await codeOf(updateLocation(asOwnerB, shed, { name: 'Taken' }))).toBe('not_found');
    expect(await variantLocations(asOwnerB, tea)).toEqual([expect.objectContaining({ is_default: true, quantity: 0 })]);
    expect(await expectBalanced(tea)).toEqual(before);
  });

  // ------------------------------------------------------------------ purchase orders

  let po = '', teaLine = '', goneLine = '';

  it('creates a draft purchase order and guards it by role and workspace', async () => {
    const lines = [{ variantId: tea, qtyOrdered: 10, unitCostMinor: 4000 }, { variantId: gone, qtyOrdered: 5, unitCostMinor: 12000 }];
    await expect(createPurchaseOrder(asAgent, { supplierName: 'Herbs Co', reference: null, note: null, lines })).rejects.toThrow(/role|turned off/i);
    expect(await codeOf(createPurchaseOrder(asAdmin, { supplierName: 'Herbs Co', reference: null, note: null, lines: [{ variantId: other, qtyOrdered: 1, unitCostMinor: 0 }] })))
      .toBe('not_tracked');
    const order = await createPurchaseOrder(asAdmin, { supplierName: 'Herbs Co', reference: 'PO-7', note: null, lines });
    po = order.id;
    teaLine = order.lines.find((l) => l.variant_id === tea)!.id;
    goneLine = order.lines.find((l) => l.variant_id === gone)!.id;
    expect(order).toMatchObject({ status: 'draft', currency: 'INR', units_ordered: 15, units_received: 0, total_cost_minor: 100000 });
    // An agent can read it; another workspace cannot see, change or receive it.
    expect((await app(asAgent, (tx) => listPurchaseOrders(tx, accountA))).map((o) => o.id)).toEqual([po]);
    expect(await app(asOwnerB, (tx) => listPurchaseOrders(tx, accountB))).toEqual([]);
    expect(await codeOf(app(asOwnerB, (tx) => getPurchaseOrder(tx, accountB, po)))).toBe('not_found');
    expect(await codeOf(changePurchaseOrderStatus(asOwnerB, po, 'order'))).toBe('not_found');
    expect(await codeOf(receivePurchaseOrder(asOwnerB, po, { requestKey: key(), locationId: null, lines: [{ lineId: teaLine, quantity: 1 }] }))).toBe('not_found');
    await expect(app(asAdmin, (tx) => tx.$executeRaw`UPDATE purchase_order_lines SET qty_received=1 WHERE account_id=${accountA}::uuid`)).rejects.toThrow();
  });

  it('receives nothing before the order is placed, and edits nothing after', async () => {
    expect(await codeOf(receivePurchaseOrder(asAdmin, po, { requestKey: key(), locationId: null, lines: [{ lineId: teaLine, quantity: 1 }] }))).toBe('po_state');
    expect(await codeOf(changePurchaseOrderStatus(asAdmin, po, 'close'))).toBe('po_state');
    await expect(changePurchaseOrderStatus(asAgent, po, 'order')).rejects.toThrow(/role|turned off/i);
    expect((await changePurchaseOrderStatus(asAdmin, po, 'order')).status).toBe('ordered');
    expect(await codeOf(updatePurchaseOrder(asAdmin, po, { supplierName: 'Changed', reference: null, note: null, lines: [{ variantId: tea, qtyOrdered: 99, unitCostMinor: 1 }] })))
      .toBe('po_state');
    expect(await codeOf(changePurchaseOrderStatus(asAdmin, po, 'order'))).toBe('po_state');
  });

  it('receiving adds stock at the chosen location, writes the ledger and wakes back-in-stock alerts', async () => {
    // A customer waits for the sold-out variant (a claimed alert).
    await db.query(`INSERT INTO shop_stock_alerts(account_id,code,variant_id,contact_id,expires_at,claimed_at,claim_expires_at)
      VALUES($1,'ABCDEF',$2,$3,now() + interval '2 days',now(),now() + interval '90 days')`, [accountA, gone, contacts[0]]);
    const teaBefore = await onHand(tea);
    await expect(receivePurchaseOrder(asAgent, po, { requestKey: key(), locationId: shed, lines: [{ lineId: teaLine, quantity: 1 }] })).rejects.toThrow(/role|turned off/i);
    const requestKey = key();
    const input = { requestKey, locationId: shed, lines: [{ lineId: teaLine, quantity: 4 }, { lineId: goneLine, quantity: 2 }] };
    const first = await receivePurchaseOrder(asAdmin, po, input);
    expect(first.replayed).toBe(false);
    expect(first.order).toMatchObject({ status: 'partially_received', units_received: 6 });
    expect(await onHand(tea)).toBe(teaBefore + 4);
    expect(await onHand(gone)).toBe(2);
    expect(await expectBalanced(tea)).toMatchObject({ Shed: 6 });
    expect(await expectBalanced(gone)).toMatchObject({ Shed: 2 });
    // The existing stock ledger has one receipt movement per line, by the admin, naming the purchase order.
    const { rows: moves } = await db.query(
      `SELECT id::text AS id, variant_id::text AS variant_id, quantity, on_hand_after, reason, actor_user_id::text AS actor FROM inventory_movements
       WHERE account_id=$1 AND kind='receipt' AND reason='PO PO-7' ORDER BY quantity`, [accountA]);
    expect(moves.map((m) => [m.variant_id, m.quantity, m.on_hand_after, m.actor])).toEqual([[gone, 2, 2, adminA], [tea, 4, teaBefore + 4, adminA]]);
    // The same trigger a manual stock edit uses queued the back-in-stock job for the variant that had none.
    const { rows: jobs } = await db.query(`SELECT dedupe_key, payload FROM jobs WHERE tenant_id=$1 AND type='commerce.back_in_stock'`, [accountA]);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ dedupe_key: `bis:${gone}:${moves[0].id}`, payload: { variantId: gone } });

    // A replayed request key changes nothing: no stock, no movement, no second job.
    const replay = await receivePurchaseOrder(asAdmin, po, input);
    expect(replay.replayed).toBe(true);
    expect(replay.order.units_received).toBe(6);
    const twins = await Promise.all([receivePurchaseOrder(asAdmin, po, input), receivePurchaseOrder(asAdmin, po, input)]);
    expect(twins.every((r) => r.replayed)).toBe(true);
    expect(await onHand(tea)).toBe(teaBefore + 4);
    expect(await onHand(gone)).toBe(2);
    expect((await db.query(`SELECT count(*)::int AS n FROM inventory_movements WHERE account_id=$1 AND kind='receipt' AND reason='PO PO-7'`, [accountA])).rows[0].n).toBe(2);
    expect((await db.query('SELECT count(*)::int AS n FROM purchase_order_receipts WHERE account_id=$1', [accountA])).rows[0].n).toBe(1);
    expect((await db.query(`SELECT count(*)::int AS n FROM jobs WHERE tenant_id=$1 AND type='commerce.back_in_stock'`, [accountA])).rows[0].n).toBe(1);
  });

  it('never receives more than was ordered, even from two requests at once', async () => {
    const teaBefore = await onHand(tea);
    expect(await codeOf(receivePurchaseOrder(asAdmin, po, { requestKey: key(), locationId: null, lines: [{ lineId: teaLine, quantity: 7 }] }))).toBe('over_receive');
    expect(await codeOf(receivePurchaseOrder(asAdmin, po, { requestKey: key(), locationId: main, lines: [{ lineId: teaLine, quantity: 1 }, { lineId: teaLine, quantity: 1 }] }))).toBe('invalid');
    expect(await codeOf(receivePurchaseOrder(asAdmin, po, { requestKey: key(), locationId: randomUUID(), lines: [{ lineId: teaLine, quantity: 1 }] }))).toBe('not_found');
    expect(await onHand(tea)).toBe(teaBefore);
    // 6 of the tea are still due. Two different requests for 4 each: only one fits.
    const results = await Promise.all([1, 2].map(() => codeOf(receivePurchaseOrder(asAdmin, po, { requestKey: key(), locationId: null, lines: [{ lineId: teaLine, quantity: 4 }] }))));
    expect(results.sort()).toEqual(['ok', 'over_receive']);
    expect(await onHand(tea)).toBe(teaBefore + 4);
    await expectBalanced(tea);
    const now = await app(asAdmin, (tx) => getPurchaseOrder(tx, accountA, po));
    expect(now.lines.find((l) => l.id === teaLine)).toMatchObject({ qty_ordered: 10, qty_received: 8 });
    expect((await db.query('SELECT count(*)::int AS n FROM purchase_order_lines WHERE account_id=$1 AND qty_received > qty_ordered', [accountA])).rows[0].n).toBe(0);
  });

  it('completes, closes and then refuses further receipts; a placed order with nothing received can be cancelled', async () => {
    const done = await receivePurchaseOrder(asAdmin, po, { requestKey: key(), locationId: null, lines: [{ lineId: teaLine, quantity: 2 }, { lineId: goneLine, quantity: 3 }] });
    expect(done.order).toMatchObject({ status: 'received', units_received: 15 });
    expect(await codeOf(receivePurchaseOrder(asAdmin, po, { requestKey: key(), locationId: null, lines: [{ lineId: teaLine, quantity: 1 }] }))).toBe('po_state');
    expect(await codeOf(changePurchaseOrderStatus(asAdmin, po, 'cancel'))).toBe('po_state');
    expect((await changePurchaseOrderStatus(asAdmin, po, 'close')).status).toBe('closed');
    await expectBalanced(tea);
    await expectBalanced(gone);

    const second = await createPurchaseOrder(asAdmin, { supplierName: 'Oils Ltd', reference: null, note: null, lines: [{ variantId: oil, qtyOrdered: 3, unitCostMinor: 0 }] });
    const edited = await updatePurchaseOrder(asAdmin, second.id, { supplierName: 'Oils Ltd', reference: 'B-2', note: 'rush', lines: [{ variantId: oil, qtyOrdered: 4, unitCostMinor: 500 }] });
    expect(edited).toMatchObject({ reference: 'B-2', units_ordered: 4, total_cost_minor: 2000 });
    await changePurchaseOrderStatus(asAdmin, second.id, 'order');
    expect((await changePurchaseOrderStatus(asAdmin, second.id, 'cancel')).status).toBe('cancelled');
    expect(await codeOf(receivePurchaseOrder(asAdmin, second.id, { requestKey: key(), locationId: null, lines: [{ lineId: edited.lines[0].id, quantity: 1 }] }))).toBe('po_state');
    expect(await onHand(oil)).toBe(6);
  });

  // ------------------------------------------------------------------ pickup and local delivery

  const delivery: DeliveryOptions = {
    pickup_enabled: true, pickup_address: '12 Church Street, Bengaluru', pickup_instructions: 'Open 10 to 6', local_enabled: true, local_fee_minor: 2500,
    local_postal_prefixes: ['560'],
  };

  it('only an admin of the workspace sets the delivery options', async () => {
    await expect(saveDeliveryOptions(asAgent, delivery)).rejects.toThrow();
    expect(await getDeliveryOptions(asAgent)).toMatchObject({ pickup_enabled: false, local_enabled: false });
    expect(await saveDeliveryOptions(asAdmin, delivery)).toEqual(delivery);
    expect(await getDeliveryOptions(asOwnerB)).toMatchObject({ pickup_enabled: false, local_enabled: false, local_fee_minor: 0 });
    expect(await app(asOwnerB, (tx) => tx.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM shop_delivery_options`)).toEqual([{ n: 0 }]);
  });

  it('the stored order equals the quote with the local delivery fee', async () => {
    const s = await readySession(contacts[1], '560001', 'local');
    // 2 x 300.00 + 25.00 local delivery, 10% tax on both, prices exclude tax.
    expect(s.quote).toMatchObject({ deliveryMethod: 'local', subtotalMinor: 60000, shippingMinor: 2500, taxMinor: 6250, totalMinor: 68750 });
    const placed = await placeOrder(accountA, s.sessionId, { expectedVersion: s.version, expectedTotalMinor: s.quote.totalMinor, clientRequestId: randomUUID() });
    const { rows: [order] } = await db.query(
      'SELECT delivery_method, subtotal_minor::int AS subtotal, shipping_minor::int AS shipping, tax_minor::int AS tax, total_minor::int AS total FROM orders WHERE id=$1', [placed.orderId]);
    expect(order).toEqual({ delivery_method: 'local', subtotal: s.quote.subtotalMinor, shipping: s.quote.shippingMinor, tax: s.quote.taxMinor, total: s.quote.totalMinor });
    expect(await worker((tx) => loadOrderView(tx, accountA, placed.orderId))).toMatchObject({ deliveryMethod: 'local', pickup: null, shippingMinor: 2500, totalMinor: 68750 });
    // A total the browser made up (the fee left out) is refused: the server prices the choice.
    const cheat = await readySession(contacts[2], '560002', 'local');
    await expect(placeOrder(accountA, cheat.sessionId, { expectedVersion: cheat.version, expectedTotalMinor: cheat.quote.totalMinor - 2750, clientRequestId: randomUUID() }))
      .rejects.toMatchObject({ code: 'quote_changed' });
  });

  it('a pickup order has no delivery charge and shows where to collect', async () => {
    const s = await readySession(contacts[2], '110001', 'pickup');
    expect(s.quote).toMatchObject({ deliveryMethod: 'pickup', shippingMinor: 0, totalMinor: 66000 });
    const view = await worker((tx) => loadStorefrontView(tx, accountA, s.sessionId, undefined, { catalogue: false }));
    expect(view?.delivery).toEqual({ method: 'pickup', methods: ['ship', 'pickup'], pickupAddress: delivery.pickup_address, pickupInstructions: delivery.pickup_instructions, localFeeMinor: 2500 });
    const placed = await placeOrder(accountA, s.sessionId, { expectedVersion: s.version, expectedTotalMinor: s.quote.totalMinor, clientRequestId: randomUUID() });
    const { rows: [order] } = await db.query('SELECT delivery_method, shipping_minor::int AS shipping, total_minor::int AS total FROM orders WHERE id=$1', [placed.orderId]);
    expect(order).toEqual({ delivery_method: 'pickup', shipping: 0, total: 66000 });
    expect(await worker((tx) => loadOrderView(tx, accountA, placed.orderId)))
      .toMatchObject({ deliveryMethod: 'pickup', pickup: { address: delivery.pickup_address, instructions: delivery.pickup_instructions } });
    // Once priced, the delivery method is frozen like the money: not even the table owner or the worker can change it.
    await expect(db.query(`UPDATE orders SET delivery_method='ship' WHERE id=$1`, [placed.orderId])).rejects.toThrow(/order_priced_frozen/);
    await expect(worker((tx) => tx.$executeRaw`UPDATE orders SET delivery_method='local' WHERE account_id=${accountA}::uuid AND id=${placed.orderId}::uuid`))
      .rejects.toThrow(/order_priced_frozen/);
    // The other frozen columns still are, and an unfrozen one (the status) still moves.
    await expect(db.query('UPDATE orders SET shipping_minor=1 WHERE id=$1', [placed.orderId])).rejects.toThrow(/order_priced_frozen/);
    await expect(db.query(`UPDATE orders SET payment_method='cod' WHERE id=$1`, [placed.orderId])).rejects.toThrow(/order_priced_frozen/);
    await db.query(`UPDATE orders SET note='collect after 5' WHERE id=$1`, [placed.orderId]);
    expect((await db.query('SELECT delivery_method FROM orders WHERE id=$1', [placed.orderId])).rows[0].delivery_method).toBe('pickup');
  });

  it('refuses local delivery outside its postal codes, and a method the store turned off', async () => {
    const s = await readySession(contacts[3], '110001', 'ship');
    expect(s.quote).toMatchObject({ deliveryMethod: 'ship', shippingMinor: 5000 });
    await expect(worker((tx) => setDeliveryMethodTx(tx, accountA, s.sessionId, { expectedVersion: s.version, deliveryMethod: 'local' }))).rejects.toMatchObject({ code: 'delivery_unavailable' });
    await expect(worker((tx) => setDeliveryMethodTx(tx, accountA, s.sessionId, { expectedVersion: s.version, deliveryMethod: 'drone' }))).rejects.toMatchObject({ code: 'invalid' });
    // Chosen while in reach, then the address moves away: the quote refuses instead of charging a fee for a delivery that cannot happen.
    await worker((tx) => setAddressTx(tx, accountA, s.sessionId, { expectedVersion: s.version, address: address('560099') }));
    await worker((tx) => setDeliveryMethodTx(tx, accountA, s.sessionId, { expectedVersion: s.version + 1, deliveryMethod: 'local' }));
    await worker((tx) => setAddressTx(tx, accountA, s.sessionId, { expectedVersion: s.version + 2, address: address('110001') }));
    const moved = await worker(async (tx) => (await quoteSessionTx(tx, accountA, (await loadSession(tx, accountA, s.sessionId))!)).result);
    expect(moved).toEqual({ ok: false, code: 'delivery_unavailable' });
    await expect(placeOrder(accountA, s.sessionId, { expectedVersion: s.version + 3, expectedTotalMinor: 0, clientRequestId: randomUUID() }))
      .rejects.toMatchObject({ code: 'delivery_unavailable' });
    // The store turns pickup off after a buyer chose it: that quote is refused too.
    await worker((tx) => setDeliveryMethodTx(tx, accountA, s.sessionId, { expectedVersion: s.version + 3, deliveryMethod: 'pickup' }));
    await saveDeliveryOptions(asAdmin, { ...delivery, pickup_enabled: false });
    const off = await worker(async (tx) => (await quoteSessionTx(tx, accountA, (await loadSession(tx, accountA, s.sessionId))!)).result);
    expect(off).toEqual({ ok: false, code: 'delivery_unavailable' });
  });
});
