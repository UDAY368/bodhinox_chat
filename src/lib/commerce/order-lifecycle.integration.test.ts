import { randomUUID } from 'node:crypto';
import { config } from 'dotenv';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// Stock (T3) and refunds (T4) are other services with their own real-database
// tests; here they are spies so this file proves what the lifecycle asks of
// them, in which transaction state, and what it writes itself.
const h = vi.hoisted(() => ({
  releaseTx: vi.fn(async () => undefined),
  restockTx: vi.fn(async () => undefined),
  requestRefund: vi.fn(async () => ({ refundId: '' })),
}));
vi.mock('./stock', async (original) => ({ ...(await original<typeof import('./stock')>()), releaseTx: h.releaseTx, restockTx: h.restockTx }));
vi.mock('@/lib/payments/refunds', async (original) => ({
  ...(await original<typeof import('@/lib/payments/refunds')>()), requestRefund: h.requestRefund,
}));

import { disconnectDatabases, getPrisma } from '@/lib/db/prisma';
import { ForbiddenError } from '@/lib/auth/errors';
import { handleOrderFollowupJob } from './order-followup';
import {
  cancelAndRefund, getOrderTimeline, recordDelivery, recordDispatch, recordFeedback, transitionOrder, type StaffContext,
} from './order-lifecycle';
import { closeReturn, createReturn, inspectReturn, receiveReturn, refundReturn } from './returns';
import { updateOrder } from './orders';

// Order lifecycle on PostgreSQL (design §2, §3 T5): staff transitions are
// conditional and recorded as staff, cancelling releases stock and coupon and
// queues the link cancel in the same transaction, a paid order is cancelled
// only through Cancel and refund, dispatch/delivery queue the notices once,
// returns restock only on an admin close, and follow-ups refuse before sending.
const configured = config({ path: '.env.test', quiet: true }).parsed;
const ownerUrl = process.env.TEST_DATABASE_URL;
const appUrl = process.env.TEST_APP_DATABASE_URL || configured?.DATABASE_URL;
const workerUrl = process.env.TEST_WORKER_DATABASE_URL || configured?.WORKER_DATABASE_URL;
if (appUrl) process.env.DATABASE_URL = appUrl;
if (workerUrl) process.env.WORKER_DATABASE_URL = workerUrl;

const accountA = randomUUID(), accountB = randomUUID();
const ownerA = randomUUID(), adminA = randomUUID(), agentA = randomUUID(), viewerA = randomUUID(), ownerB = randomUUID();
const users = [ownerA, adminA, agentA, viewerA, ownerB];
const asAgent: StaffContext = { accountId: accountA, userId: agentA, role: 'agent' };
const asAdmin: StaffContext = { accountId: accountA, userId: adminA, role: 'admin' };
const asViewer: StaffContext = { accountId: accountA, userId: viewerA, role: 'viewer' };
const asOtherOwner: StaffContext = { accountId: accountB, userId: ownerB, role: 'owner' };
const contactA = randomUUID(), optedOut = randomUUID();
const productA = randomUUID(), variantA = randomUUID(), couponA = randomUUID();
const legacy = randomUUID(), awaiting = randomUUID(), paid = randomUUID(), refundable = randomUUID(), optedOrder = randomUUID();
const paidItem = randomUUID(), payment = randomUUID();
let db: pg.Client;

const statusOf = async (id: string) => (await db.query('SELECT status FROM orders WHERE id=$1', [id])).rows[0].status;
const jobs = async (prefix: string) => (await db.query(`SELECT type, payload, dedupe_key, run_at FROM jobs
  WHERE tenant_id=$1 AND dedupe_key LIKE $2 ORDER BY dedupe_key`, [accountA, `${prefix}%`])).rows;

