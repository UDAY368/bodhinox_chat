import { randomUUID } from 'node:crypto';
import { config } from 'dotenv';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { disconnectDatabases, getPrisma } from '@/lib/db/prisma';
import type { TenantContext } from '@/lib/db/tenant';
import { commerceStats } from './commerce';
import { runAnalytics } from './queries';
import { parseRange } from './range';

// Phase 8 money metrics on PostgreSQL (PRD :204-208): the analytics totals
// come from the same ledger rows the reconciliation view sums per day, so
// collected, refunds (external included) and net always agree; the paid-order
// cohort excludes unpaid, out-of-range and other-tenant orders.
const configured = config({ path: '.env.test', quiet: true }).parsed;
const ownerUrl = process.env.TEST_DATABASE_URL;
const appUrl = process.env.TEST_APP_DATABASE_URL || configured?.DATABASE_URL;
const workerUrl = process.env.TEST_WORKER_DATABASE_URL || configured?.WORKER_DATABASE_URL;
if (appUrl) process.env.DATABASE_URL = appUrl;
if (workerUrl) process.env.WORKER_DATABASE_URL = workerUrl;

const A = randomUUID(), B = randomUUID();
const ownerA = randomUUID(), agentA = randomUUID(), viewerA = randomUUID(), ownerB = randomUUID();
const asAgent: TenantContext = { accountId: A, userId: agentA, role: 'agent' };
const asViewer: TenantContext = { accountId: A, userId: viewerA, role: 'viewer' };
const o = { inclusive: randomUUID(), exclusive: randomUUID(), early: randomUUID(), unpaid: randomUUID(), other: randomUUID() };
const p = { duplicate: randomUUID(), one: randomUUID(), two: randomUUID(), plain: randomUUID(), authorized: randomUUID(), early: randomUUID(), cash: randomUUID(), other: randomUUID() };
const range = parseRange({ from: '2026-10-01', to: '2026-10-07' }, 'UTC', new Date('2026-11-03T00:00:00Z'));
let db: pg.Client;

const q = (sql: string, params: unknown[] = []) => db.query(sql, params);
const payId = () => `pay_${randomUUID().replace(/-/g, '').slice(0, 14)}`;

async function order(id: string, account: string, f: { subtotal: number; discount: number; shipping: number; tax: number; inclusive: boolean;
  status: string; paidAt: string | null; itemTax: number }) {
  const total = f.subtotal - f.discount + f.shipping + (f.inclusive ? 0 : f.tax);
  await q(`INSERT INTO orders(id,account_id,source,currency,subtotal_minor,discount_minor,shipping_minor,tax_minor,tax_inclusive,total_minor,
      status,priced_at,paid_at,amount_paid_minor)
    VALUES($1,$2,'storefront','INR',$3,$4,$5,$6,$7,$8,$9,'2026-09-01T00:00:00Z',$10,$11)`,
  [id, account, f.subtotal, f.discount, f.shipping, f.tax, f.inclusive, total, f.status, f.paidAt, f.paidAt ? total : 0]);
  await q(`INSERT INTO order_items(account_id,order_id,sku,name,quantity,unit_price_minor,currency,tax_rate_bps,tax_minor,discount_minor,line_total_minor)
    VALUES($1,$2,'SKU-1','Item',1,$3,'INR',1800,$4,$5,$6)`, [account, id, f.subtotal, f.itemTax, f.discount, f.subtotal - f.discount]);
}
async function payment(id: string, account: string, f: { source: 'razorpay' | 'offline'; amount: number; status?: string; at: string;
  orderId?: string | null; settlement?: string }) {
  await q(`INSERT INTO customer_payments(id,account_id,source,provider_payment_id,order_id,amount_minor,currency,status,offline_reference,captured_at,settlement)
    VALUES($1,$2,$3,$4,$5,$6,'INR',$7,$8,$9,$10)`,
  [id, account, f.source, f.source === 'razorpay' ? payId() : null, f.orderId ?? null, f.amount, f.status ?? 'captured',
    f.source === 'offline' ? 'CASH-1' : null, f.status === 'authorized' ? null : f.at, f.settlement ?? 'settled']);
}
async function refund(account: string, paymentId: string, f: { amount: number; source: 'bodhinox' | 'external'; status: string; at: string; orderId?: string;
  credited?: boolean }) {
  // Mirrors applyRefundStateTx: a processed refund of a settled payment adds to the order's amount_refunded_minor.
  if (f.orderId && f.status === 'processed' && f.credited !== false) {
    await q('UPDATE orders SET amount_refunded_minor=amount_refunded_minor+$3 WHERE account_id=$1 AND id=$2', [account, f.orderId, f.amount]);
  }
  await q(`INSERT INTO customer_refunds(account_id,payment_id,order_id,source,amount_minor,currency,reason_code,status,processed_at,updated_at)
    VALUES($1,$2,$3,$4,$5,'INR','customer_request',$6,$7,COALESCE($7::timestamptz, now()))`,
  [account, paymentId, f.orderId ?? null, f.source, f.amount, f.status, f.status === 'processed' ? f.at : null]);
}

