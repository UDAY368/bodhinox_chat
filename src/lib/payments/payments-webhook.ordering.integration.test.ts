import { createHmac, randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { fixtureDatabaseUrls } from '@/test/tenancy/fixtures';
import { drainJobs, permutations } from '@/test/fixtures/providers/drain';

// Duplicate and reordered Razorpay commerce deliveries (design 1.3, P1). Razorpay's
// API is the only fake: the signed route, receipts, jobs, the job dispatcher,
// settlement, refunds, RLS and triggers are real. The fake holds the provider's
// final state; every delivery order must end in the state the in-order run gives.
const h = vi.hoisted(() => {
  let n = 0;
  type Link = { id: string; shortUrl: string; status: string; amountMinor: number; amountPaidMinor: number; currency: string; referenceId: string; expireBy: null;
    payments: { paymentId: string; amountMinor: number; status: string }[] };
  type Payment = { id: string; amountMinor: number; currency: string; status: string; captured: boolean; method: string; amountRefundedMinor: number; createdAt: number };
  type Refund = { id: string; paymentId: string; amountMinor: number; currency: string; status: string; bodhinoxRefundId: null; attempt: null };
  const links = new Map<string, Link>();
  const payments = new Map<string, Payment>();
  const refunds = new Map<string, Refund[]>();
  return {
    links, payments, refunds,
    next: () => ++n,
    create: vi.fn(async (args: { referenceId: string; amountMinor: number; currency: string }) => {
      const id = `plink_O${++n}x${Date.now() % 100000}`;
      const link: Link = { id, shortUrl: `https://rzp.io/l/o${n}`, status: 'created', amountMinor: args.amountMinor, amountPaidMinor: 0, currency: args.currency,
        referenceId: args.referenceId, expireBy: null, payments: [] };
      links.set(id, link);
      return { outcome: 'created' as const, link };
    }),
    fetch: vi.fn(async (args: { id: string }) => {
      const link = links.get(args.id);
      if (!link) throw new Error('not found');
      return structuredClone(link);
    }),
    fetchPayment: vi.fn(async (args: { id: string }) => {
      const p = payments.get(args.id);
      if (!p) throw new Error('not found');
      return { ...p };
    }),
    listRefunds: vi.fn(async (args: { paymentId: string }) => (refunds.get(args.paymentId) ?? []).map((r) => ({ ...r }))),
  };
});
vi.mock('@/lib/payments/razorpay', async (orig) => ({
  ...(await orig<typeof import('./razorpay')>()),
  createPaymentLink: h.create,
  fetchPaymentLink: h.fetch,
  fetchPaymentLinkByReference: vi.fn(async () => null),
  cancelPaymentLink: vi.fn(),
  fetchPayment: h.fetchPayment,
  listRefunds: h.listRefunds,
}));

import { disconnectDatabases, getWorkerPrisma } from '@/lib/db/prisma';
import { withTenant } from '@/lib/db/tenant';
import { reserveTx } from '@/lib/commerce/stock';
import { POST as webhook } from '@/app/api/payments/razorpay/webhook/[accountId]/route';
import { savePaymentProvider } from './providers';
import { createPaymentLinkRecord } from './links';

const db = fixtureDatabaseUrls();
if (db) {
  process.env.DATABASE_URL = db.app;
  process.env.WORKER_DATABASE_URL = db.worker;
}

const accountA = randomUUID(), adminA = randomUUID(), contactA = randomUUID();
const asAdmin = { accountId: accountA, userId: adminA, role: 'admin' as const };
const scope = { accountId: accountA, role: 'owner' as const };
const HOOK_SECRET = 'test-only-ordering-hook';
const seed = String(Date.now()).slice(-9);
let owner: pg.Client;
let convA = '';
let variant = '';
let eventNo = 0;

const one = async (sql: string, params: unknown[]) => (await owner.query(sql, params)).rows[0];
const count = async (sql: string, params: unknown[]) => Number((await owner.query(sql, params)).rows[0].n);

async function pricedOrder(): Promise<string> {
  const order = (await one(`INSERT INTO orders(account_id,source,contact_id,conversation_id,currency,subtotal_minor,total_minor,tax_inclusive,priced_at,status,reservation_expires_at)
    VALUES($1,'manual',$2,$3,'INR',10000,10000,true,now(),'new',now() + interval '15 minutes') RETURNING id`, [accountA, contactA, convA])).id as string;
  await owner.query(`INSERT INTO order_items(account_id,order_id,variant_id,sku,name,quantity,unit_price_minor,currency,line_total_minor)
    VALUES($1,$2,$3,$4,'Neem soap',1,10000,'INR',10000)`, [accountA, order, variant, `NEEM-${seed}`]);
  await withTenant(scope, async (tx) => {
    await reserveTx(tx, accountA, order, [{ variantId: variant, quantity: 1 }], new Date(Date.now() + 15 * 60_000));
    await tx.$executeRaw`UPDATE orders SET status='awaiting_payment' WHERE account_id=${accountA}::uuid AND id=${order}::uuid`;
  }, getWorkerPrisma());
  return order;
}

/** An order, its link, and Razorpay's final state: link paid, payment captured, a partial refund processed. */
async function paidAndPartlyRefunded() {
  const order = await pricedOrder();
  const { link } = await createPaymentLinkRecord({
    accountId: accountA, actor: { kind: 'bot' }, amountMinor: 10000, currency: 'INR', orderId: order,
    referenceId: `co_${randomUUID().replace(/-/g, '')}`, expireBy: new Date(Date.now() + 20 * 60_000),
  });
  const providerLinkId = link.provider_link_id!;
  const referenceId = (await one('SELECT reference_id FROM payment_links WHERE id=$1', [link.id])).reference_id as string;
  const paymentId = `pay_O${h.next()}x${Date.now() % 100000}`;
  const refundId = `rfnd_O${h.next()}x${Date.now() % 100000}`;
  h.payments.set(paymentId, { id: paymentId, amountMinor: 10000, currency: 'INR', status: 'captured', captured: true, method: 'upi', amountRefundedMinor: 4000,
    createdAt: Math.floor(Date.now() / 1000) });
  Object.assign(h.links.get(providerLinkId)!, { status: 'paid', amountPaidMinor: 10000, payments: [{ paymentId, amountMinor: 10000, status: 'captured' }] });
  h.refunds.set(paymentId, [{ id: refundId, paymentId, amountMinor: 4000, currency: 'INR', status: 'processed', bodhinoxRefundId: null, attempt: null }]);
  const events: Record<string, Record<string, unknown>> = {
    paid: { event: 'payment_link.paid', account_id: 'acc_TestMerchant1', payload: {
      payment_link: { entity: { id: providerLinkId, reference_id: referenceId, status: 'paid', amount: 10000, amount_paid: 10000, currency: 'INR' } },
      payment: { entity: { id: paymentId, amount: 10000, currency: 'INR', status: 'captured' } } } },
    refund: { event: 'refund.processed', account_id: 'acc_TestMerchant1', payload: {
      refund: { entity: { id: refundId, payment_id: paymentId, amount: 4000, currency: 'INR', status: 'processed' } } } },
    // Ignored by design (payment.* carries no link id); acknowledged without effect wherever it lands.
    failed: { event: 'payment.failed', account_id: 'acc_TestMerchant1', payload: { payment: { entity: { id: paymentId, amount: 10000, status: 'failed' } } } },
  };
  return { order, linkId: link.id, paymentId, events };
}

async function deliver(body: Record<string, unknown>, eventId = `evt_${seed}_${++eventNo}`): Promise<number> {
  const raw = JSON.stringify(body);
  const res = await webhook(new Request(`http://localhost/api/payments/razorpay/webhook/${accountA}`, { method: 'POST', body: raw,
    headers: { 'x-razorpay-signature': createHmac('sha256', HOOK_SECRET).update(raw).digest('hex'), 'x-razorpay-event-id': eventId } }),
  { params: Promise.resolve({ accountId: accountA }) });
  return res.status;
}

const drain = (concurrent = false) => drainJobs(owner, { tenantId: accountA, types: ['payments.razorpay_event'] }, { concurrent });

/** Everything a delivery order could change, without ids. */
async function snapshot(order: string, linkId: string) {
  return {
    order: await one('SELECT status,amount_paid_minor::int AS paid,amount_refunded_minor::int AS refunded,refund_state FROM orders WHERE id=$1', [order]),
    link: await one('SELECT status FROM payment_links WHERE id=$1', [linkId]),
    payments: (await owner.query('SELECT status,settlement,amount_minor::int AS amount,refunded_minor::int AS refunded FROM customer_payments WHERE order_id=$1', [order])).rows,
    refunds: (await owner.query('SELECT source,status,amount_minor::int AS amount FROM customer_refunds WHERE order_id=$1', [order])).rows,
    exceptions: (await owner.query('SELECT kind,status FROM payment_exceptions WHERE order_id=$1 ORDER BY kind', [order])).rows,
    receipts: await count("SELECT count(*) AS n FROM jobs WHERE tenant_id=$1 AND type='commerce.issue_receipt' AND payload->>'paymentId' IN (SELECT id::text FROM customer_payments WHERE order_id=$2)", [accountA, order]),
    creditNotes: await count("SELECT count(*) AS n FROM jobs WHERE tenant_id=$1 AND type='commerce.issue_credit_note' AND payload->>'refundId' IN (SELECT id::text FROM customer_refunds WHERE order_id=$2)", [accountA, order]),
    paidEvents: await count("SELECT count(*) AS n FROM order_events WHERE order_id=$1 AND kind='payment_captured'", [order]),
    refundEvents: await count("SELECT count(*) AS n FROM order_events WHERE order_id=$1 AND kind='refund_processed'", [order]),
  };
}

describe.skipIf(!db)('[PAY-02] [COM-05] Razorpay commerce webhooks: duplicates and reordering on PostgreSQL', { timeout: 240_000 }, () => {
  beforeAll(async () => {
    owner = new pg.Client({ connectionString: db!.owner });
    await owner.connect();
    await owner.query("INSERT INTO auth_users(id,email,full_name,password_hash) VALUES($1,$2,'Ordering test','test-only-hash')", [adminA, `${adminA}@example.invalid`]);
    await owner.query("INSERT INTO accounts(id,name,owner_user_id) VALUES($1,'Ordering A',$2)", [accountA, adminA]);
    await owner.query("INSERT INTO account_memberships(account_id,user_id,role) VALUES($1,$2,'admin')", [accountA, adminA]);
    await owner.query("INSERT INTO contacts(id,account_id,user_id,name,phone) VALUES($1,$2,$3,'Buyer',$4)", [contactA, accountA, adminA, `+9197${seed}`]);
    convA = (await one("INSERT INTO conversations(account_id,user_id,contact_id,status) VALUES($1,$2,$3,'open') RETURNING id", [accountA, adminA, contactA])).id;
    const product = (await one("INSERT INTO shop_products(account_id,name,status,content_reviewed_at) VALUES($1,'Neem soap','published',now()) RETURNING id", [accountA])).id;
    variant = (await one('INSERT INTO shop_variants(account_id,product_id,sku,price_minor) VALUES($1,$2,$3,10000) RETURNING id', [accountA, product, `NEEM-${seed}`])).id;
    await owner.query('INSERT INTO inventory_levels(account_id,variant_id,on_hand) VALUES($1,$2,100)', [accountA, variant]);
    await withTenant(asAdmin, (tx) => savePaymentProvider(tx, accountA, { keyId: 'rzp_test_OrderKey00001', keySecret: 'test-only-secret', webhookSecret: HOOK_SECRET }));
  });
  afterAll(async () => {
    if (owner) {
      await owner.query('DELETE FROM jobs WHERE tenant_id=$1', [accountA]);
      await owner.query('DELETE FROM webhook_receipts WHERE dedupe_key LIKE $1', [`razorpay:${accountA}:%`]);
      await owner.query('DELETE FROM outbound_intents WHERE account_id=$1', [accountA]);
      await owner.query('DELETE FROM accounts WHERE id=$1', [accountA]);
      await owner.query('DELETE FROM auth_users WHERE id=$1', [adminA]);
      await owner.end();
    }
    await disconnectDatabases();
  });

  it('ends in the in-order state for every order of paid, refund.processed and payment.failed', async () => {
    let baseline: Awaited<ReturnType<typeof snapshot>> | null = null;
    for (const order of permutations(['paid', 'refund', 'failed'] as const)) {
      const run = await paidAndPartlyRefunded();
      // Each delivery is processed before the next arrives (the realistic reorder: a retried delivery lands late).
      for (const name of order) {
        expect(await deliver(run.events[name])).toBe(200);
        await drain();
      }
      const state = await snapshot(run.order, run.linkId);
      if (!baseline) {
        baseline = state;
        // The in-order run: paid once, the partial refund counted once, nothing held.
        expect(state).toMatchObject({
          order: { status: 'paid', paid: 10000, refunded: 4000, refund_state: 'partial' },
          link: { status: 'paid' },
          payments: [{ status: 'captured', settlement: 'settled', amount: 10000, refunded: 4000 }],
          refunds: [{ source: 'external', status: 'processed', amount: 4000 }],
          exceptions: [], receipts: 1, creditNotes: 1, paidEvents: 1, refundEvents: 1,
        });
      } else {
        expect(state, `delivery order ${order.join(' -> ')}`).toEqual(baseline);
      }
    }
  });

  it('applies five concurrent copies of each delivery, and their jobs run concurrently, once', async () => {
    const run = await paidAndPartlyRefunded();
    // Five identical deliveries (same event id) and five redeliveries under new ids, all at once.
    const statuses = await Promise.all([
      ...Array.from({ length: 5 }, () => deliver(run.events.paid, `evt_${seed}_cp`)),
      ...Array.from({ length: 5 }, () => deliver(run.events.paid)),
      ...Array.from({ length: 5 }, () => deliver(run.events.refund, `evt_${seed}_cr`)),
      ...Array.from({ length: 5 }, () => deliver(run.events.refund)),
    ]);
    expect(statuses.every((s) => s === 200)).toBe(true);
    // One receipt per delivery id: 1 + 5 paid, 1 + 5 refund.
    expect(await count("SELECT count(*) AS n FROM jobs WHERE tenant_id=$1 AND type='payments.razorpay_event'", [accountA])).toBe(12);
    await drain(true);
    expect(await snapshot(run.order, run.linkId)).toMatchObject({
      order: { status: 'paid', paid: 10000, refunded: 4000, refund_state: 'partial' },
      payments: [{ settlement: 'settled', refunded: 4000 }],
      refunds: [{ status: 'processed', amount: 4000 }],
      exceptions: [], receipts: 1, creditNotes: 1, paidEvents: 1, refundEvents: 1,
    });
  });
});
