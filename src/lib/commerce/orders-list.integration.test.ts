import { createHash, randomUUID } from 'node:crypto';
import { config } from 'dotenv';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { disconnectDatabases, getPrisma } from '@/lib/db/prisma';
import type { TenantContext } from '@/lib/db/tenant';
import { bulkCreateShipments, bulkLabelUrls } from '@/lib/fulfilment/bulk-dispatch';
import { exportOrdersCsv } from './order-export';
import { listOrders, parseOrderFilters, type OrderFilters } from './orders';
import { listQuotes } from './quotes';
import { listReturnQueue } from './returns-queue';
import { revokeStorefrontSession } from './storefront';

// Batch 4 orders list on PostgreSQL: the payment, cash-due and date filters run in SQL inside the caller's
// workspace (another workspace's orders never appear, whatever the filter), the returns queue, revoking a
// quote (role and workspace), and bulk shipment creation never making a second shipment for an order.
const configured = config({ path: '.env.test', quiet: true }).parsed;
const ownerUrl = process.env.TEST_DATABASE_URL;
const appUrl = process.env.TEST_APP_DATABASE_URL || configured?.DATABASE_URL;
const workerUrl = process.env.TEST_WORKER_DATABASE_URL || configured?.WORKER_DATABASE_URL;
if (appUrl) process.env.DATABASE_URL = appUrl;
if (workerUrl) process.env.WORKER_DATABASE_URL = workerUrl;

const accountA = randomUUID(), accountB = randomUUID();
const adminA = randomUUID(), agentA = randomUUID(), viewerA = randomUUID(), ownerB = randomUUID();
const users = [adminA, agentA, viewerA, ownerB];
const asAdmin = { accountId: accountA, userId: adminA, role: 'admin' } as const;
const asAgent = { accountId: accountA, userId: agentA, role: 'agent' } as const;
const asViewer = { accountId: accountA, userId: viewerA, role: 'viewer' } as const;
const asB = { accountId: accountB, userId: ownerB, role: 'owner' } as const;
const contactA = randomUUID(), contactB = randomUUID();
const ADDRESS = { name: 'Asha Rao', phone: '+91 98765 43210', line1: '12 MG Road', line2: null, city: 'Bengaluru', state: 'Karnataka',
  state_code: 'KA', postal_code: '560001', country: 'IN', instructions: null };

let db: pg.Client;
const one = async (sql: string, values: unknown[] = []) => (await db.query(sql, values)).rows[0];

interface Seed { source?: string; status: string; method?: 'online' | 'cod'; paid?: boolean; refund?: 'none' | 'partial' | 'full'; daysAgo?: number }
async function order(account: string, seed: Seed): Promise<string> {
  const id = randomUUID();
  await db.query(`INSERT INTO orders(id,account_id,source,contact_id,currency,subtotal_minor,total_minor,status,payment_method,paid_at,
      refund_state,created_at) VALUES($1,$2,$3,$4,'INR',10000,10000,$5,$6,CASE WHEN $7 THEN now() END,$8,now() - ($9::int * interval '1 day'))`,
  [id, account, seed.source ?? 'storefront', account === accountA ? contactA : contactB, seed.status, seed.method ?? 'online',
    seed.paid ?? false, seed.refund ?? 'none', seed.daysAgo ?? 0]);
  return id;
}

/** A priced, paid order ready for a courier (the shape requestShipment needs). */
async function shippable(account: string): Promise<string> {
  const id = randomUUID();
  await db.query(`INSERT INTO orders(id,account_id,source,contact_id,currency,subtotal_minor,shipping_minor,tax_minor,tax_inclusive,total_minor,
      status,priced_at,paid_at,amount_paid_minor,shipping_address,delivery_method)
    VALUES($1,$2,'storefront',$3,'INR',49800,5000,0,true,54800,'paid',now(),now(),54800,$4,'ship')`,
  [id, account, account === accountA ? contactA : contactB, JSON.stringify(ADDRESS)]);
  await db.query(`INSERT INTO order_items(account_id,order_id,name,sku,hsn_code,quantity,unit_price_minor,currency,tax_rate_bps)
    VALUES($1,$2,'Triphala churna','TRI-100','3004',2,24900,'INR',1200)`, [account, id]);
  return id;
}

const ids = async (ctx: TenantContext, filters: OrderFilters) => (await listOrders(ctx, { ...filters, limit: 100 })).orders.map((o) => o.id).sort();
const sorted = (...values: string[]) => [...values].sort();

