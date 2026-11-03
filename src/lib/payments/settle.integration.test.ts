import { createHmac, randomUUID } from 'node:crypto';
import { config } from 'dotenv';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { disconnectDatabases, getPrisma, getWorkerPrisma } from '@/lib/db/prisma';
import { withTenant, type TenantContext } from '@/lib/db/tenant';
import { withJobScope } from '@/lib/jobs/scope';

// Razorpay is the only fake (its client functions): the webhook route, receipts,
// jobs, rows, RLS, triggers, stock and settlement are real (design §8 tests 2-4).
const h = vi.hoisted(() => {
  let n = 0;
  type Link = { id: string; shortUrl: string; status: string; amountMinor: number; amountPaidMinor: number; currency: string; referenceId: string; expireBy: null;
    payments: { paymentId: string; amountMinor: number; status: string }[] };
  type Payment = { id: string; amountMinor: number; currency: string; status: string; captured: boolean; method: string; amountRefundedMinor: number; createdAt: number };
  const links = new Map<string, Link>();
  const payments = new Map<string, Payment>();
  return {
    links,
    payments,
    next: () => ++n,
    create: vi.fn(async (args: { referenceId: string; amountMinor: number; currency: string }) => {
      const id = `plink_S${++n}x${Date.now() % 100000}`;
      const link: Link = { id, shortUrl: `https://rzp.io/l/s${n}`, status: 'created', amountMinor: args.amountMinor, amountPaidMinor: 0, currency: args.currency,
        referenceId: args.referenceId, expireBy: null, payments: [] };
      links.set(id, link);
      return { outcome: 'created' as const, link };
    }),
    fetch: vi.fn(async (args: { id: string }) => {
      const link = links.get(args.id);
      if (!link) throw new Error('not found');
      return link;
    }),
    fetchByReference: vi.fn(async () => null),
    cancel: vi.fn(async (args: { id: string }) => {
      const link = links.get(args.id)!;
      link.status = 'cancelled';
      return link;
    }),
    fetchPayment: vi.fn(async (args: { id: string }) => {
      const p = payments.get(args.id);
      if (!p) throw new Error('not found');
      return p;
    }),
  };
});
vi.mock('@/lib/payments/razorpay', async (orig) => ({
  ...(await orig<typeof import('./razorpay')>()),
  createPaymentLink: h.create,
  fetchPaymentLink: h.fetch,
  fetchPaymentLinkByReference: h.fetchByReference,
  cancelPaymentLink: h.cancel,
  fetchPayment: h.fetchPayment,
}));

import { reserveTx, releaseTx } from '@/lib/commerce/stock';
import { POST as webhook } from '@/app/api/payments/razorpay/webhook/[accountId]/route';
import { savePaymentProvider } from './providers';
import { createPaymentLinkRecord, handlePaymentEventJob, reconcilePaymentLink } from './links';
import { verifyAndSettle } from './settle';
import { recordOfflinePayment } from './offline';
import { resolvePaymentException } from './exceptions';

const configured = config({ path: '.env.test', quiet: true }).parsed;
const ownerUrl = process.env.TEST_DATABASE_URL;
const appUrl = process.env.TEST_APP_DATABASE_URL || configured?.DATABASE_URL;
const workerUrl = process.env.TEST_WORKER_DATABASE_URL || configured?.WORKER_DATABASE_URL;
if (appUrl) process.env.DATABASE_URL = appUrl;
if (workerUrl) process.env.WORKER_DATABASE_URL = workerUrl;

const accountA = randomUUID(), adminA = randomUUID(), agentA = randomUUID();
const contactA = randomUUID();
const asAdmin = { accountId: accountA, userId: adminA, role: 'admin' as const };
const asAgent = { accountId: accountA, userId: agentA, role: 'agent' as const };
const scope = { accountId: accountA, role: 'owner' as const };
const HOOK_SECRET = 'test-only-hook-secret';
const seed = String(Date.now()).slice(-9);
let owner: pg.Client;
let convA = '';
let endpointA = '';
let variant = '';

