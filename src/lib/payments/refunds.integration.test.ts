import { createHmac, randomUUID } from 'node:crypto';
import { config } from 'dotenv';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { disconnectDatabases, getPrisma, getWorkerPrisma } from '@/lib/db/prisma';
import { withTenant, type TenantContext } from '@/lib/db/tenant';
import { withJobScope } from '@/lib/jobs/scope';

// Razorpay is the only fake: refund rows, jobs, locks, stock and reports are real (design §8 test 5).
const h = vi.hoisted(() => {
  let n = 0;
  type Refund = { id: string; paymentId: string; amountMinor: number; currency: string; status: string; bodhinoxRefundId: string | null };
  const refunds = new Map<string, Refund[]>();
  return {
    refunds,
    next: () => ++n,
    createRefund: vi.fn(async (args: { paymentId: string; amountMinor: number; refundId: string }): Promise<unknown> => {
      const refund = { id: `rfnd_R${++n}x${Date.now() % 100000}`, paymentId: args.paymentId, amountMinor: args.amountMinor, currency: 'INR', status: 'pending', bodhinoxRefundId: args.refundId };
      refunds.set(args.paymentId, [...(refunds.get(args.paymentId) ?? []), refund]);
      return { outcome: 'created', refund };
    }),
    listRefunds: vi.fn(async (args: { paymentId: string }) => refunds.get(args.paymentId) ?? []),
  };
});
vi.mock('@/lib/payments/razorpay', async (orig) => ({
  ...(await orig<typeof import('./razorpay')>()),
  createRefund: h.createRefund,
  listRefunds: h.listRefunds,
}));

import { reserveTx, commitTx } from '@/lib/commerce/stock';
import { POST as webhook } from '@/app/api/payments/razorpay/webhook/[accountId]/route';
import { savePaymentProvider } from './providers';
import { handlePaymentEventJob } from './links';
import { handleRefundJob, reconcileRefund, requestRefund, retryRefund, syncProviderRefunds } from './refunds';
import { runReconcileSweep } from './reconcile-sweep';
import { reconciliationReport } from './queries';
import { openExceptionTx } from './ledger';

const configured = config({ path: '.env.test', quiet: true }).parsed;
const ownerUrl = process.env.TEST_DATABASE_URL;
const appUrl = process.env.TEST_APP_DATABASE_URL || configured?.DATABASE_URL;
const workerUrl = process.env.TEST_WORKER_DATABASE_URL || configured?.WORKER_DATABASE_URL;
if (appUrl) process.env.DATABASE_URL = appUrl;
if (workerUrl) process.env.WORKER_DATABASE_URL = workerUrl;

const accountA = randomUUID(), adminA = randomUUID(), agentA = randomUUID(), contactA = randomUUID();
const asAdmin = { accountId: accountA, userId: adminA, role: 'admin' as const };
const asAgent = { accountId: accountA, userId: agentA, role: 'agent' as const };
const scope = { accountId: accountA, role: 'owner' as const };
const HOOK_SECRET = 'test-only-refund-hook';
const seed = String(Date.now()).slice(-9);
let owner: pg.Client;
let variant = '';

const worker = <T>(op: Parameters<typeof withTenant<T>>[1], ctx: TenantContext = scope) => withTenant(ctx, op, getWorkerPrisma());
const one = async (sql: string, params: unknown[]) => (await owner.query(sql, params)).rows[0];
const count = async (sql: string, params: unknown[]) => Number((await owner.query(sql, params)).rows[0].n);
const onHand = async () => (await one('SELECT on_hand FROM inventory_levels WHERE account_id=$1 AND variant_id=$2', [accountA, variant])).on_hand as number;

