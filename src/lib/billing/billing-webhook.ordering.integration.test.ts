import { createHmac, randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { fixtureDatabaseUrls } from '@/test/tenancy/fixtures';
import { drainJobs, permutations } from '@/test/fixtures/providers/drain';
import type { BillingProvider, BillingSubscription, ProviderSubscriptionState } from './provider';

// Duplicate and reordered SaaS billing deliveries (design 1.3, P1). The provider's HTTP
// calls are the only fake; signature checking and payload parsing are the real
// RazorpayBilling code, and the route, billing_events, jobs, the job dispatcher,
// lifecycle, invoices and RLS are real. Each event's job re-fetches the
// subscription, so the provider's final state decides; every delivery order must
// end where the in-order run ends.
const WEBHOOK_SECRET = 'test-only-billing-ordering';
Object.assign(process.env, {
  BILLING_RAZORPAY_KEY_ID: 'rzp_test_ordering', BILLING_RAZORPAY_KEY_SECRET: 'test-only', BILLING_RAZORPAY_WEBHOOK_SECRET: WEBHOOK_SECRET,
  BILLING_SELLER_STATE_CODE: '29',
});

const h = vi.hoisted(() => ({ provider: null as unknown }));
vi.mock('@/lib/billing/razorpay-billing', async (orig) => ({
  ...(await orig<typeof import('./razorpay-billing')>()),
  getBillingProvider: () => h.provider,
}));

import { disconnectDatabases } from '@/lib/db/prisma';
import { withTenant } from '@/lib/db/tenant';
import { POST as webhook } from '@/app/api/billing/webhook/route';
import { gstinCheckChar } from './gst';
import { saveBillingProfile } from './profile';
import { RazorpayBilling } from './razorpay-billing';
import { startCheckout } from './subscriptions';
import { toSubscriptionStatus } from './provider';

const db = fixtureDatabaseUrls();
if (db) {
  process.env.DATABASE_URL = db.app;
  process.env.WORKER_DATABASE_URL = db.worker;
}

const tag = randomUUID().slice(0, 6);
const plan = `rord_${tag}`, providerPlan = `plan_ROrd${tag}`;
const GSTIN = `29ABCDE1234F1Z${gstinCheckChar('29ABCDE1234F1Z')}`;
const accounts: string[] = [];
const users: string[] = [];
const eventRowIds: string[] = [];
let owner: pg.Client;
let seq = 0;

/** An in-memory Razorpay: the real client's webhook verification and parsing, fake HTTP calls. */
class FakeRazorpay implements BillingProvider {
  readonly name = 'razorpay' as const;
  private readonly real = new RazorpayBilling({ keyId: 'rzp_test_ordering', keySecret: 'test-only', webhookSecret: WEBHOOK_SECRET });
  subs = new Map<string, BillingSubscription>();
  created = 0;
  set(id: string, state: ProviderSubscriptionState, extra: Partial<BillingSubscription> = {}) {
    const sub = { ...this.subs.get(id)!, state, status: toSubscriptionStatus(state), ...extra };
    this.subs.set(id, sub);
    return sub;
  }
  async createCustomer() { return { outcome: 'ok' as const, value: { id: `cust_O${tag}` } }; }
  async createSubscription(args: { planId: string; customerId: string; notes: Record<string, string> }) {
    this.created++;
    // A provider round trip: concurrent checkouts overlap here.
    await new Promise((r) => setTimeout(r, 30));
    const id = `sub_O${tag}${this.subs.size}`;
    const sub: BillingSubscription = { id, planId: args.planId, customerId: args.customerId, state: 'created', status: 'incomplete',
      currentStart: null, currentEnd: null, startAt: null, endedAt: null, shortUrl: `https://rzp.io/i/${id}`, hasScheduledChanges: false, notes: args.notes };
    this.subs.set(id, sub);
    return { outcome: 'ok' as const, value: sub };
  }
  async cancelSubscription(args: { id: string }) { return { outcome: 'ok' as const, value: this.set(args.id, 'cancelled') }; }
  async changePlan() { return { outcome: 'unknown' as const }; }
  async createAddon() { return { outcome: 'unknown' as const }; }
  async fetchSubscription(id: string) {
    const sub = this.subs.get(id);
    return sub ? { outcome: 'ok' as const, value: sub } : { outcome: 'rejected' as const, reason: 'not_found' as const, httpStatus: 404 };
  }
  async findSubscription(args: { intentId: string }) {
    return { outcome: 'ok' as const, value: [...this.subs.values()].find((s) => s.notes.intent_id === args.intentId) ?? null };
  }
  verifyWebhook(raw: string | Buffer, signature: string | null | undefined) { return this.real.verifyWebhook(raw, signature); }
  parseWebhook(body: unknown) { return this.real.parseWebhook(body); }
}
const provider = new FakeRazorpay();
h.provider = provider;

/** A workspace with a billing profile and an open checkout (the real startCheckout); returns its subscription id. */
async function workspaceWithCheckout(): Promise<{ accountId: string; subId: string }> {
  const accountId = randomUUID(), userId = randomUUID();
  accounts.push(accountId); users.push(userId);
  await owner.query("INSERT INTO auth_users(id,email,full_name,password_hash) VALUES($1,$2,'Billing ordering','test-only-hash')", [userId, `${userId}@example.invalid`]);
  await owner.query("INSERT INTO accounts(id,name,owner_user_id) VALUES($1,'Billing ordering',$2)", [accountId, userId]);
  await owner.query("INSERT INTO account_memberships(account_id,user_id,role) VALUES($1,$2,'owner')", [accountId, userId]);
  await withTenant({ accountId, userId, role: 'owner' }, (tx) => saveBillingProfile(tx, accountId, { legalName: 'Ordering Pvt Ltd', gstin: GSTIN,
    addressLine1: '1 MG Road', addressLine2: null, city: 'Bengaluru', stateCode: '29', postalCode: '560001', country: 'IN', email: 'billing@ordering.example' }));
  const checkout = await startCheckout({ accountId, userId, plan, interval: 'month' }, provider);
  if (checkout.state !== 'ready') throw new Error('checkout not ready');
  return { accountId, subId: checkout.subscriptionId };
}

/** A Razorpay-shaped webhook body for the subscription as the provider holds it (or `state` for a stale copy). */
function body(type: string, sub: BillingSubscription, opts: { state?: string; paymentId?: string } = {}) {
  const secs = (d: Date | null) => (d ? Math.floor(d.getTime() / 1000) : null);
  return {
    entity: 'event', event: type, created_at: Math.floor(Date.now() / 1000),
    payload: {
      subscription: { entity: { id: sub.id, plan_id: sub.planId, status: opts.state ?? sub.state, current_start: secs(sub.currentStart), current_end: secs(sub.currentEnd), notes: sub.notes } },
      ...(opts.paymentId ? { payment: { entity: { id: opts.paymentId, amount: 118000, currency: 'INR', status: 'captured', invoice_id: `inv_O${opts.paymentId.slice(5)}` } } } : {}),
    },
  };
}

async function deliver(payload: Record<string, unknown>, eventId = `evt_BO${tag}_${++seq}`): Promise<number> {
  const raw = JSON.stringify(payload);
  const res = await webhook(new Request('http://localhost/api/billing/webhook', { method: 'POST', body: raw,
    headers: { 'x-razorpay-signature': createHmac('sha256', WEBHOOK_SECRET).update(raw).digest('hex'), 'x-razorpay-event-id': eventId } }));
  const row = (await owner.query('SELECT id::text FROM billing_events WHERE event_id=$1', [eventId])).rows[0];
  if (row && !eventRowIds.includes(row.id)) eventRowIds.push(row.id);
  return res.status;
}

const drain = (concurrent = false) => drainJobs(owner, { types: ['billing.event'], payloadIds: { key: 'eventId', values: eventRowIds } }, { concurrent });

async function snapshot(accountId: string) {
  return {
    subscription: (await owner.query('SELECT plan_id,status,cancel_at_period_end FROM account_subscriptions WHERE account_id=$1', [accountId])).rows,
    intents: (await owner.query("SELECT kind,status FROM billing_intents WHERE account_id=$1 ORDER BY kind", [accountId])).rows,
    invoices: (await owner.query('SELECT status,total_minor::int AS total FROM invoices WHERE account_id=$1', [accountId])).rows,
    unprocessed: Number((await owner.query('SELECT count(*) AS n FROM billing_events WHERE account_id=$1 AND processed_at IS NULL', [accountId])).rows[0].n),
    reconciliation: (await owner.query("SELECT kind,detail->>'reason' AS reason FROM billing_reconciliation_items WHERE account_id=$1 AND status='open' ORDER BY 1,2", [accountId])).rows,
  };
}

describe.skipIf(!db)('[BIL-02] Razorpay billing webhooks: duplicates and reordering on PostgreSQL', { timeout: 240_000 }, () => {
  beforeAll(async () => {
    owner = new pg.Client({ connectionString: db!.owner });
    await owner.connect();
    await owner.query("INSERT INTO plans(id,name,sort,features,limits) VALUES($1,'Ordering',903,'{}','{}')", [plan]);
    await owner.query(`INSERT INTO plan_prices(plan,"interval",amount_minor,provider_plan_id) VALUES($1,'month',118000,$2)`, [plan, providerPlan]);
  });
  afterAll(async () => {
    if (owner) {
      await owner.query("DELETE FROM jobs WHERE type='billing.event' AND payload->>'eventId' = ANY($1::text[])", [eventRowIds]);
      await owner.query("DELETE FROM jobs WHERE tenant_id = ANY($1::uuid[])", [accounts]);
      await owner.query('DELETE FROM billing_reconciliation_items WHERE account_id = ANY($1::uuid[])', [accounts]);
      await owner.query('DELETE FROM billing_events WHERE event_id LIKE $1', [`evt_BO${tag}_%`]);
      await owner.query('DELETE FROM accounts WHERE id = ANY($1::uuid[])', [accounts]);
      await owner.query('DELETE FROM auth_users WHERE id = ANY($1::uuid[])', [users]);
      await owner.query('DELETE FROM plan_prices WHERE plan=$1', [plan]);
      await owner.query('DELETE FROM plans WHERE id=$1', [plan]);
      await owner.end();
    }
    await disconnectDatabases();
  });

  it('ends active with one invoice for every order of activated, charged and a stale pending', async () => {
    let baseline: Awaited<ReturnType<typeof snapshot>> | null = null;
    for (const order of permutations(['activated', 'charged', 'pending'] as const)) {
      const { accountId, subId } = await workspaceWithCheckout();
      const sub = provider.set(subId, 'active', { currentStart: new Date(), currentEnd: new Date(Date.now() + 30 * 86_400_000) });
      const paymentId = `pay_O${tag}${++seq}`;
      const events = {
        activated: body('subscription.activated', sub),
        charged: body('subscription.charged', sub, { paymentId }),
        // A pending delivered late, after the retry that charged it succeeded.
        pending: body('subscription.pending', sub, { state: 'pending' }),
      };
      for (const name of order) {
        expect(await deliver(events[name])).toBe(200);
        await drain();
      }
      const state = await snapshot(accountId);
      if (!baseline) {
        baseline = state;
        expect(state).toEqual({ subscription: [{ plan_id: plan, status: 'active', cancel_at_period_end: false }], intents: [{ kind: 'checkout', status: 'completed' }],
          invoices: [{ status: 'paid', total: 118000 }], unprocessed: 0, reconciliation: [] });
      } else {
        expect(state, `delivery order ${order.join(' -> ')}`).toEqual(baseline);
      }
    }
  });

  it('never leaves a paid charge silent when the subscription was cancelled before its events ran', async () => {
    let baseline: Awaited<ReturnType<typeof snapshot>> | null = null;
    for (const order of permutations(['activated', 'charged', 'cancelled'] as const)) {
      const { accountId, subId } = await workspaceWithCheckout();
      const active = provider.set(subId, 'active', { currentStart: new Date(), currentEnd: new Date(Date.now() + 30 * 86_400_000) });
      const paymentId = `pay_O${tag}${++seq}`;
      const events = {
        activated: body('subscription.activated', active),
        charged: body('subscription.charged', active, { paymentId }),
        cancelled: body('subscription.cancelled', active, { state: 'cancelled' }),
      };
      // The customer paid and cancelled at once; the provider now reports cancelled to every fetch.
      provider.set(subId, 'cancelled');
      for (const name of order) {
        expect(await deliver(events[name])).toBe(200);
        await drain();
      }
      const state = await snapshot(accountId);
      // Money was taken: it is invoiced, or it is open for an operator. Never neither.
      expect(state.invoices.length + state.reconciliation.length, `delivery order ${order.join(' -> ')}`).toBeGreaterThan(0);
      if (!baseline) baseline = state;
      else expect(state, `delivery order ${order.join(' -> ')}`).toEqual(baseline);
    }
  });

  it('issues one invoice for five concurrent copies of a charge, and their jobs run concurrently', async () => {
    const { accountId, subId } = await workspaceWithCheckout();
    const sub = provider.set(subId, 'active', { currentStart: new Date(), currentEnd: new Date(Date.now() + 30 * 86_400_000) });
    const charged = body('subscription.charged', sub, { paymentId: `pay_O${tag}${++seq}` });
    const statuses = await Promise.all([
      ...Array.from({ length: 5 }, () => deliver(charged, `evt_BO${tag}_same`)),
      ...Array.from({ length: 5 }, () => deliver(charged)),
    ]);
    expect(statuses.every((s) => s === 200)).toBe(true);
    // One stored event per delivery id.
    expect(Number((await owner.query('SELECT count(*) AS n FROM billing_events WHERE event_id LIKE $1 AND payload->>\'subscriptionId\'=$2', [`evt_BO${tag}_%`, subId])).rows[0].n)).toBe(6);
    await drain(true);
    expect(await snapshot(accountId)).toMatchObject({ subscription: [{ status: 'active' }], invoices: [{ status: 'paid', total: 118000 }], unprocessed: 0, reconciliation: [] });
  });

  it('[BIL-02] opens one pending checkout for five concurrent checkout starts', async () => {
    const accountId = randomUUID(), userId = randomUUID();
    accounts.push(accountId); users.push(userId);
    await owner.query("INSERT INTO auth_users(id,email,full_name,password_hash) VALUES($1,$2,'Billing ordering','test-only-hash')", [userId, `${userId}@example.invalid`]);
    await owner.query("INSERT INTO accounts(id,name,owner_user_id) VALUES($1,'Billing checkout race',$2)", [accountId, userId]);
    await owner.query("INSERT INTO account_memberships(account_id,user_id,role) VALUES($1,$2,'owner')", [accountId, userId]);
    await withTenant({ accountId, userId, role: 'owner' }, (tx) => saveBillingProfile(tx, accountId, { legalName: 'Race Pvt Ltd', gstin: GSTIN,
      addressLine1: '1 MG Road', addressLine2: null, city: 'Bengaluru', stateCode: '29', postalCode: '560001', country: 'IN', email: 'billing@race.example' }));
    const before = provider.created;
    const results = await Promise.all(Array.from({ length: 5 }, () => startCheckout({ accountId, userId, plan, interval: 'month' }, provider)));
    expect(provider.created - before).toBe(1);
    expect((await owner.query("SELECT status FROM billing_intents WHERE account_id=$1 AND kind='checkout'", [accountId])).rows).toEqual([{ status: 'created' }]);
    // One caller got the checkout; the others were told it is in progress, never a second subscription.
    expect(results.filter((r) => r.state === 'ready')).toHaveLength(1);
    expect(results.filter((r) => r.state === 'pending')).toHaveLength(4);
    // Once created, a retry reuses it.
    expect(await startCheckout({ accountId, userId, plan, interval: 'month' }, provider)).toMatchObject({ state: 'ready' });
    expect(provider.created - before).toBe(1);
  });
});