const worker = <T>(op: Parameters<typeof withTenant<T>>[1], ctx: TenantContext = scope) => withTenant(ctx, op, getWorkerPrisma());
const one = async (sql: string, params: unknown[]) => (await owner.query(sql, params)).rows[0];
const count = async (sql: string, params: unknown[]) => Number((await owner.query(sql, params)).rows[0].n);
const stock = async () => one('SELECT on_hand,reserved FROM inventory_levels WHERE account_id=$1 AND variant_id=$2', [accountA, variant]);
const setStock = (onHand: number) => owner.query('UPDATE inventory_levels SET on_hand=$3, reserved=0 WHERE account_id=$1 AND variant_id=$2', [accountA, variant, onHand]);

/** A server-priced order (1 x 100.00 INR, tax-inclusive) holding its stock, awaiting payment. */
async function pricedOrder(): Promise<string> {
  const order = (await one(`INSERT INTO orders(account_id,source,contact_id,conversation_id,currency,subtotal_minor,total_minor,tax_inclusive,priced_at,status,reservation_expires_at)
    VALUES($1,'manual',$2,$3,'INR',10000,10000,true,now(),'new',now() + interval '15 minutes') RETURNING id`, [accountA, contactA, convA])).id as string;
  await owner.query(`INSERT INTO order_items(account_id,order_id,variant_id,sku,name,quantity,unit_price_minor,currency,line_total_minor)
    VALUES($1,$2,$3,$4,'Tulsi drops',1,10000,'INR',10000)`, [accountA, order, variant, `TULSI-${seed}`]);
  await worker(async (tx) => {
    await reserveTx(tx, accountA, order, [{ variantId: variant, quantity: 1 }], new Date(Date.now() + 15 * 60_000));
    await tx.$executeRaw`UPDATE orders SET status='awaiting_payment' WHERE account_id=${accountA}::uuid AND id=${order}::uuid`;
  });
  return order;
}

async function linkFor(orderId: string, amountMinor = 10000, currency = 'INR') {
  const { link } = await createPaymentLinkRecord({
    accountId: accountA, actor: { kind: 'bot' }, amountMinor, currency, orderId, referenceId: `co_${randomUUID().replace(/-/g, '')}`,
    expireBy: new Date(Date.now() + 20 * 60_000),
  });
  return { ...link, provider_link_id: link.provider_link_id!, reference_id: (await one('SELECT reference_id FROM payment_links WHERE id=$1', [link.id])).reference_id as string };
}

/** Razorpay records a payment against the link (status as Razorpay reports it). */
function gatewayPays(providerLinkId: string, opts: { amount?: number; currency?: string; status?: string; listed?: boolean } = {}): string {
  const link = h.links.get(providerLinkId)!;
  const id = `pay_S${h.next()}x${Date.now() % 100000}`;
  const amount = opts.amount ?? link.amountMinor;
  h.payments.set(id, { id, amountMinor: amount, currency: opts.currency ?? link.currency, status: opts.status ?? 'captured', captured: (opts.status ?? 'captured') === 'captured',
    method: 'upi', amountRefundedMinor: 0, createdAt: Math.floor(Date.now() / 1000) });
  if (opts.listed !== false) link.payments.push({ paymentId: id, amountMinor: amount, status: opts.status ?? 'captured' });
  link.status = 'paid';
  link.amountPaidMinor = amount;
  return id;
}

/** A signed Razorpay delivery through the real route; returns the HTTP status. */
async function deliver(body: Record<string, unknown>, eventId?: string): Promise<number> {
  const raw = JSON.stringify(body);
  const headers: Record<string, string> = { 'x-razorpay-signature': createHmac('sha256', HOOK_SECRET).update(raw).digest('hex') };
  if (eventId) headers['x-razorpay-event-id'] = eventId;
  const res = await webhook(new Request(`http://localhost/api/payments/razorpay/webhook/${accountA}`, { method: 'POST', body: raw, headers }),
    { params: Promise.resolve({ accountId: accountA }) });
  return res.status;
}
const linkEvent = (event: string, link: { provider_link_id: string; reference_id: string }, paymentId?: string) => ({
  event, account_id: 'acc_TestMerchant1',
  payload: {
    payment_link: { entity: { id: link.provider_link_id, reference_id: link.reference_id, status: event.split('.')[1], amount: 10000, amount_paid: 10000, currency: 'INR' } },
    ...(paymentId ? { payment: { entity: { id: paymentId, amount: 10000, currency: 'INR', status: 'captured', contact: '+919800000000' } } } : {}),
  },
});