describe.skipIf(!ownerUrl || !appUrl || !workerUrl)('orders list on PostgreSQL', { timeout: 120_000 }, () => {
  const o: Record<string, string> = {};
  const b: Record<string, string> = {};

  beforeAll(async () => {
    db = new pg.Client({ connectionString: ownerUrl });
    await db.connect();
    if (!/test/i.test((await db.query('SELECT current_database() AS name')).rows[0].name)) throw new Error('Requires an isolated test database');
    const role = await getPrisma().$queryRaw<{ role: string }[]>`SELECT current_user AS role`;
    if (role[0].role !== 'bodhinox_app') throw new Error('Requires constrained test app credentials');
    await db.query("INSERT INTO auth_users(id,email,full_name,password_hash) SELECT x, x::text || '@example.invalid', 'Orders list', 'test-only-hash' FROM unnest($1::uuid[]) x", [users]);
    await db.query("INSERT INTO accounts(id,name,owner_user_id) VALUES($1,'List A',$2),($3,'List B',$4)", [accountA, adminA, accountB, ownerB]);
    await db.query("INSERT INTO account_memberships(account_id,user_id,role) VALUES($1,$2,'admin'),($1,$3,'agent'),($1,$4,'viewer'),($5,$6,'owner')",
      [accountA, adminA, agentA, viewerA, accountB, ownerB]);
    await db.query("INSERT INTO contacts(id,account_id,user_id,name,phone) VALUES($1,$2,$3,'Asha','919876543210'),($4,$5,$6,'Other','919800000000')",
      [contactA, accountA, adminA, contactB, accountB, ownerB]);

    o.paid = await order(accountA, { status: 'paid', paid: true });
    o.waiting = await order(accountA, { status: 'awaiting_payment' });
    o.refunded = await order(accountA, { status: 'cancelled', paid: true, refund: 'full' });
    o.partly = await order(accountA, { status: 'fulfilled', paid: true, refund: 'partial' });
    o.codConfirmed = await order(accountA, { status: 'confirmed', method: 'cod' });
    o.codDelivered = await order(accountA, { status: 'fulfilled', method: 'cod' });
    o.codPaid = await order(accountA, { status: 'fulfilled', method: 'cod', paid: true });
    o.codCancelled = await order(accountA, { status: 'cancelled', method: 'cod' });
    o.manualConfirmed = await order(accountA, { source: 'manual', status: 'confirmed' });
    o.manualPaid = await order(accountA, { source: 'manual', status: 'paid', paid: true });
    o.onlineCancelled = await order(accountA, { status: 'cancelled' });
    o.old = await order(accountA, { status: 'paid', paid: true, daysAgo: 40 });
    // Account B has one order of every kind the filters look for: none may ever reach account A.
    b.paid = await order(accountB, { status: 'paid', paid: true });
    b.cod = await order(accountB, { status: 'fulfilled', method: 'cod' });
    b.manual = await order(accountB, { source: 'manual', status: 'confirmed' });
    b.refunded = await order(accountB, { status: 'cancelled', paid: true, refund: 'full' });
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

  describe('filters', () => {
    it('applies each payment state in SQL, with the count', async () => {
      expect(await ids(asAgent, { payment: 'paid' })).toEqual(sorted(o.paid, o.codPaid, o.manualPaid, o.old));
      expect(await ids(asAgent, { payment: 'waiting' })).toEqual(sorted(o.waiting, o.manualConfirmed));
      expect(await ids(asAgent, { payment: 'refunded' })).toEqual(sorted(o.refunded));
      expect(await ids(asAgent, { payment: 'partly_refunded' })).toEqual(sorted(o.partly));
      expect(await ids(asAgent, { payment: 'cod' })).toEqual(sorted(o.codConfirmed, o.codDelivered));
      expect((await listOrders(asAgent, { payment: 'paid', limit: 1 })).total).toBe(4);
    });

    it('cash due: unpaid COD confirmed, shipped or delivered, and manual orders still confirmed', async () => {
      expect(await ids(asAgent, { cashDue: true })).toEqual(sorted(o.codConfirmed, o.codDelivered, o.manualConfirmed));
      expect(await ids(asAgent, parseOrderFilters(new URLSearchParams('cash_due=1&source=manual')))).toEqual([o.manualConfirmed]);
      // Recording the cash clears it.
      await db.query('UPDATE orders SET paid_at=now() WHERE id=$1', [o.codDelivered]);
      expect(await ids(asAgent, { cashDue: true })).not.toContain(o.codDelivered);
      await db.query('UPDATE orders SET paid_at=NULL WHERE id=$1', [o.codDelivered]);
    });

    it('applies the date range, inclusive at both ends', async () => {
      const recent = await ids(asAgent, { from: new Date(Date.now() - 7 * 86_400_000) });
      expect(recent).toContain(o.paid);
      expect(recent).not.toContain(o.old);
      expect(await ids(asAgent, { to: new Date(Date.now() - 30 * 86_400_000) })).toEqual([o.old]);
      expect(await ids(asAgent, { payment: 'paid', from: new Date(Date.now() - 41 * 86_400_000), to: new Date(Date.now() - 39 * 86_400_000) })).toEqual([o.old]);
    });

    it('pages with a count on the first page only and keeps every row once', async () => {
      const first = await listOrders(asAgent, { limit: 5 });
      expect(first.total).toBe(Object.keys(o).length);
      const second = await listOrders(asAgent, { limit: 100, cursor: first.next_cursor! });
      expect(second.total).toBeNull();
      expect(new Set([...first.orders, ...second.orders].map((r) => r.id)).size).toBe(Object.keys(o).length);
    });

    it('never shows another workspace’s orders, whatever the filter, and the export follows the same filters', async () => {
      const theirs = Object.values(b);
      for (const filters of [{}, { payment: 'paid' }, { payment: 'cod' }, { payment: 'waiting' }, { payment: 'refunded' }, { cashDue: true },
        { from: new Date(Date.now() - 86_400_000) }] as OrderFilters[]) {
        const mine = await ids(asAgent, filters);
        expect(mine.some((id) => theirs.includes(id))).toBe(false);
        expect(mine.some((id) => (Object.values(o) as string[]).includes(id) === false)).toBe(false);
      }
      expect(await ids(asB, { cashDue: true })).toEqual(sorted(b.cod, b.manual));
      const csv = await exportOrdersCsv(asAdmin, { cashDue: true });
      expect(csv.rows).toBe(3);
      expect(csv.truncated).toBe(false);
    });
  });

  describe('returns queue', () => {
    it('lists returns with their order, by status, in the caller workspace only', async () => {
      const item = randomUUID();
      const lines = JSON.stringify([{ order_item_id: item, qty: 2 }]);
      const requested = (await one(`INSERT INTO order_returns(account_id,order_id,items,status,source,client_request_id,reason)
        VALUES($1,$2,$3::jsonb,'requested','buyer',$4,'damaged') RETURNING id`,
        [accountA, o.codDelivered, lines, randomUUID()])).id;
      const closed = (await one(`INSERT INTO order_returns(account_id,order_id,items,status) VALUES($1,$2,$3::jsonb,'closed') RETURNING id`,
        [accountA, o.partly, lines])).id;
      const other = (await one(`INSERT INTO order_returns(account_id,order_id,items,status) VALUES($1,$2,$3::jsonb,'requested') RETURNING id`,
        [accountB, b.cod, lines])).id;

      const open = await listReturnQueue(asAgent, { status: 'open', page: 0 });
      expect(open.total).toBe(1);
      expect(open.returns).toEqual([expect.objectContaining({
        id: requested, order_id: o.codDelivered, status: 'requested', source: 'buyer', pending_approval: true, units: 2, contact_name: 'Asha',
      })]);
      expect((await listReturnQueue(asAgent, { status: 'closed', page: 0 })).returns.map((r) => r.id)).toEqual([closed]);
      const all = await listReturnQueue(asAgent, { page: 0 });
      expect(all.returns.map((r) => r.id).sort()).toEqual(sorted(requested, closed));
      expect(all.returns.map((r) => r.id)).not.toContain(other);
      expect((await listReturnQueue(asAgent, { page: 1 })).returns).toEqual([]);
      expect((await listReturnQueue(asB, { page: 0 })).returns.map((r) => r.id)).toEqual([other]);
    });
  });

  describe('quote revoke', () => {
    async function quote(account: string, contact: string): Promise<string> {
      const id = randomUUID();
      await db.query(`INSERT INTO storefront_sessions(id,account_id,token_hash,contact_id,purpose,expires_at,is_quote,quote_note)
        VALUES($1,$2,$3,$4,'shop',now() + interval '2 days',true,'Your quote')`,
      [id, account, createHash('sha256').update(id).digest('hex'), contact]);
      return id;
    }

    it('lets an agent revoke an open quote; a viewer and another workspace cannot touch it', async () => {
      const mine = await quote(accountA, contactA);
      expect((await listQuotes(asAgent)).find((q) => q.id === mine)?.state).toBe('open');

      await expect(revokeStorefrontSession(asViewer, mine)).rejects.toBeTruthy();
      await expect(revokeStorefrontSession(asB, mine)).rejects.toMatchObject({ code: 'not_found' });
      expect((await one('SELECT revoked_at FROM storefront_sessions WHERE id=$1', [mine])).revoked_at).toBeNull();
      expect((await listQuotes(asB)).map((q) => q.id)).not.toContain(mine);

      await revokeStorefrontSession(asAgent, mine);
      expect((await listQuotes(asAgent)).find((q) => q.id === mine)?.state).toBe('revoked');
      expect((await one("SELECT count(*)::int AS n FROM audit_logs WHERE account_id=$1 AND action='commerce.storefront_link_revoked' AND resource_id=$2",
        [accountA, mine])).n).toBe(1);
    });
  });

  describe('bulk dispatch', () => {
    it('creates one shipment per order, never a second on a repeat, and refuses other roles and workspaces', async () => {
      await db.query(`INSERT INTO courier_connections(account_id,provider,status,api_email,pickup_location,default_length_cm,default_breadth_cm,
          default_height_cm,default_weight_grams) VALUES($1,'shiprocket','active','api@example.invalid','Primary',20,15,10,750)`, [accountA]);
      const first = await shippable(accountA);
      const second = await shippable(accountA);
      const unpaid = o.waiting;
      const foreign = await shippable(accountB);

      await expect(bulkCreateShipments(asAgent, [first])).rejects.toBeTruthy();
      expect((await one('SELECT count(*)::int AS n FROM order_shipments WHERE order_id=$1', [first])).n).toBe(0);

      const results = await bulkCreateShipments(asAdmin, [first, second, unpaid, foreign]);
      expect(results).not.toBe('no_defaults');
      const byOrder = new Map((results as Exclude<typeof results, 'no_defaults'>).map((r) => [r.order_id, r]));
      expect(byOrder.get(first)).toMatchObject({ ok: true });
      expect(byOrder.get(second)).toMatchObject({ ok: true });
      expect(byOrder.get(unpaid)).toEqual({ order_id: unpaid, ok: false, code: 'order_not_paid' });
      expect(byOrder.get(foreign)).toEqual({ order_id: foreign, ok: false, code: 'not_found' });
      // No catalogue weight on these items: the default weight was used.
      expect(await one('SELECT weight_grams, create_state FROM order_shipments WHERE order_id=$1', [first])).toEqual({ weight_grams: 750, create_state: 'creating' });
      // Queued before the answer: one create job per shipment.
      expect((await one(`SELECT count(*)::int AS n FROM jobs j JOIN order_shipments s ON s.id::text = j.payload->>'shipmentId'
        WHERE s.order_id = ANY($1::uuid[])`, [[first, second]])).n).toBe(2);

      const again = await bulkCreateShipments(asAdmin, [first, second]);
      expect(again).toEqual([
        { order_id: first, ok: false, code: 'shipment_exists' },
        { order_id: second, ok: false, code: 'shipment_exists' },
      ]);
      expect((await one('SELECT count(*)::int AS n FROM order_shipments WHERE order_id = ANY($1::uuid[])', [[first, second]])).n).toBe(2);
      expect((await one('SELECT count(*)::int AS n FROM order_shipments WHERE order_id=$1', [foreign])).n).toBe(0);

      // Labels: none until the courier assigned an AWB, and nothing for another workspace's order.
      const labels = await bulkLabelUrls(asAdmin, [first, foreign]);
      expect(labels).toEqual([{ order_id: first, ok: false, code: 'conflict' }, { order_id: foreign, ok: false, code: 'not_found' }]);
      await expect(bulkLabelUrls(asAgent, [first])).rejects.toBeTruthy();
    });

    it('touches no order without a default parcel size', async () => {
      await db.query('UPDATE courier_connections SET default_length_cm=NULL WHERE account_id=$1', [accountA]);
      const order = await shippable(accountA);
      expect(await bulkCreateShipments(asAdmin, [order])).toBe('no_defaults');
      expect((await one('SELECT count(*)::int AS n FROM order_shipments WHERE order_id=$1', [order])).n).toBe(0);
    });
  });
});