/** A paid, server-priced order (1 x 100.00 INR) with its gateway payment settled and its stock sold. */
async function paidOrder(status = 'paid'): Promise<{ order: string; payment: string; providerPaymentId: string; item: string }> {
  await owner.query('UPDATE inventory_levels SET on_hand=on_hand+1 WHERE account_id=$1 AND variant_id=$2', [accountA, variant]);
  const order = (await one(`INSERT INTO orders(account_id,source,contact_id,currency,subtotal_minor,total_minor,tax_inclusive,priced_at,status)
    VALUES($1,'manual',$2,'INR',10000,10000,true,now(),'awaiting_payment') RETURNING id`, [accountA, contactA])).id as string;
  const item = (await one(`INSERT INTO order_items(account_id,order_id,variant_id,sku,name,quantity,unit_price_minor,currency,line_total_minor)
    VALUES($1,$2,$3,$4,'Ashwagandha',1,10000,'INR',10000) RETURNING id`, [accountA, order, variant, `ASH-${seed}`])).id as string;
  const providerPaymentId = `pay_F${h.next()}x${Date.now() % 100000}`;
  let payment = '';
  await worker(async (tx) => {
    await reserveTx(tx, accountA, order, [{ variantId: variant, quantity: 1 }], new Date(Date.now() + 900_000));
    await commitTx(tx, accountA, order);
    const settlement = status === 'paid' ? 'settled' : 'exception';
    payment = (await tx.$queryRaw<{ id: string }[]>`INSERT INTO customer_payments(account_id,source,provider_payment_id,order_id,amount_minor,currency,status,settlement,captured_at)
      VALUES(${accountA}::uuid,'razorpay',${providerPaymentId},${order}::uuid,10000,'INR','captured',${settlement},now()) RETURNING id::text AS id`)[0].id;
    await tx.$executeRaw`UPDATE orders SET status=${status}, paid_at=now(), amount_paid_minor=${BigInt(status === 'paid' ? 10000 : 0)} WHERE account_id=${accountA}::uuid AND id=${order}::uuid`;
  });
  return { order, payment, providerPaymentId, item };
}

async function runRefundJobs(): Promise<number> {
  const jobs = (await owner.query("DELETE FROM jobs WHERE tenant_id=$1 AND type='payments.refund' RETURNING payload", [accountA])).rows;
  for (const job of jobs) await withJobScope(scope, () => handleRefundJob(accountA, job.payload));
  return jobs.length;
}
const refund = (id: string) => one('SELECT status,failure_code,attempt,provider_refund_id IS NOT NULL AS has_provider_id FROM customer_refunds WHERE id=$1', [id]);
const paymentRow = (id: string) => one('SELECT refunded_minor::int AS refunded FROM customer_payments WHERE id=$1', [id]);
const orderRow = (id: string) => one('SELECT status,amount_refunded_minor::int AS refunded,refund_state FROM orders WHERE id=$1', [id]);
const ask = (paymentId: string, amountMinor: number, extra: Partial<Parameters<typeof requestRefund>[1]> = {}) =>
  requestRefund(asAdmin, { paymentId, amountMinor, reason: 'customer_request', restock: false, ...extra });