/** Runs every queued Razorpay event job for the workspace, as the worker would. */
async function runEventJobs(): Promise<void> {
  const jobs = (await owner.query("DELETE FROM jobs WHERE tenant_id=$1 AND type='payments.razorpay_event' RETURNING payload", [accountA])).rows;
  for (const job of jobs) await withJobScope(scope, () => handlePaymentEventJob(accountA, job.payload));
}

const exceptions = (orderId: string) => owner.query('SELECT kind,status,payment_id IS NOT NULL AS has_payment FROM payment_exceptions WHERE account_id=$1 AND order_id=$2 ORDER BY created_at', [accountA, orderId]).then((r) => r.rows);
const orderRow = (orderId: string) => one('SELECT status,amount_paid_minor::int AS paid,paid_at FROM orders WHERE id=$1', [orderId]);

describe.skipIf(!ownerUrl || !appUrl || !workerUrl)('Customer payment settlement on PostgreSQL', { timeout: 180_000 }, () => {
  beforeAll(async () => {
    owner = new pg.Client({ connectionString: ownerUrl });
    await owner.connect();
    if (!/test/i.test((await owner.query('SELECT current_database() AS name')).rows[0].name)) throw new Error('Requires an isolated test database');
    const app = await getPrisma().$queryRaw<{ role: string }[]>`SELECT current_user AS role`;
    if (app[0].role !== 'bodhinox_app') throw new Error('Requires constrained test app credentials');
    await owner.query("INSERT INTO auth_users(id,email,full_name,password_hash) SELECT x, x::text || '@example.invalid', 'Settle test', 'test-only-hash' FROM unnest($1::uuid[]) x", [[adminA, agentA]]);
    await owner.query("INSERT INTO accounts(id,name,owner_user_id) VALUES($1,'Settle A',$2)", [accountA, adminA]);
    await owner.query("INSERT INTO account_memberships(account_id,user_id,role) VALUES($1,$2,'admin'),($1,$3,'agent')", [accountA, adminA, agentA]);
    await owner.query("INSERT INTO contacts(id,account_id,user_id,name,phone) VALUES($1,$2,$3,'Buyer',$4)", [contactA, accountA, adminA, `+9196${seed}`]);
    convA = (await one("INSERT INTO conversations(account_id,user_id,contact_id,status) VALUES($1,$2,$3,'open') RETURNING id", [accountA, adminA, contactA])).id;
    endpointA = (await one("INSERT INTO webhook_endpoints(account_id,url,secret,events) VALUES($1,'https://example.invalid/s','test-only',ARRAY['payment_link.paid','order.paid']) RETURNING id", [accountA])).id;
    const product = (await one("INSERT INTO shop_products(account_id,name,status,content_reviewed_at) VALUES($1,'Tulsi drops','published',now()) RETURNING id", [accountA])).id;
    variant = (await one('INSERT INTO shop_variants(account_id,product_id,sku,price_minor) VALUES($1,$2,$3,10000) RETURNING id', [accountA, product, `TULSI-${seed}`])).id;
    await owner.query('INSERT INTO inventory_levels(account_id,variant_id,on_hand) VALUES($1,$2,1)', [accountA, variant]);
    await withTenant(asAdmin, (tx) => savePaymentProvider(tx, accountA, { keyId: 'rzp_test_SettleKey0001', keySecret: 'test-only-secret', webhookSecret: HOOK_SECRET }));
  });
  beforeEach(async () => {
    vi.clearAllMocks();
    await setStock(1);
  });
  afterAll(async () => {
    if (owner) {
      await owner.query('DELETE FROM jobs WHERE tenant_id=$1', [accountA]);
      await owner.query('DELETE FROM webhook_receipts WHERE dedupe_key LIKE $1', [`razorpay:${accountA}:%`]);
      await owner.query('DELETE FROM outbound_intents WHERE account_id=$1', [accountA]);
      await owner.query('DELETE FROM accounts WHERE id=$1', [accountA]);
      await owner.query('DELETE FROM auth_users WHERE id=ANY($1::uuid[])', [[adminA, agentA]]);
      await owner.end();
    }
    await disconnectDatabases();
  });

  describe('duplicate webhooks (gate)', () => {
    it('credits one captured payment once, however often and however concurrently it is reported', async () => {
      const order = await pricedOrder();
      expect(await stock()).toEqual({ on_hand: 1, reserved: 1 });
      const link = await linkFor(order);
      const paymentId = gatewayPays(link.provider_link_id);
      const paid = linkEvent('payment_link.paid', link, paymentId);

      // The same signed delivery twice, then again under a new event id.
      expect(await deliver(paid, `evt_${seed}_dup`)).toBe(200);
      expect(await deliver(paid, `evt_${seed}_dup`)).toBe(200);
      expect(await deliver(paid, `evt_${seed}_dup2`)).toBe(200);
      // The jobs and a concurrent reconcile race each other.
      const jobs = (await owner.query("DELETE FROM jobs WHERE tenant_id=$1 AND type='payments.razorpay_event' RETURNING payload", [accountA])).rows;
      expect(jobs).toHaveLength(2);
      await Promise.all([
        ...jobs.map((job) => withJobScope(scope, () => handlePaymentEventJob(accountA, job.payload))),
        verifyAndSettle(accountA, link.id),
        reconcilePaymentLink(accountA, link.id),
      ]);

      expect(await count('SELECT count(*) AS n FROM customer_payments WHERE account_id=$1 AND order_id=$2', [accountA, order])).toBe(1);
      expect(await one('SELECT settlement,status,provider_account_id FROM customer_payments WHERE account_id=$1 AND provider_payment_id=$2', [accountA, paymentId]))
        .toMatchObject({ settlement: 'settled', status: 'captured' });
      expect(await orderRow(order)).toMatchObject({ status: 'paid', paid: 10000 });
      expect(await count("SELECT count(*) AS n FROM order_events WHERE order_id=$1 AND kind='status_changed' AND to_status='paid'", [order])).toBe(1);
      expect(await count("SELECT count(*) AS n FROM order_events WHERE order_id=$1 AND kind='payment_captured'", [order])).toBe(1);
      expect(await count("SELECT count(*) AS n FROM jobs WHERE tenant_id=$1 AND type='commerce.issue_receipt' AND payload->>'paymentId' IN (SELECT id::text FROM customer_payments WHERE order_id=$2)", [accountA, order])).toBe(1);
      expect(await count("SELECT count(*) AS n FROM jobs WHERE tenant_id=$1 AND type='webhook.delivery' AND dedupe_key LIKE $2", [accountA, `outbound-webhook:order.paid:${order}:%`])).toBe(1);
      expect(await count("SELECT count(*) AS n FROM jobs WHERE tenant_id=$1 AND type='webhook.delivery' AND dedupe_key LIKE $2", [accountA, `outbound-webhook:payment_link.paid:${link.id}:%`])).toBe(1);
      expect(await count("SELECT count(*) AS n FROM inventory_movements WHERE order_id=$1 AND kind='sale'", [order])).toBe(1);
      expect(await stock()).toEqual({ on_hand: 0, reserved: 0 });
      expect(await exceptions(order)).toEqual([]);
      // Razorpay's merchant id is kept for audit only; no customer detail reached the receipt.
      const receipts = (await owner.query('SELECT payload FROM webhook_receipts WHERE dedupe_key LIKE $1', [`razorpay:${accountA}:evt_${seed}_dup%`])).rows;
      expect(JSON.stringify(receipts)).not.toContain('9800000000');

      // An expiry after paid, and a payment.* event, change nothing.
      expect(await deliver(linkEvent('payment_link.expired', link), `evt_${seed}_exp`)).toBe(200);
      expect(await deliver({ event: 'payment.captured', payload: { payment: { entity: { id: paymentId, amount: 10000 } } } }, `evt_${seed}_pc`)).toBe(200);
      await runEventJobs();
      expect(await one('SELECT status FROM payment_links WHERE id=$1', [link.id])).toEqual({ status: 'paid' });
      expect(await orderRow(order)).toMatchObject({ status: 'paid', paid: 10000 });
      expect(await count('SELECT count(*) AS n FROM webhook_receipts WHERE dedupe_key=$1', [`razorpay:${accountA}:evt_${seed}_pc`])).toBe(0);
    });

    it('never settles from the link status or the success redirect alone', async () => {
      const order = await pricedOrder();
      const link = await linkFor(order);
      // Razorpay has no payment recorded against the link (a forged or premature "paid").
      h.links.get(link.provider_link_id)!.status = 'paid';
      expect(await deliver(linkEvent('payment_link.paid', link, 'pay_NotOnThisLink1'), `evt_${seed}_bare`)).toBe(200);
      await runEventJobs();
      expect(h.fetchPayment).not.toHaveBeenCalled();
      expect(await orderRow(order)).toMatchObject({ status: 'awaiting_payment', paid: 0 });
      expect(await count('SELECT count(*) AS n FROM customer_payments WHERE account_id=$1 AND order_id=$2', [accountA, order])).toBe(0);
      await worker((tx) => releaseTx(tx, accountA, order, 'cancelled'));
    });
  });

  describe('late and unexpected payments (E9)', () => {
    const expire = (order: string) => worker(async (tx) => {
      await releaseTx(tx, accountA, order, 'expired');
      await tx.$executeRaw`UPDATE orders SET status='expired' WHERE account_id=${accountA}::uuid AND id=${order}::uuid`;
    });

    it('takes the stock back for a payment after expiry when it is still there', async () => {
      const order = await pricedOrder();
      const link = await linkFor(order);
      await expire(order);
      expect(await stock()).toEqual({ on_hand: 1, reserved: 0 });
      gatewayPays(link.provider_link_id);
      await verifyAndSettle(accountA, link.id);
      expect(await orderRow(order)).toMatchObject({ status: 'paid', paid: 10000 });
      expect(await count("SELECT count(*) AS n FROM order_events WHERE order_id=$1 AND kind='late_payment_restocked'", [order])).toBe(1);
      expect(await stock()).toEqual({ on_hand: 0, reserved: 0 });
    });

    it('holds a late payment for review when the stock was sold, refuses dispatch, and accepts it once restocked', async () => {
      const order = await pricedOrder();
      const link = await linkFor(order);
      await expire(order);
      await setStock(0);
      gatewayPays(link.provider_link_id);
      await verifyAndSettle(accountA, link.id);
      expect(await orderRow(order)).toMatchObject({ status: 'payment_review', paid: 0 });
      expect(await exceptions(order)).toEqual([{ kind: 'late_payment_no_stock', status: 'open', has_payment: true }]);
      expect(await count("SELECT count(*) AS n FROM notifications WHERE account_id=$1 AND type='payment_exception'", [accountA])).toBeGreaterThan(0);
      // Staff cannot dispatch (or otherwise move) it from review.
      await expect(withTenant(asAgent, (tx) => tx.$executeRaw`UPDATE orders SET status='dispatched' WHERE account_id=${accountA}::uuid AND id=${order}::uuid`))
        .rejects.toThrow();
      // Restock, then accept: credited exactly as settlement would have.
      const exceptionId = (await one('SELECT id FROM payment_exceptions WHERE order_id=$1', [order])).id;
      await expect(resolvePaymentException({ ...asAdmin }, exceptionId, 'restocked')).rejects.toMatchObject({ code: 'out_of_stock' });
      await setStock(1);
      await expect(resolvePaymentException({ ...asAgent }, exceptionId, 'restocked')).rejects.toThrow();
      await resolvePaymentException({ ...asAdmin }, exceptionId, 'restocked');
      expect(await orderRow(order)).toMatchObject({ status: 'paid', paid: 10000 });
      expect(await exceptions(order)).toEqual([{ kind: 'late_payment_no_stock', status: 'resolved', has_payment: true }]);
      expect(await stock()).toEqual({ on_hand: 0, reserved: 0 });
    });

    it('keeps a cancelled order cancelled and holds a payment that arrives after', async () => {
      const order = await pricedOrder();
      const link = await linkFor(order);
      await worker(async (tx) => {
        await releaseTx(tx, accountA, order, 'cancelled');
        await tx.$executeRaw`UPDATE orders SET status='cancelled' WHERE account_id=${accountA}::uuid AND id=${order}::uuid`;
      });
      gatewayPays(link.provider_link_id);
      await verifyAndSettle(accountA, link.id);
      expect(await orderRow(order)).toMatchObject({ status: 'cancelled', paid: 0 });
      expect(await exceptions(order)).toEqual([{ kind: 'payment_on_closed_order', status: 'open', has_payment: true }]);
      expect(await stock()).toEqual({ on_hand: 1, reserved: 0 });
    });

    it('never credits a second link paid for an order already paid', async () => {
      const order = await pricedOrder();
      const first = await linkFor(order);
      gatewayPays(first.provider_link_id);
      await verifyAndSettle(accountA, first.id);
      const second = await linkFor(order);
      gatewayPays(second.provider_link_id);
      await verifyAndSettle(accountA, second.id);
      expect(await orderRow(order)).toMatchObject({ status: 'paid', paid: 10000 });
      expect(await exceptions(order)).toEqual([{ kind: 'duplicate_payment', status: 'open', has_payment: true }]);
    });

    it('cancels the open link for an offline payment, then holds a gateway capture that still lands', async () => {
      const order = await pricedOrder();
      const link = await linkFor(order);
      await expect(recordOfflinePayment({ ...asAgent }, order, { amount: '100.00', method: 'cash', clientRequestId: randomUUID() })).rejects.toThrow();
      await expect(recordOfflinePayment({ ...asAdmin }, order, { amount: '99.00', method: 'cash', clientRequestId: randomUUID() }))
        .rejects.toMatchObject({ code: 'amount_not_due' });
      const requestId = randomUUID();
      const { paymentId } = await recordOfflinePayment({ ...asAdmin }, order, { amount: '100.00', method: 'cash', reference: 'Till 3', clientRequestId: requestId });
      // A replayed click returns the same payment.
      expect((await recordOfflinePayment({ ...asAdmin }, order, { amount: '100.00', method: 'cash', reference: 'Till 3', clientRequestId: requestId })).paymentId).toBe(paymentId);
      expect(h.cancel).toHaveBeenCalledTimes(1);
      expect(await one('SELECT status FROM payment_links WHERE id=$1', [link.id])).toEqual({ status: 'cancelled' });
      expect(await one('SELECT source,settlement,recorded_by,offline_reference FROM customer_payments WHERE id=$1', [paymentId]))
        .toEqual({ source: 'offline', settlement: 'settled', recorded_by: adminA, offline_reference: 'Till 3' });
      expect(await orderRow(order)).toMatchObject({ status: 'paid', paid: 10000 });
      expect(await one("SELECT actor,actor_user_id FROM order_events WHERE order_id=$1 AND kind='payment_recorded'", [order])).toEqual({ actor: 'staff', actor_user_id: adminA });
      expect(await count("SELECT count(*) AS n FROM audit_logs WHERE account_id=$1 AND action='commerce.offline_payment_recorded' AND resource_id=$2", [accountA, paymentId])).toBe(1);
      // The customer had already paid online at the same moment.
      gatewayPays(link.provider_link_id);
      await deliver(linkEvent('payment_link.paid', link), `evt_${seed}_race`);
      await runEventJobs();
      expect(await orderRow(order)).toMatchObject({ status: 'paid', paid: 10000 });
      expect(await exceptions(order)).toEqual([{ kind: 'duplicate_payment', status: 'open', has_payment: true }]);
    });
  });

  describe('verification (E7, E8)', () => {
    it('holds a payment whose amount or currency differs from its link', async () => {
      const order = await pricedOrder();
      const link = await linkFor(order);
      gatewayPays(link.provider_link_id, { amount: 9000 });
      await verifyAndSettle(accountA, link.id);
      expect(await exceptions(order)).toEqual([{ kind: 'amount_mismatch', status: 'open', has_payment: true }]);
      expect(await orderRow(order)).toMatchObject({ status: 'awaiting_payment', paid: 0 });

      const order2 = await setStock(2).then(() => pricedOrder());
      const link2 = await linkFor(order2);
      gatewayPays(link2.provider_link_id, { currency: 'USD' });
      await verifyAndSettle(accountA, link2.id);
      expect(await exceptions(order2)).toEqual([{ kind: 'currency_mismatch', status: 'open', has_payment: true }]);
    });

    it('records an authorized payment without settling it, and settles it once captured', async () => {
      const order = await pricedOrder();
      const link = await linkFor(order);
      const paymentId = gatewayPays(link.provider_link_id, { status: 'authorized' });
      expect(await verifyAndSettle(accountA, link.id)).toEqual([{ kind: 'not_captured', paymentId: expect.any(String) }]);
      expect(await one('SELECT status,settlement FROM customer_payments WHERE provider_payment_id=$1', [paymentId])).toEqual({ status: 'authorized', settlement: 'pending' });
      expect(await orderRow(order)).toMatchObject({ status: 'awaiting_payment' });
      Object.assign(h.payments.get(paymentId)!, { status: 'captured', captured: true });
      expect((await verifyAndSettle(accountA, link.id))[0]).toMatchObject({ kind: 'settled' });
      expect(await orderRow(order)).toMatchObject({ status: 'paid', paid: 10000 });
    });

    it('holds an agent-made link whose amount is not what the order owes', async () => {
      const order = await pricedOrder();
      const link = await linkFor(order, 5000);
      gatewayPays(link.provider_link_id);
      await verifyAndSettle(accountA, link.id);
      expect(await exceptions(order)).toEqual([{ kind: 'amount_mismatch', status: 'open', has_payment: true }]);
      expect(await orderRow(order)).toMatchObject({ status: 'awaiting_payment', paid: 0 });
    });

    it('never fetches a link made under keys that were since replaced', async () => {
      const order = await pricedOrder();
      const link = await linkFor(order);
      expect(await one('SELECT provider_key_id FROM payment_links WHERE id=$1', [link.id])).toEqual({ provider_key_id: 'rzp_test_SettleKey0001' });
      gatewayPays(link.provider_link_id);
      await withTenant(asAdmin, (tx) => savePaymentProvider(tx, accountA, { keyId: 'rzp_test_OtherKey00002', keySecret: 'test-only-secret-2' }));
      try {
        expect(await verifyAndSettle(accountA, link.id)).toEqual([{ kind: 'skipped', reason: 'merchant_changed' }]);
        expect(h.fetch).not.toHaveBeenCalled();
        expect(await one("SELECT kind FROM payment_exceptions WHERE payment_link_id=$1", [link.id])).toEqual({ kind: 'merchant_changed' });
        expect(await orderRow(order)).toMatchObject({ status: 'awaiting_payment', paid: 0 });
      } finally {
        await withTenant(asAdmin, (tx) => savePaymentProvider(tx, accountA, { keyId: 'rzp_test_SettleKey0001', keySecret: 'test-only-secret' }));
        await worker((tx) => releaseTx(tx, accountA, order, 'cancelled'));
      }
    });

    it('surfaces a paid event for one of our references that has no link here', async () => {
      const providerLinkId = `plink_Ghost${seed}`;
      await deliver(linkEvent('payment_link.paid', { provider_link_id: providerLinkId, reference_id: `co_${'g'.repeat(32)}` }), `evt_${seed}_ghost`);
      await runEventJobs();
      expect(await one('SELECT kind,status FROM payment_exceptions WHERE account_id=$1 AND subject_key=$2', [accountA, `link:${providerLinkId}`]))
        .toEqual({ kind: 'payment_unmatched', status: 'open' });
    });

    it('lets the app role read payments but never write them', async () => {
      await expect(withTenant(asAdmin, (tx) => tx.$executeRaw`INSERT INTO customer_payments(account_id,source,amount_minor,currency,status)
        VALUES(${accountA}::uuid,'offline',1,'INR','captured')`)).rejects.toThrow();
      expect(await withTenant(asAgent, (tx) => tx.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM customer_payments`)).toEqual([{ n: expect.any(Number) }]);
      const viewer = await withTenant({ accountId: accountA, userId: agentA, role: 'viewer' }, (tx) => tx.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM customer_payments`);
      expect(viewer).toEqual([{ n: 0 }]);
      // endpointA is used by the gate test above.
      expect(endpointA).toBeTruthy();
    });
  });
});