describe.skipIf(!ownerUrl || !appUrl || !workerUrl)('commerce analytics on PostgreSQL', { timeout: 120_000 }, () => {
  beforeAll(async () => {
    db = new pg.Client({ connectionString: ownerUrl });
    await db.connect();
    if (!/test/i.test((await q('SELECT current_database() AS name')).rows[0].name)) throw new Error('Requires an isolated test database');
    const app = await getPrisma().$queryRaw<{ role: string }[]>`SELECT current_user AS role`;
    if (app[0].role !== 'bodhinox_app') throw new Error('Requires constrained test app credentials');
    await q("INSERT INTO auth_users(id,email,full_name,password_hash) SELECT x, x::text || '@example.invalid', 'Revenue', 'test-only-hash' FROM unnest($1::uuid[]) x",
      [[ownerA, agentA, viewerA, ownerB]]);
    await q("INSERT INTO accounts(id,name,owner_user_id) VALUES($1,'Revenue A',$2),($3,'Revenue B',$4)", [A, ownerA, B, ownerB]);
    await q("INSERT INTO account_memberships(account_id,user_id,role) VALUES($1,$2,'owner'),($1,$3,'agent'),($1,$4,'viewer'),($5,$6,'owner')",
      [A, ownerA, agentA, viewerA, B, ownerB]);

    // Prices include 18% tax: 1,180.00 less a 180.00 coupon plus 50.00 shipping; item tax 152.54 on 1,000.00.
    await order(o.inclusive, A, { subtotal: 118000, discount: 18000, shipping: 5000, tax: 16017, inclusive: true, status: 'paid',
      paidAt: '2026-10-02T10:00:00Z', itemTax: 15254 });
    // Prices exclude tax: 500.00 + 90.00 tax, later refunded in full from the Razorpay dashboard.
    await order(o.exclusive, A, { subtotal: 50000, discount: 0, shipping: 0, tax: 9000, inclusive: false, status: 'cancelled',
      paidAt: '2026-10-04T10:00:00Z', itemTax: 9000 });
    await order(o.early, A, { subtotal: 30000, discount: 0, shipping: 0, tax: 0, inclusive: false, status: 'paid', paidAt: '2026-09-20T10:00:00Z', itemTax: 0 });
    await order(o.unpaid, A, { subtotal: 40000, discount: 0, shipping: 0, tax: 0, inclusive: false, status: 'awaiting_payment', paidAt: null, itemTax: 0 });
    await order(o.other, B, { subtotal: 99900, discount: 0, shipping: 0, tax: 0, inclusive: false, status: 'paid', paidAt: '2026-10-03T10:00:00Z', itemTax: 0 });

    await payment(p.one, A, { source: 'razorpay', amount: 105000, at: '2026-10-02T10:00:00Z', orderId: o.inclusive });
    await payment(p.two, A, { source: 'razorpay', amount: 59000, at: '2026-10-04T10:00:00Z', orderId: o.exclusive });
    await payment(p.plain, A, { source: 'razorpay', amount: 50000, at: '2026-10-05T10:00:00Z', settlement: 'unattached' });
    await payment(p.cash, A, { source: 'offline', amount: 7000, at: '2026-10-06T10:00:00Z' });
    await payment(p.authorized, A, { source: 'razorpay', amount: 1000, status: 'authorized', at: '2026-10-05T10:00:00Z', settlement: 'pending' });
    await payment(p.early, A, { source: 'razorpay', amount: 3000, at: '2026-09-30T10:00:00Z' });
    await payment(p.other, B, { source: 'razorpay', amount: 99900, at: '2026-10-03T10:00:00Z', orderId: o.other });

    await refund(A, p.one, { amount: 20000, source: 'bodhinox', status: 'processed', at: '2026-10-03T10:00:00Z', orderId: o.inclusive });
    await refund(A, p.two, { amount: 59000, source: 'external', status: 'processed', at: '2026-10-06T12:00:00Z', orderId: o.exclusive });
    await refund(A, p.plain, { amount: 1000, source: 'bodhinox', status: 'requested', at: '2026-10-06T12:00:00Z' });
    // A second, duplicate payment on the first order (an exception, never credited to it), refunded in full after the range:
    // its refund carries the order_id but must not reduce that order's merchandise.
    await payment(p.duplicate, A, { source: 'razorpay', amount: 105000, at: '2026-10-09T10:00:00Z', orderId: o.inclusive, settlement: 'exception' });
    await refund(A, p.duplicate, { amount: 105000, source: 'bodhinox', status: 'processed', at: '2026-10-09T12:00:00Z', orderId: o.inclusive,
      credited: false });
    await refund(B, p.other, { amount: 500, source: 'bodhinox', status: 'processed', at: '2026-10-06T12:00:00Z', orderId: o.other });
  });

  afterAll(async () => {
    if (db) {
      await q('DELETE FROM accounts WHERE id=ANY($1::uuid[])', [[A, B]]);
      await q('DELETE FROM auth_users WHERE id=ANY($1::uuid[])', [[ownerA, agentA, viewerA, ownerB]]);
      await db.end();
    }
    await disconnectDatabases();
  });

  it('reports merchandise from the paid-order cohort and money from the ledger', async () => {
    const stats = await runAnalytics(asAgent, (tx) => commerceStats(tx, A, range));
    expect(stats.currencies).toEqual([{
      currency: 'INR',
      paidOrders: 2,
      grossMerchandiseMinor: 168000,
      discountsMinor: 18000,
      taxMinor: 25017,
      shippingMinor: 5000,
      // 200.00 on the first order; the second's 590.00 refund is capped at its 500.00 merchandise.
      merchandiseRefundsMinor: 70000,
      // (1,180.00 - 180.00 - 152.54 item tax - 200.00) + (500.00 - 500.00)
      netMerchandiseMinor: 64746,
      averageOrderValueMinor: 32373,
      collectedMinor: 221000,
      gatewayCollectedMinor: 214000,
      offlineCollectedMinor: 7000,
      refundsMinor: 79000,
      externalRefundsMinor: 59000,
      netCollectedMinor: 142000,
    }]);
  });

  it('per-day reconciliation sums to the same collected, refunds and net', async () => {
    const stats = await runAnalytics(asAgent, (tx) => commerceStats(tx, A, range));
    expect(stats.daily).toEqual([
      { day: '2026-10-02', currency: 'INR', collectedMinor: 105000, refundsMinor: 0 },
      { day: '2026-10-03', currency: 'INR', collectedMinor: 0, refundsMinor: 20000 },
      { day: '2026-10-04', currency: 'INR', collectedMinor: 59000, refundsMinor: 0 },
      { day: '2026-10-05', currency: 'INR', collectedMinor: 50000, refundsMinor: 0 },
      { day: '2026-10-06', currency: 'INR', collectedMinor: 7000, refundsMinor: 59000 },
    ]);
    const sum = (key: 'collectedMinor' | 'refundsMinor') => stats.daily.reduce((total, d) => total + d[key], 0);
    const [inr] = stats.currencies;
    expect(sum('collectedMinor')).toBe(inr.collectedMinor);
    expect(sum('refundsMinor')).toBe(inr.refundsMinor);
    expect(sum('collectedMinor') - sum('refundsMinor')).toBe(inr.netCollectedMinor);
    // The raw ledger agrees (captured payments and processed refunds, external included).
    const [ledger] = (await q(`SELECT
        (SELECT sum(amount_minor) FROM customer_payments WHERE account_id=$1 AND status='captured' AND captured_at >= $2 AND captured_at < $3)::bigint AS collected,
        (SELECT sum(amount_minor) FROM customer_refunds WHERE account_id=$1 AND status='processed' AND processed_at >= $2 AND processed_at < $3)::bigint AS refunds`,
    [A, range.from, range.to])).rows;
    expect([Number(ledger.collected), Number(ledger.refunds)]).toEqual([inr.collectedMinor, inr.refundsMinor]);
  });

  it('shows another workspace nothing of this one, and viewers no payments (the route needs agent)', async () => {
    const b = await runAnalytics({ accountId: B, userId: ownerB, role: 'owner' }, (tx) => commerceStats(tx, B, range));
    expect(b.currencies.map((c) => [c.paidOrders, c.collectedMinor, c.refundsMinor])).toEqual([[1, 99900, 500]]);
    const viewer = await runAnalytics(asViewer, (tx) => commerceStats(tx, A, range));
    expect(viewer.currencies.every((c) => c.collectedMinor === 0 && c.refundsMinor === 0)).toBe(true);
  });
});