describe.skipIf(!ownerUrl || !appUrl || !workerUrl)('Customer refunds on PostgreSQL', { timeout: 180_000 }, () => {
  beforeAll(async () => {
    owner = new pg.Client({ connectionString: ownerUrl });
    await owner.connect();
    if (!/test/i.test((await owner.query('SELECT current_database() AS name')).rows[0].name)) throw new Error('Requires an isolated test database');
    const app = await getPrisma().$queryRaw<{ role: string }[]>`SELECT current_user AS role`;
    if (app[0].role !== 'bodhinox_app') throw new Error('Requires constrained test app credentials');
    await owner.query("INSERT INTO auth_users(id,email,full_name,password_hash) SELECT x, x::text || '@example.invalid', 'Refund test', 'test-only-hash' FROM unnest($1::uuid[]) x", [[adminA, agentA]]);
    await owner.query("INSERT INTO accounts(id,name,owner_user_id) VALUES($1,'Refund A',$2)", [accountA, adminA]);
    await owner.query("INSERT INTO account_memberships(account_id,user_id,role) VALUES($1,$2,'admin'),($1,$3,'agent')", [accountA, adminA, agentA]);
    await owner.query("INSERT INTO contacts(id,account_id,user_id,name,phone) VALUES($1,$2,$3,'Buyer',$4)", [contactA, accountA, adminA, `+9195${seed}`]);
    const product = (await one("INSERT INTO shop_products(account_id,name,status,content_reviewed_at) VALUES($1,'Ashwagandha','published',now()) RETURNING id", [accountA])).id;
    variant = (await one('INSERT INTO shop_variants(account_id,product_id,sku,price_minor) VALUES($1,$2,$3,10000) RETURNING id', [accountA, product, `ASH-${seed}`])).id;
    await owner.query('INSERT INTO inventory_levels(account_id,variant_id,on_hand) VALUES($1,$2,0)', [accountA, variant]);
    await withTenant(asAdmin, (tx) => savePaymentProvider(tx, accountA, { keyId: 'rzp_test_RefundKey0001', keySecret: 'test-only-secret', webhookSecret: HOOK_SECRET }));
  });
  beforeEach(async () => {
    vi.clearAllMocks();
    // Each test runs only the sends it asked for.
    await owner.query("DELETE FROM jobs WHERE tenant_id=$1 AND type='payments.refund'", [accountA]);
  });
  afterAll(async () => {
    if (owner) {
      await owner.query('DELETE FROM jobs WHERE tenant_id=$1', [accountA]);
      await owner.query('DELETE FROM webhook_receipts WHERE dedupe_key LIKE $1', [`razorpay:${accountA}:%`]);
      await owner.query('DELETE FROM accounts WHERE id=$1', [accountA]);
      await owner.query('DELETE FROM auth_users WHERE id=ANY($1::uuid[])', [[adminA, agentA]]);
      await owner.end();
    }
    await disconnectDatabases();
  });

  it('never lets refunds exceed what was captured, even when requested at once', async () => {
    const { payment } = await paidOrder();
    await expect(requestRefund(asAgent, { paymentId: payment, amountMinor: 100, reason: 'other', restock: false })).rejects.toThrow();
    const { refundId } = await ask(payment, 4000);
    await expect(ask(payment, 6001)).rejects.toMatchObject({ code: 'amount_exceeds' });
    const results = await Promise.allSettled([ask(payment, 5000), ask(payment, 5000), ask(payment, 5000)]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected').map((r) => (r as PromiseRejectedResult).reason.code)).toEqual(['amount_exceeds', 'amount_exceeds']);
    expect(await count('SELECT count(*) AS n FROM customer_refunds WHERE payment_id=$1', [payment])).toBe(2);
    expect(await count("SELECT count(*) AS n FROM audit_logs WHERE account_id=$1 AND action='commerce.refund_requested' AND resource_id=$2", [accountA, refundId])).toBe(1);
    // A replayed click (same client request id) returns the first refund.
    const requestId = randomUUID();
    const { payment: other } = await paidOrder();
    const first = await ask(other, 1000, { clientRequestId: requestId });
    expect((await ask(other, 1000, { clientRequestId: requestId })).refundId).toBe(first.refundId);
    expect(await count('SELECT count(*) AS n FROM customer_refunds WHERE payment_id=$1', [other])).toBe(1);
  });

  it('applies a processed refund once: amounts, refund state, one restock and one credit note', async () => {
    const { order, payment, providerPaymentId } = await paidOrder();
    const before = await onHand();
    const { refundId } = await ask(payment, 10000, { restock: true, reason: 'cancelled' });
    expect(await runRefundJobs()).toBe(1);
    expect(h.createRefund).toHaveBeenCalledTimes(1);
    expect(await refund(refundId)).toMatchObject({ status: 'pending', has_provider_id: true });
    expect(await paymentRow(payment)).toEqual({ refunded: 0 });
    // A replayed job sends nothing again.
    await withJobScope(scope, () => handleRefundJob(accountA, { refundId, attempt: 1 }));
    expect(h.createRefund).toHaveBeenCalledTimes(1);

    // Razorpay processes it; the webhook and a reconcile both report it.
    h.refunds.get(providerPaymentId)![0].status = 'processed';
    const raw = JSON.stringify({ event: 'refund.processed', payload: { refund: { entity: { id: h.refunds.get(providerPaymentId)![0].id, payment_id: providerPaymentId,
      amount: 10000, currency: 'INR', status: 'processed', notes: { bodhinox_refund_id: refundId } } } } });
    const res = await webhook(new Request(`http://localhost/api/payments/razorpay/webhook/${accountA}`, { method: 'POST', body: raw,
      headers: { 'x-razorpay-signature': createHmac('sha256', HOOK_SECRET).update(raw).digest('hex'), 'x-razorpay-event-id': `evt_${seed}_rp` } }), { params: Promise.resolve({ accountId: accountA }) });
    expect(res.status).toBe(200);
    for (const job of (await owner.query("DELETE FROM jobs WHERE tenant_id=$1 AND type='payments.razorpay_event' RETURNING payload", [accountA])).rows) {
      await withJobScope(scope, () => handlePaymentEventJob(accountA, job.payload));
    }
    await reconcileRefund(accountA, refundId).catch(() => 'not_reconcilable');

    expect(await refund(refundId)).toMatchObject({ status: 'processed' });
    expect(await paymentRow(payment)).toEqual({ refunded: 10000 });
    expect(await orderRow(order)).toEqual({ status: 'paid', refunded: 10000, refund_state: 'full' });
    expect(await onHand()).toBe(before + 1);
    expect(await count("SELECT count(*) AS n FROM inventory_movements WHERE order_id=$1 AND kind='refund_restock'", [order])).toBe(1);
    expect(await count("SELECT count(*) AS n FROM jobs WHERE tenant_id=$1 AND type='commerce.issue_credit_note' AND dedupe_key=$2", [accountA, `credit:${refundId}`])).toBe(1);
    expect(await count("SELECT count(*) AS n FROM order_events WHERE order_id=$1 AND kind='refund_processed'", [order])).toBe(1);
  });

  it('marks a definite refusal failed and lets staff retry it as a new attempt', async () => {
    const { payment } = await paidOrder();
    const { refundId } = await ask(payment, 2500);
    h.createRefund.mockResolvedValueOnce({ outcome: 'rejected', reason: 'invalid_request', httpStatus: 400 });
    await runRefundJobs();
    expect(await refund(refundId)).toMatchObject({ status: 'failed', failure_code: 'invalid_request', attempt: 1 });
    expect(await one("SELECT kind,status FROM payment_exceptions WHERE subject_key=$1", [`refund:${refundId}`])).toEqual({ kind: 'refund_failed', status: 'open' });
    await expect(retryRefund(asAgent, refundId)).rejects.toThrow();
    expect(await retryRefund(asAdmin, refundId)).toEqual({ attempt: 2 });
    expect(await one("SELECT status FROM payment_exceptions WHERE subject_key=$1", [`refund:${refundId}`])).toEqual({ status: 'resolved' });
    await runRefundJobs();
    expect(h.createRefund).toHaveBeenCalledTimes(2);
    expect(h.createRefund.mock.calls[1][0]).toMatchObject({ refundId, attempt: 2 });
    expect(await refund(refundId)).toMatchObject({ status: 'pending', attempt: 2 });
    await expect(retryRefund(asAdmin, refundId)).rejects.toMatchObject({ code: 'not_retryable' });
  });

  it('keeps an unclear send unknown, and the sweep reconciles it without ever sending again', async () => {
    const { payment, providerPaymentId } = await paidOrder();
    const absent = (await ask(payment, 1000)).refundId;
    h.createRefund.mockResolvedValueOnce({ outcome: 'unknown' });
    await runRefundJobs();
    expect(await refund(absent)).toMatchObject({ status: 'unknown' });
    expect(await one("SELECT kind FROM payment_exceptions WHERE subject_key=$1 AND status='open'", [`refund:${absent}`])).toEqual({ kind: 'refund_unknown' });

    // A second unclear send that did reach Razorpay.
    const landed = (await ask(payment, 2000)).refundId;
    h.createRefund.mockImplementationOnce(async (args) => {
      h.refunds.set(args.paymentId, [...(h.refunds.get(args.paymentId) ?? []),
        { id: `rfnd_L${h.next()}`, paymentId: args.paymentId, amountMinor: args.amountMinor, currency: 'INR', status: 'processed', bodhinoxRefundId: args.refundId }]);
      return { outcome: 'unknown' };
    });
    await runRefundJobs();
    expect(await refund(landed)).toMatchObject({ status: 'unknown' });
    expect(h.createRefund).toHaveBeenCalledTimes(2);

    const summary = await runReconcileSweep(accountA);
    expect(summary.failures).toBe(0);
    expect(h.createRefund).toHaveBeenCalledTimes(2);
    expect(h.listRefunds).toHaveBeenCalledWith(expect.objectContaining({ paymentId: providerPaymentId }));
    expect(await refund(absent)).toMatchObject({ status: 'failed', failure_code: 'absent' });
    expect(await refund(landed)).toMatchObject({ status: 'processed', has_provider_id: true });
    expect(await paymentRow(payment)).toEqual({ refunded: 2000 });
    expect(await one("SELECT kind FROM payment_exceptions WHERE subject_key=$1 AND status='open'", [`refund:${absent}`])).toEqual({ kind: 'refund_failed' });
    expect(await count("SELECT count(*) AS n FROM payment_exceptions WHERE subject_key=$1 AND status='open'", [`refund:${landed}`])).toBe(0);
  });

  it('restocks a linked return once, only the lines marked restock', async () => {
    const { order, payment, providerPaymentId, item } = await paidOrder();
    const ret = (await one(`INSERT INTO order_returns(account_id,order_id,items,status,disposition) VALUES($1,$2,$3,'inspected',$4) RETURNING id`,
      [accountA, order, JSON.stringify([{ order_item_id: item, qty: 1 }]), JSON.stringify({ [item]: 'restock' })])).id;
    await expect(ask(payment, 10000, { restock: true, returnId: randomUUID() })).rejects.toMatchObject({ code: 'return_mismatch' });
    const before = await onHand();
    const { refundId } = await ask(payment, 10000, { restock: true, reason: 'return', returnId: ret });
    await runRefundJobs();
    h.refunds.get(providerPaymentId)![0].status = 'processed';
    await reconcileRefund(accountA, refundId);
    await reconcileRefund(accountA, refundId).catch(() => undefined);
    expect(await onHand()).toBe(before + 1);
    expect(await count("SELECT count(*) AS n FROM inventory_movements WHERE return_id=$1 AND kind='return_restock'", [ret])).toBe(1);
    expect(await one('SELECT refund_id::text AS refund_id, restocked_at IS NOT NULL AS restocked FROM order_returns WHERE id=$1', [ret])).toEqual({ refund_id: refundId, restocked: true });
  });

  it('records a dashboard refund as external, and the report nets it', async () => {
    const { order, payment, providerPaymentId } = await paidOrder();
    const today = new Date().toISOString().slice(0, 10);
    const report = () => withTenant(asAdmin, (tx) => reconciliationReport(tx, accountA, { from: today, to: today }));
    const beforeTotals = (await report()).totals.find((t) => t.currency === 'INR')!;
    h.refunds.set(providerPaymentId, [{ id: `rfnd_D${h.next()}`, paymentId: providerPaymentId, amountMinor: 3000, currency: 'INR', status: 'processed', bodhinoxRefundId: null }]);
    // One of ours, so reconciliation reads the payment's list and finds the dashboard one too.
    const ours = (await ask(payment, 1000)).refundId;
    h.createRefund.mockResolvedValueOnce({ outcome: 'unknown' });
    await runRefundJobs();
    await reconcileRefund(accountA, ours);
    expect(await one("SELECT source,status,amount_minor::int AS amount FROM customer_refunds WHERE payment_id=$1 AND source='external'", [payment]))
      .toEqual({ source: 'external', status: 'processed', amount: 3000 });
    expect(await orderRow(order)).toEqual({ status: 'paid', refunded: 3000, refund_state: 'partial' });
    const afterTotals = (await report()).totals.find((t) => t.currency === 'INR')!;
    expect(afterTotals.refunds_minor - beforeTotals.refunds_minor).toBe(3000);
    expect(afterTotals.external_refunds_minor - beforeTotals.external_refunds_minor).toBe(3000);
    expect(afterTotals.net_minor).toBe(afterTotals.captured_minor - afterTotals.refunds_minor);
  });

  it('closes a held payment once it is refunded in full: exception resolved, review order cancelled', async () => {
    const { order, payment, providerPaymentId } = await paidOrder('payment_review');
    await worker((tx) => openExceptionTx(tx, { accountId: accountA, kind: 'late_payment_no_stock', subjectKey: `payment:${payment}`, paymentId: payment, orderId: order }));
    const { refundId } = await ask(payment, 10000, { reason: 'out_of_stock' });
    await runRefundJobs();
    h.refunds.get(providerPaymentId)![0].status = 'processed';
    await reconcileRefund(accountA, refundId);
    expect(await one('SELECT status,resolution FROM payment_exceptions WHERE subject_key=$1', [`payment:${payment}`])).toEqual({ status: 'resolved', resolution: 'refunded' });
    // Never credited, so the order's own refunded amount is unchanged; it closes.
    expect(await orderRow(order)).toEqual({ status: 'cancelled', refunded: 0, refund_state: 'none' });
  });

  it('never lets an earlier failed attempt mark a live retry failed (no second send)', async () => {
    const { payment, providerPaymentId } = await paidOrder();
    const { refundId } = await ask(payment, 2000);
    await runRefundJobs();
    const first = h.refunds.get(providerPaymentId)![0];
    first.status = 'failed';
    await reconcileRefund(accountA, refundId);
    expect(await refund(refundId)).toMatchObject({ status: 'failed', failure_code: 'provider_failed', attempt: 1 });
    expect(await retryRefund(asAdmin, refundId)).toEqual({ attempt: 2 });
    expect(await one('SELECT superseded_provider_refund_ids AS ids FROM customer_refunds WHERE id=$1', [refundId])).toEqual({ ids: [first.id] });
    await runRefundJobs();
    expect(await refund(refundId)).toMatchObject({ status: 'pending', attempt: 2, has_provider_id: true });
    // Razorpay lists newest first: the live attempt, then the failed one (same notes.bodhinox_refund_id).
    h.refunds.set(providerPaymentId, [...h.refunds.get(providerPaymentId)!].reverse());
    await withJobScope(scope, () => syncProviderRefunds(accountA, providerPaymentId));
    expect(await reconcileRefund(accountA, refundId)).toBe('pending');
    expect(await refund(refundId)).toMatchObject({ status: 'pending', attempt: 2 });
    await expect(retryRefund(asAdmin, refundId)).rejects.toMatchObject({ code: 'not_retryable' });
    expect(h.createRefund).toHaveBeenCalledTimes(2);
    expect(await count("SELECT count(*) AS n FROM payment_exceptions WHERE subject_key=$1 AND status='open'", [`refund:${refundId}`])).toBe(0);

    // If the earlier attempt is reported processed after all, it is surfaced, never counted against the live one.
    first.status = 'processed';
    await withJobScope(scope, () => syncProviderRefunds(accountA, providerPaymentId));
    expect(await refund(refundId)).toMatchObject({ status: 'pending', attempt: 2 });
    expect(await paymentRow(payment)).toEqual({ refunded: 0 });
    expect(await one("SELECT kind,detail,refund_id::text AS refund_id FROM payment_exceptions WHERE subject_key=$1 AND status='open'", [`provider_refund:${first.id}`]))
      .toEqual({ kind: 'refund_unknown', detail: 'stale_attempt_processed', refund_id: refundId });
  });

  it('restocks nothing for a partial refund of an order that still ships', async () => {
    const { order, payment, providerPaymentId } = await paidOrder();
    const before = await onHand();
    const { refundId } = await ask(payment, 4000, { restock: true, reason: 'out_of_stock' });
    await runRefundJobs();
    h.refunds.get(providerPaymentId)![0].status = 'processed';
    await reconcileRefund(accountA, refundId);
    expect(await orderRow(order)).toEqual({ status: 'paid', refunded: 4000, refund_state: 'partial' });
    expect(await onHand()).toBe(before);
    expect(await count("SELECT count(*) AS n FROM inventory_movements WHERE order_id=$1 AND kind='refund_restock'", [order])).toBe(0);
    expect(await count("SELECT count(*) AS n FROM order_events WHERE order_id=$1 AND kind='refund_restocked'", [order])).toBe(0);
  });

  it('refuses to refund an offline payment through the gateway', async () => {
    const order = (await one("INSERT INTO orders(account_id,source,currency,subtotal_minor,status) VALUES($1,'manual','INR',500,'paid') RETURNING id", [accountA])).id;
    const offline = (await one("INSERT INTO customer_payments(account_id,source,order_id,amount_minor,currency,status,settlement) VALUES($1,'offline',$2,500,'INR','captured','settled') RETURNING id", [accountA, order])).id;
    await expect(ask(offline, 500)).rejects.toMatchObject({ code: 'offline_payment' });
  });
});