async function pricedOrder(id: string, status: string, contact = contactA) {
  await db.query(`INSERT INTO orders(id,account_id,source,contact_id,currency,subtotal_minor,shipping_minor,tax_minor,tax_inclusive,
      total_minor,status,priced_at,paid_at,amount_paid_minor) VALUES($1,$2,'storefront',$3,'INR',99800,0,15223,true,99800,$4,now(),
      CASE WHEN $4 IN ('paid','dispatched','fulfilled') THEN now() END, CASE WHEN $4 IN ('paid','dispatched','fulfilled') THEN 99800 ELSE 0 END)`,
  [id, accountA, contact, status]);
}

describe.skipIf(!ownerUrl || !appUrl || !workerUrl)('order lifecycle on PostgreSQL', { timeout: 120_000 }, () => {
  beforeAll(async () => {
    db = new pg.Client({ connectionString: ownerUrl });
    await db.connect();
    if (!/test/i.test((await db.query('SELECT current_database() AS name')).rows[0].name)) throw new Error('Requires an isolated test database');
    const role = await getPrisma().$queryRaw<{ role: string }[]>`SELECT current_user AS role`;
    if (role[0].role !== 'bodhinox_app') throw new Error('Requires constrained test app credentials');
    await db.query("INSERT INTO auth_users(id,email,full_name,password_hash) SELECT x, x::text || '@example.invalid', 'P8 life', 'test-only-hash' FROM unnest($1::uuid[]) x", [users]);
    await db.query("INSERT INTO accounts(id,name,owner_user_id) VALUES($1,'Life A',$2),($3,'Life B',$4)", [accountA, ownerA, accountB, ownerB]);
    await db.query("INSERT INTO account_subscriptions(account_id,plan_id) VALUES($1,'basic'),($2,'basic')", [accountA, accountB]);
    await db.query(`INSERT INTO account_memberships(account_id,user_id,role) VALUES ($1,$2,'owner'),($1,$3,'admin'),($1,$4,'agent'),($1,$5,'viewer'),($6,$7,'owner')`,
      [accountA, ownerA, adminA, agentA, viewerA, accountB, ownerB]);
    await db.query(`INSERT INTO contacts(id,account_id,user_id,name,phone,opted_out_at) VALUES($1,$2,$3,'Asha','14155550911',NULL),
      ($4,$2,$3,'Ravi','14155550912',now() + interval '1 minute')`, [contactA, accountA, ownerA, optedOut]);
    await db.query(`INSERT INTO commerce_settings(account_id,currency,default_tax_rate_bps) VALUES($1,'INR',1800)`, [accountA]);
    await db.query(`INSERT INTO shop_products(id,account_id,name,follow_up_template,follow_up_template_language,follow_up_after_days)
      VALUES($1,$2,'Ashwagandha','refill_reminder','en',30)`, [productA, accountA]);
    await db.query(`INSERT INTO shop_variants(id,account_id,product_id,sku,price_minor) VALUES($1,$2,$3,'ASH-60',49900)`, [variantA, accountA, productA]);
    await db.query(`INSERT INTO coupons(id,account_id,code,kind,value) VALUES($1,$2,'WELCOME','percent',1000)`, [couponA, accountA]);
    await db.query(`INSERT INTO orders(id,account_id,source,contact_id,currency,subtotal_minor,total_minor,status)
      VALUES($1,$2,'manual',$3,'INR',1000,1000,'new')`, [legacy, accountA, contactA]);
    await pricedOrder(awaiting, 'awaiting_payment');
    await pricedOrder(paid, 'paid');
    await pricedOrder(refundable, 'paid');
    await pricedOrder(optedOrder, 'fulfilled', optedOut);
    await db.query(`INSERT INTO order_items(id,account_id,order_id,variant_id,sku,name,quantity,unit_price_minor,currency,line_total_minor)
      VALUES($1,$2,$3,$4,'ASH-60','Ashwagandha',2,49900,'INR',99800)`, [paidItem, accountA, paid, variantA]);
    await db.query(`INSERT INTO coupon_redemptions(account_id,coupon_id,order_id,contact_id,status) VALUES($1,$2,$3,$4,'reserved')`,
      [accountA, couponA, awaiting, contactA]);
    await db.query(`INSERT INTO payment_links(account_id,provider,reference_id,amount_minor,currency,order_id,status)
      VALUES($1,'razorpay',$2,99800,'INR',$3,'created'),($1,'razorpay',$4,99800,'INR',$3,'expired')`,
      [accountA, `co_${awaiting.replace(/-/g, '').slice(0, 20)}`, awaiting, `co_${randomUUID().replace(/-/g, '').slice(0, 20)}`]);
    await db.query(`INSERT INTO customer_payments(id,account_id,source,provider_payment_id,order_id,amount_minor,currency,status,captured_at,
      settlement,refunded_minor) VALUES($1,$2,'razorpay','pay_LifeTest0001',$3,99800,'INR','captured',now(),'settled',10000)`,
      [payment, accountA, refundable]);
    await db.query(`INSERT INTO customer_refunds(account_id,payment_id,order_id,source,amount_minor,currency,reason_code,status)
      VALUES($1,$2,$3,'bodhinox',5000,'INR','customer_request','pending')`, [accountA, payment, refundable]);
  });

  beforeEach(() => vi.clearAllMocks());

  afterAll(async () => {
    if (db) {
      await db.query('DELETE FROM jobs WHERE tenant_id=ANY($1::uuid[])', [[accountA, accountB]]);
      await db.query('DELETE FROM accounts WHERE id=ANY($1::uuid[])', [[accountA, accountB]]);
      await db.query('DELETE FROM auth_users WHERE id=ANY($1::uuid[])', [users]);
      await db.end();
    }
    await disconnectDatabases();
  });

  it('moves along the allowed transitions only, conditionally, recorded as the member', async () => {
    await expect(transitionOrder(asViewer, legacy, { from: 'new', to: 'confirmed' })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(transitionOrder(asAgent, legacy, { from: 'confirmed', to: 'cancelled' })).rejects.toMatchObject({ code: 'conflict' });
    await expect(transitionOrder(asAgent, legacy, { from: 'new', to: 'paid' })).rejects.toMatchObject({ code: 'bad_transition' });
    await expect(transitionOrder(asOtherOwner, legacy, { from: 'new', to: 'confirmed' })).rejects.toMatchObject({ code: 'not_found' });
    // Two agents at once: one wins, the other gets a conflict.
    const results = await Promise.allSettled([
      transitionOrder(asAgent, legacy, { from: 'new', to: 'confirmed' }),
      transitionOrder(asAdmin, legacy, { from: 'new', to: 'confirmed' }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.find((r) => r.status === 'rejected')).toMatchObject({ reason: { code: 'conflict' } });
    expect(await statusOf(legacy)).toBe('confirmed');
    const events = (await db.query(`SELECT kind, from_status, to_status, actor FROM order_events WHERE order_id=$1`, [legacy])).rows;
    expect(events).toEqual([{ kind: 'status_changed', from_status: 'new', to_status: 'confirmed', actor: 'staff' }]);
    const audit = (await db.query(`SELECT action, metadata FROM audit_logs WHERE account_id=$1 AND resource_id=$2`, [accountA, legacy])).rows;
    expect(audit).toEqual([{ action: 'order.status_changed', metadata: { from: 'new', to: 'confirmed' } }]);
  });

  it('cancels an order awaiting payment: releases stock and coupon and queues the open link cancel, together', async () => {
    await transitionOrder(asAgent, awaiting, { from: 'awaiting_payment', to: 'cancelled' });
    expect(h.releaseTx).toHaveBeenCalledTimes(1);
    expect(h.releaseTx).toHaveBeenCalledWith(expect.anything(), accountA, awaiting, 'cancelled');
    expect(await statusOf(awaiting)).toBe('cancelled');
    expect((await db.query('SELECT status FROM coupon_redemptions WHERE order_id=$1', [awaiting])).rows).toEqual([{ status: 'released' }]);
    const cancels = (await db.query(`SELECT j.payload->>'linkId' AS link, l.status FROM jobs j JOIN payment_links l ON l.id::text=j.payload->>'linkId'
      WHERE j.tenant_id=$1 AND j.type='payments.cancel_link'`, [accountA])).rows;
    expect(cancels).toEqual([{ link: expect.any(String), status: 'created' }]);
  });

  it('rolls the whole cancel back when stock cannot be released', async () => {
    const other = randomUUID();
    await pricedOrder(other, 'awaiting_payment');
    h.releaseTx.mockRejectedValueOnce(new Error('boom'));
    await expect(transitionOrder(asAgent, other, { from: 'awaiting_payment', to: 'cancelled' })).rejects.toThrow('boom');
    expect(await statusOf(other)).toBe('awaiting_payment');
  });

  it('never cancels a paid order through a plain status change', async () => {
    await expect(transitionOrder(asAdmin, paid, { from: 'paid', to: 'cancelled' })).rejects.toMatchObject({ code: 'bad_transition' });
    await expect(updateOrder(asAdmin, paid, { status: 'cancelled' })).rejects.toMatchObject({ code: 'bad_transition' });
    expect(await statusOf(paid)).toBe('paid');
  });

  it('records dispatch and delivery as staff and queues each notice once', async () => {
    await expect(recordDelivery(asAgent, paid, { from: 'paid' })).rejects.toMatchObject({ code: 'bad_transition' });
    await expect(recordDispatch(asAgent, paid, { from: 'paid', trackingNote: 'x'.repeat(201) })).rejects.toMatchObject({ code: 'invalid' });
    await recordDispatch(asAgent, paid, { from: 'paid', trackingNote: ' DTDC 123 ' });
    await expect(recordDispatch(asAgent, paid, { from: 'paid' })).rejects.toMatchObject({ code: 'conflict' });
    const before = Date.now();
    // The PATCH status path goes through the same delivery.
    await updateOrder(asAgent, paid, { status: 'fulfilled' });
    const row = (await db.query(`SELECT status, tracking_note, dispatched_at IS NOT NULL AS d, delivered_at IS NOT NULL AS f, fulfilment_recorded_by
      FROM orders WHERE id=$1`, [paid])).rows[0];
    expect(row).toEqual({ status: 'fulfilled', tracking_note: 'DTDC 123', d: true, f: true, fulfilment_recorded_by: agentA });
    const queued = await jobs(`ofu:${paid}`);
    expect(queued.map((j) => [j.dedupe_key, j.type, j.payload])).toEqual([
      [`ofu:${paid}:delivered`, 'commerce.order_followup', { orderId: paid, kind: 'delivered' }],
      [`ofu:${paid}:dispatched`, 'commerce.order_followup', { orderId: paid, kind: 'dispatched' }],
      [`ofu:${paid}:feedback`, 'commerce.order_followup', { orderId: paid, kind: 'feedback' }],
      [`ofu:${paid}:product_follow_up`, 'commerce.order_followup', { orderId: paid, kind: 'product_follow_up' }],
    ]);
    const runAt = (kind: string) => new Date(queued.find((j) => j.dedupe_key.endsWith(kind))!.run_at).getTime() - before;
    expect(runAt('feedback')).toBeGreaterThan(23 * 3_600_000);
    expect(runAt('product_follow_up')).toBeGreaterThan(29 * 86_400_000);
  });

  it('records the customer feedback score on a delivered order only', async () => {
    await expect(recordFeedback(asAgent, paid, 6)).rejects.toMatchObject({ code: 'invalid' });
    await expect(recordFeedback(asAgent, refundable, 4)).rejects.toMatchObject({ code: 'bad_transition' });
    await recordFeedback(asAgent, paid, 4);
    expect((await db.query('SELECT feedback_score FROM orders WHERE id=$1', [paid])).rows[0].feedback_score).toBe(4);
    const timeline = await getOrderTimeline(asAgent, paid);
    expect(timeline.events.map((e) => e.kind)).toEqual(expect.arrayContaining(['status_changed', 'feedback']));
    expect(timeline.events.find((e) => e.kind === 'feedback')).toMatchObject({ actor: 'staff', detail: 'score_4' });
    await expect(getOrderTimeline(asOtherOwner, paid)).rejects.toMatchObject({ code: 'not_found' });
  });

  it('skips a feedback request already answered and any notice to a contact who opted out after buying', async () => {
    const meta = { attempts: 1, maxAttempts: 5 };
    expect(await handleOrderFollowupJob(accountA, { orderId: paid, kind: 'feedback' }, meta)).toEqual({ status: 'skipped', reason: 'feedback_recorded' });
    expect(await handleOrderFollowupJob(accountA, { orderId: paid, kind: 'dispatched' }, meta)).toEqual({ status: 'skipped', reason: 'stale_status' });
    expect(await handleOrderFollowupJob(accountA, { orderId: optedOrder, kind: 'delivered' }, meta)).toEqual({ status: 'skipped', reason: 'opted_out' });
    const ledger = (await db.query(`SELECT order_id, kind, status, reason FROM order_messages WHERE account_id=$1 ORDER BY kind`, [accountA])).rows;
    expect(ledger).toEqual(expect.arrayContaining([
      { order_id: paid, kind: 'feedback', status: 'skipped', reason: 'feedback_recorded' },
      { order_id: optedOrder, kind: 'delivered', status: 'skipped', reason: 'opted_out' },
    ]));
    // Nothing was claimed for sending.
    expect((await db.query(`SELECT count(*)::int AS n FROM outbound_intents WHERE account_id=$1`, [accountA])).rows[0].n).toBe(0);
  });

  it('cancels and refunds only with commerce.refunds, refunding what is left after in-flight refunds', async () => {
    h.requestRefund.mockResolvedValue({ refundId: randomUUID() });
    await expect(cancelAndRefund(asAgent, refundable)).rejects.toBeInstanceOf(ForbiddenError);
    await db.query(`INSERT INTO role_permission_restrictions(account_id,role,permission,created_by) VALUES($1,'admin','commerce.refunds',$2)`, [accountA, ownerA]);
    await expect(cancelAndRefund(asAdmin, refundable)).rejects.toBeInstanceOf(ForbiddenError);
    await db.query(`DELETE FROM role_permission_restrictions WHERE account_id=$1`, [accountA]);
    const { refundIds } = await cancelAndRefund(asAdmin, refundable, { note: 'Customer changed their mind' });
    expect(refundIds).toHaveLength(1);
    // 998.00 captured − 100.00 refunded − 50.00 in flight.
    expect(h.requestRefund).toHaveBeenCalledWith(asAdmin, { paymentId: payment, amountMinor: 84800, reason: 'cancelled',
      note: 'Customer changed their mind', restock: true });
    expect(await statusOf(refundable)).toBe('cancelled');
    await expect(cancelAndRefund(asAdmin, refundable)).rejects.toMatchObject({ code: 'bad_transition' });
  });

  it('opens returns up to the ordered quantity and restocks only on an admin close', async () => {
    await expect(createReturn(asAgent, legacy, { items: [{ order_item_id: paidItem, qty: 1 }] })).rejects.toMatchObject({ code: 'bad_transition' });
    await expect(createReturn(asAgent, paid, { items: [{ order_item_id: paidItem, qty: 3 }] })).rejects.toMatchObject({ code: 'conflict' });
    const first = await createReturn(asAgent, paid, { items: [{ order_item_id: paidItem, qty: 1 }], note: 'Damaged seal' });
    await createReturn(asAgent, paid, { items: [{ order_item_id: paidItem, qty: 1 }] });
    await expect(createReturn(asAgent, paid, { items: [{ order_item_id: paidItem, qty: 1 }] })).rejects.toMatchObject({ code: 'conflict' });
    await expect(inspectReturn(asAgent, first.id, { [paidItem]: 'restock' })).rejects.toMatchObject({ code: 'bad_transition' });
    await receiveReturn(asAgent, first.id);
    await expect(inspectReturn(asAgent, first.id, { [paidItem]: 'keep' })).rejects.toMatchObject({ code: 'invalid' });
    await inspectReturn(asAgent, first.id, { [paidItem]: 'restock' });
    await expect(closeReturn(asAgent, first.id, { restock: true })).rejects.toBeInstanceOf(ForbiddenError);
    const closed = await closeReturn(asAdmin, first.id, { restock: true });
    expect(closed).toMatchObject({ status: 'closed', disposition: { [paidItem]: 'restock' }, restocked_at: expect.any(String) });
    expect(h.restockTx).toHaveBeenCalledTimes(1);
    expect(h.restockTx).toHaveBeenCalledWith(expect.anything(), accountA, { orderId: paid, lines: [{ variantId: variantA, quantity: 1 }],
      kind: 'return_restock', returnId: first.id, actorUserId: adminA });
    const kinds = (await db.query(`SELECT kind FROM order_events WHERE order_id=$1 AND kind LIKE 'return_%' ORDER BY created_at`, [paid])).rows.map((r) => r.kind);
    expect(kinds).toEqual(['return_requested', 'return_requested', 'return_received', 'return_inspected', 'return_closed']);
  });

  // ------------------------------------------------------------------ cancel and refund: offline, legacy, races
  async function addPayment(orderId: string, source: 'razorpay' | 'offline', amount: number) {
    const id = randomUUID();
    await db.query(`INSERT INTO customer_payments(id,account_id,source,provider_payment_id,order_id,amount_minor,currency,status,captured_at,settlement)
      VALUES($1,$2,$3,$4,$5,$6,'INR','captured',now(),'settled')`,
    [id, accountA, source, source === 'razorpay' ? `pay_${id.replace(/-/g, '').slice(0, 20)}` : null, orderId, amount]);
    return id;
  }
  const refundsOf = async (orderId: string) => (await db.query(`SELECT source, status, amount_minor::int AS amount, restock, failure_code
    FROM customer_refunds WHERE order_id=$1 ORDER BY created_at`, [orderId])).rows;

  it('cancels an order paid offline only once staff confirm the money went back outside the app', async () => {
    const order = randomUUID();
    await pricedOrder(order, 'paid');
    const cash = await addPayment(order, 'offline', 99800);
    await db.query(`INSERT INTO stock_reservations(account_id,order_id,variant_id,quantity,status) VALUES($1,$2,$3,2,'committed')`, [accountA, order, variantA]);
    await expect(cancelAndRefund(asAdmin, order)).rejects.toMatchObject({ code: 'offline_payment', status: 409 });
    expect(await statusOf(order)).toBe('paid');
    expect(await refundsOf(order)).toEqual([]);

    expect(await cancelAndRefund(asAdmin, order, { refundedOutside: true })).toEqual({ refundIds: [], refundedOutside: true });
    expect(h.requestRefund).not.toHaveBeenCalled();
    expect(await statusOf(order)).toBe('cancelled');
    expect(await refundsOf(order)).toEqual([{ source: 'external', status: 'processed', amount: 99800, restock: true, failure_code: null }]);
    expect((await db.query('SELECT refunded_minor::int AS n FROM customer_payments WHERE id=$1', [cash])).rows[0].n).toBe(99800);
    expect((await db.query('SELECT amount_refunded_minor::int AS n, refund_state FROM orders WHERE id=$1', [order])).rows[0])
      .toEqual({ n: 99800, refund_state: 'full' });
    expect(h.restockTx).toHaveBeenCalledWith(expect.anything(), accountA, { orderId: order, lines: [{ variantId: variantA, quantity: 2 }], kind: 'refund_restock' });
    const audit = (await db.query(`SELECT metadata FROM audit_logs WHERE resource_id=$1 AND action='order.cancelled_refunded'`, [order])).rows;
    expect(audit).toEqual([{ metadata: { refunds: 0, refunded_outside: true, outside_refunds: 1 } }]);
  });

  it('checks every payment before requesting any refund on a mixed Razorpay and offline order', async () => {
    const order = randomUUID();
    await pricedOrder(order, 'paid');
    const online = await addPayment(order, 'razorpay', 60000);
    await addPayment(order, 'offline', 39800);
    h.requestRefund.mockResolvedValue({ refundId: randomUUID() });
    await expect(cancelAndRefund(asAdmin, order)).rejects.toMatchObject({ code: 'offline_payment' });
    expect(h.requestRefund).not.toHaveBeenCalled();
    expect(await statusOf(order)).toBe('paid');

    const { refundIds } = await cancelAndRefund(asAdmin, order, { refundedOutside: true });
    expect(refundIds).toHaveLength(1);
    expect(h.requestRefund).toHaveBeenCalledTimes(1);
    expect(h.requestRefund).toHaveBeenCalledWith(asAdmin, { paymentId: online, amountMinor: 60000, reason: 'cancelled', note: null, restock: true });
    expect(await refundsOf(order)).toEqual([{ source: 'external', status: 'processed', amount: 39800, restock: true, failure_code: null }]);
    expect(await statusOf(order)).toBe('cancelled');
  });

  it('never cancels a legacy paid order with no payment record as if it were refunded', async () => {
    const order = randomUUID();
    await pricedOrder(order, 'paid');
    await expect(cancelAndRefund(asAdmin, order)).rejects.toMatchObject({ code: 'offline_payment' });
    expect(await statusOf(order)).toBe('paid');
    expect(await cancelAndRefund(asAdmin, order, { refundedOutside: true })).toEqual({ refundIds: [], refundedOutside: true });
    expect(await statusOf(order)).toBe('cancelled');
  });

  it('refuses dispatch while a refund that restocks the order is in flight', async () => {
    const order = randomUUID();
    await pricedOrder(order, 'paid');
    const online = await addPayment(order, 'razorpay', 99800);
    await db.query(`INSERT INTO customer_refunds(account_id,payment_id,order_id,source,amount_minor,currency,reason_code,status,restock)
      VALUES($1,$2,$3,'bodhinox',99800,'INR','cancelled','unknown',true)`, [accountA, online, order]);
    await expect(recordDispatch(asAgent, order, { from: 'paid' })).rejects.toMatchObject({ code: 'bad_transition' });
    expect(await statusOf(order)).toBe('paid');
    await db.query(`UPDATE customer_refunds SET status='failed' WHERE order_id=$1`, [order]);
    await recordDispatch(asAgent, order, { from: 'paid' });
    expect(await statusOf(order)).toBe('dispatched');
  });

  it('withdraws its unsent refunds when the order changed before the cancel', async () => {
    const order = randomUUID();
    await pricedOrder(order, 'paid');
    const online = await addPayment(order, 'razorpay', 99800);
    h.requestRefund.mockImplementationOnce(async () => {
      const { rows } = await db.query(`INSERT INTO customer_refunds(account_id,payment_id,order_id,source,amount_minor,currency,reason_code,status,restock)
        VALUES($1,$2,$3,'bodhinox',99800,'INR','cancelled','requested',true) RETURNING id::text AS id`, [accountA, online, order]);
      // Another member's dispatch lands between the refund request and the cancel.
      await db.query(`UPDATE orders SET status='dispatched' WHERE id=$1`, [order]);
      return { refundId: rows[0].id as string };
    });
    await expect(cancelAndRefund(asAdmin, order)).rejects.toMatchObject({ code: 'conflict' });
    expect(await statusOf(order)).toBe('dispatched');
    expect(await refundsOf(order)).toEqual([{ source: 'bodhinox', status: 'failed', amount: 99800, restock: true, failure_code: 'order_changed' }]);
  });

  // ------------------------------------------------------------------ returns: restock after a failed refund, one refund per return
  async function inspectedReturn(orderId: string, itemId: string) {
    const ret = await createReturn(asAgent, orderId, { items: [{ order_item_id: itemId, qty: 1 }] });
    await receiveReturn(asAgent, ret.id);
    await inspectReturn(asAgent, ret.id, { [itemId]: 'restock' });
    return ret.id;
  }
  async function shippedOrder() {
    const order = randomUUID(), item = randomUUID();
    await pricedOrder(order, 'dispatched');
    await db.query(`INSERT INTO order_items(id,account_id,order_id,variant_id,sku,name,quantity,unit_price_minor,currency,line_total_minor)
      VALUES($1,$2,$3,$4,'ASH-60','Ashwagandha',3,49900,'INR',149700)`, [item, accountA, order, variantA]);
    return { order, item, pay: await addPayment(order, 'razorpay', 99800) };
  }

  it('restocks on close when the return refund failed, refuses while it is in flight, and skips once processed', async () => {
    const { order, item, pay } = await shippedOrder();
    const link = async (returnId: string, status: string) => {
      const { rows } = await db.query(`INSERT INTO customer_refunds(account_id,payment_id,order_id,source,amount_minor,currency,reason_code,status,restock,return_id)
        VALUES($1,$2,$3,'bodhinox',49900,'INR','return',$4,true,$5) RETURNING id`, [accountA, pay, order, status, returnId]);
      await db.query('UPDATE order_returns SET refund_id=$1 WHERE id=$2', [rows[0].id, returnId]);
      return rows[0].id as string;
    };
    const failedOne = await inspectedReturn(order, item);
    const refund = await link(failedOne, 'pending');
    await expect(closeReturn(asAdmin, failedOne, { restock: true })).rejects.toMatchObject({ code: 'conflict' });
    await db.query(`UPDATE customer_refunds SET status='failed' WHERE id=$1`, [refund]);
    expect(await closeReturn(asAdmin, failedOne, { restock: true })).toMatchObject({ status: 'closed', restocked_at: expect.any(String) });
    expect(h.restockTx).toHaveBeenCalledTimes(1);
    expect(h.restockTx).toHaveBeenCalledWith(expect.anything(), accountA, { orderId: order, lines: [{ variantId: variantA, quantity: 1 }],
      kind: 'return_restock', returnId: failedOne, actorUserId: adminA });

    const processedOne = await inspectedReturn(order, item);
    await link(processedOne, 'processed');
    expect(await closeReturn(asAdmin, processedOne, { restock: true })).toMatchObject({ status: 'closed', restocked_at: null });
    expect(h.restockTx).toHaveBeenCalledTimes(1);
  });

  it('restocks nothing on close once a whole-order refund already put the units back', async () => {
    const { order, item } = await shippedOrder();
    const returnId = await inspectedReturn(order, item);
    await db.query(`INSERT INTO order_events(account_id,order_id,kind,actor) VALUES($1,$2,'refund_restocked','system')`, [accountA, order]);
    expect(await closeReturn(asAdmin, returnId, { restock: true })).toMatchObject({ status: 'closed', restocked_at: expect.any(String) });
    expect(h.restockTx).not.toHaveBeenCalled();
  });

  it('sends one refund when the same return is refunded twice at once', async () => {
    const actual = await vi.importActual<typeof import('@/lib/payments/refunds')>('@/lib/payments/refunds');
    h.requestRefund.mockImplementation(actual.requestRefund as never);
    try {
      const { order, item } = await shippedOrder();
      const returnId = await inspectedReturn(order, item);
      const results = await Promise.allSettled([
        refundReturn(asAdmin, returnId, { amountMinor: 20000 }),
        refundReturn(asAdmin, returnId, { amountMinor: 20000 }),
      ]);
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      expect(results.find((r) => r.status === 'rejected')).toMatchObject({ reason: { code: 'conflict' } });
      const rows = (await db.query('SELECT id::text AS id FROM customer_refunds WHERE return_id=$1', [returnId])).rows;
      expect(rows).toHaveLength(1);
      expect((await db.query(`SELECT count(*)::int AS n FROM jobs WHERE tenant_id=$1 AND type='payments.refund' AND payload->>'refundId'=$2`,
        [accountA, rows[0].id])).rows[0].n).toBe(1);
      expect((await db.query('SELECT refund_id::text AS id FROM order_returns WHERE id=$1', [returnId])).rows[0].id).toBe(rows[0].id);
    } finally {
      h.requestRefund.mockReset();
      h.requestRefund.mockImplementation(async () => ({ refundId: '' }));
    }
  });
});
