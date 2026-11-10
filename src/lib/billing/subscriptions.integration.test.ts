import { randomUUID } from 'node:crypto';
import { config } from 'dotenv';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { disconnectDatabases, getPrisma } from '@/lib/db/prisma';
import { withTenant, type TenantContext } from '@/lib/db/tenant';
import { getEntitlements } from './entitlements';
import { gstinCheckChar } from './gst';
import { financialYear } from './invoice-number';
import { saveDowngradeSelection } from './downgrade';
import { listInvoices } from './invoices';
import { upsertPlanPrices } from './prices';
import { saveBillingProfile } from './profile';
import type { BillingProvider, BillingSubscription, BillingWebhookEvent, ProviderResult, ProviderSubscriptionState } from './provider';
import { toSubscriptionStatus } from './provider';
import {
  BillingError,
  getBillingOverview,
  handleBillingEventJob,
  recordBillingEvent,
  requestCancel,
  requestPlanChange,
  resetBillingSweepScheduleForTests,
  runLifecycleSweep,
  scheduleBillingSweeps,
  startCheckout,
} from './subscriptions';
import { assertOutboundAllowed, WorkspaceSuspendedError } from './suspension';

const configured = config({ path: '.env.test', quiet: true }).parsed;
const ownerUrl = process.env.TEST_DATABASE_URL;
const appUrl = process.env.TEST_APP_DATABASE_URL || configured?.DATABASE_URL;
const workerUrl = process.env.TEST_WORKER_DATABASE_URL || configured?.WORKER_DATABASE_URL;
if (appUrl) process.env.DATABASE_URL = appUrl;
if (workerUrl) process.env.WORKER_DATABASE_URL = workerUrl;
Object.assign(process.env, {
  BILLING_RAZORPAY_KEY_ID: 'rzp_test_integration', BILLING_RAZORPAY_KEY_SECRET: 'test-only', BILLING_RAZORPAY_WEBHOOK_SECRET: 'test-only',
  BILLING_SELLER_STATE_CODE: '29',
});

const accountA = randomUUID(), accountB = randomUUID(), accountC = randomUUID();
const ownerA = randomUUID(), adminA = randomUUID(), agentA = randomUUID(), ownerB = randomUUID(), ownerC = randomUUID();
const tag = randomUUID().slice(0, 6);
const lo = `rlo_${tag}`, hi = `rhi_${tag}`;
const ppLo = `plan_RLo${tag}`, ppHi = `plan_RHi${tag}`;
const admin: TenantContext = { accountId: accountA, userId: adminA, role: 'admin' };
const agent: TenantContext = { accountId: accountA, userId: agentA, role: 'agent' };
// Far-future dates: invoice numbering here never meets real or other test invoices.
const T0 = new Date('2093-06-01T10:00:00Z');
const DAY = 86_400_000;
const at = (days: number) => new Date(T0.getTime() + days * DAY);
const fy = financialYear(T0);
const GSTIN = `29ABCDE1234F1Z${gstinCheckChar('29ABCDE1234F1Z')}`;
let owner: pg.Client;
let eventSeq = 0;

/** An in-memory provider: tests move its subscription between states, as Razorpay would. */
class FakeProvider implements BillingProvider {
  readonly name = 'razorpay' as const;
  subs = new Map<string, BillingSubscription>();
  calls: string[] = [];
  next: Partial<Record<'cancel' | 'change', 'unknown' | 'rejected'>> = {};
  set(id: string, state: ProviderSubscriptionState, extra: Partial<BillingSubscription> = {}) {
    const sub = { ...this.subs.get(id)!, state, status: toSubscriptionStatus(state), ...extra };
    this.subs.set(id, sub);
    return sub;
  }
  private outcome<T>(kind: 'cancel' | 'change', ok: () => T): ProviderResult<T> {
    const forced = this.next[kind];
    delete this.next[kind];
    if (forced === 'unknown') return { outcome: 'unknown' };
    if (forced === 'rejected') return { outcome: 'rejected', reason: 'invalid_request', httpStatus: 400 };
    return { outcome: 'ok', value: ok() };
  }
  async createCustomer() { this.calls.push('customer'); return { outcome: 'ok' as const, value: { id: 'cust_T1' } }; }
  async createSubscription(args: { planId: string; customerId: string; notes: Record<string, string> }) {
    this.calls.push('subscription');
    const id = `sub_T${tag}${this.subs.size}`;
    const sub: BillingSubscription = { id, planId: args.planId, customerId: args.customerId, state: 'created', status: 'incomplete',
      currentStart: null, currentEnd: null, startAt: null, endedAt: null, shortUrl: `https://rzp.io/i/${id}`, hasScheduledChanges: false, notes: args.notes };
    this.subs.set(id, sub);
    return { outcome: 'ok' as const, value: sub };
  }
  async cancelSubscription(args: { id: string; atPeriodEnd: boolean }) {
    this.calls.push(`cancel:${args.atPeriodEnd}`);
    return this.outcome('cancel', () => (args.atPeriodEnd ? this.set(args.id, 'active', { hasScheduledChanges: true }) : this.set(args.id, 'cancelled')));
  }
  async changePlan(args: { id: string; newPlanId: string; at: 'now' | 'period_end' }) {
    this.calls.push(`change:${args.at}`);
    return this.outcome('change', () => (args.at === 'now' ? this.set(args.id, 'active', { planId: args.newPlanId }) : this.set(args.id, 'active', { hasScheduledChanges: true })));
  }
  async createAddon() { return { outcome: 'unknown' as const }; }
  async findAddon() { return { outcome: 'unknown' as const }; }
  async fetchSubscription(id: string): Promise<ProviderResult<BillingSubscription>> {
    const sub = this.subs.get(id);
    return sub ? { outcome: 'ok', value: sub } : { outcome: 'rejected', reason: 'not_found', httpStatus: 404 };
  }
  async findSubscription(args: { intentId: string }) {
    return { outcome: 'ok' as const, value: [...this.subs.values()].find((s) => s.notes.intent_id === args.intentId) ?? null };
  }
  verifyWebhook() { return true; }
  parseWebhook() { return null; }
}

const provider = new FakeProvider();

/** Stores an event like the webhook route, then runs its job. */
async function deliver(type: string, sub: BillingSubscription, charge?: { paymentId: string; amountMinor: number; invoiceId?: string }, now = T0) {
  const event: BillingWebhookEvent = {
    type, subscriptionId: sub.id, state: sub.state, planId: sub.planId, paymentId: charge?.paymentId ?? null, invoiceId: charge?.invoiceId ?? null,
    amountMinor: charge?.amountMinor ?? null, currency: charge ? 'INR' : null, currentStart: sub.currentStart, currentEnd: sub.currentEnd, notes: sub.notes, createdAt: null,
  };
  const eventId = `evt_R${tag}_${++eventSeq}`;
  expect(await recordBillingEvent(eventId, event)).toBe(true);
  expect(await recordBillingEvent(eventId, event)).toBe(false);
  const row = (await owner.query('SELECT id FROM billing_events WHERE event_id=$1', [eventId])).rows[0];
  const job = (await owner.query("SELECT tenant_id FROM jobs WHERE dedupe_key=$1 AND type='billing.event'", [`billing-event:${row.id}`])).rows;
  expect(job).toEqual([{ tenant_id: null }]);
  await handleBillingEventJob({ eventId: row.id }, provider, now);
  // A rerun of the same job changes nothing.
  await handleBillingEventJob({ eventId: row.id }, provider, now);
  return (await owner.query('SELECT account_id, processed_at, error FROM billing_events WHERE id=$1', [row.id])).rows[0];
}

const subRow = async () => (await owner.query('SELECT * FROM account_subscriptions WHERE account_id=$1', [accountA])).rows[0];
const notices = async () => (await owner.query("SELECT DISTINCT dedupe_key FROM notifications WHERE account_id=$1 AND type='billing'", [accountA])).rows.map((r) => r.dedupe_key.split(':')[1]);

describe.skipIf(!ownerUrl || !appUrl || !workerUrl)('subscription lifecycle on PostgreSQL', { timeout: 120_000 }, () => {
  let subId = '';

  beforeAll(async () => {
    owner = new pg.Client({ connectionString: ownerUrl });
    await owner.connect();
    if (!/test/i.test((await owner.query('SELECT current_database() AS name')).rows[0].name)) throw new Error('Requires an isolated test database');
    const app = await getPrisma().$queryRaw<{ role: string }[]>`SELECT current_user AS role`;
    if (app[0].role !== 'bodhinox_app') throw new Error('Requires constrained test app credentials');
    await owner.query("INSERT INTO auth_users(id,email,full_name,password_hash) SELECT x, x::text || '@example.invalid', 'Billing R', 'test-only-hash' FROM unnest($1::uuid[]) x", [[ownerA, adminA, agentA, ownerB]]);
    await owner.query("INSERT INTO accounts(id,name,owner_user_id) VALUES($1,'Billing R A',$2),($3,'Billing R B',$4)", [accountA, ownerA, accountB, ownerB]);
    await owner.query("INSERT INTO account_memberships(account_id,user_id,role) VALUES($1,$2,'owner'),($1,$3,'admin'),($1,$4,'agent'),($5,$6,'owner')", [accountA, ownerA, adminA, agentA, accountB, ownerB]);
    await owner.query(`INSERT INTO plans(id,name,sort,features,limits) VALUES($1,'Low',901,'{}','{}'),($2,'High',902,'{}','{}')`, [lo, hi]);
    await owner.query(`INSERT INTO plan_prices(plan,"interval",amount_minor,provider_plan_id) VALUES($1,'month',118000,$3),($2,'month',236000,$4)`, [lo, hi, ppLo, ppHi]);
  });

  afterAll(async () => {
    if (owner) {
      // The sweep schedule also queued jobs for other test workspaces; billing jobs exist only in tests here.
      await owner.query("DELETE FROM jobs WHERE type IN ('billing.email','billing.lifecycle_sweep','billing.event')");
      await owner.query('DELETE FROM billing_events WHERE event_id LIKE $1', [`evt_R${tag}_%`]);
      await owner.query('DELETE FROM accounts WHERE id = ANY($1::uuid[])', [[accountA, accountB, accountC]]);
      await owner.query('DELETE FROM auth_users WHERE id = ANY($1::uuid[])', [[ownerA, adminA, agentA, ownerB, ownerC]]);
      await owner.query('DELETE FROM plan_prices WHERE plan = ANY($1)', [[lo, hi]]);
      await owner.query('DELETE FROM plans WHERE id = ANY($1)', [[lo, hi]]);
      await owner.query('DELETE FROM invoice_sequences WHERE financial_year=$1', [fy]);
      await owner.end();
    }
    await disconnectDatabases();
  });

  it('needs a billing profile, then checks out idempotently without touching the plan until authorised', async () => {
    await expect(startCheckout({ accountId: accountA, userId: adminA, plan: lo, interval: 'month' }, provider)).rejects.toMatchObject({ billingCode: 'profile_required' });
    await withTenant(admin, (tx) => saveBillingProfile(tx, accountA, { legalName: 'Acme R', gstin: GSTIN, addressLine1: '1 MG Road', addressLine2: null,
      city: 'Bengaluru', stateCode: '29', postalCode: '560001', country: 'IN', email: 'billing@acme.example' }));
    const first = await startCheckout({ accountId: accountA, userId: adminA, plan: lo, interval: 'month' }, provider);
    const again = await startCheckout({ accountId: accountA, userId: adminA, plan: lo, interval: 'month' }, provider);
    expect(first).toMatchObject({ state: 'ready', keyId: 'rzp_test_integration', prefill: { name: 'Acme R', email: 'billing@acme.example' } });
    expect(again).toEqual(first);
    expect(provider.calls.filter((c) => c === 'subscription')).toHaveLength(1);
    subId = (first as { subscriptionId: string }).subscriptionId;
    // Still unrestricted: no subscription row while the checkout is unpaid.
    expect(await subRow()).toBeUndefined();
    expect((await withTenant(agent, (tx) => getEntitlements(tx, accountA))).planId).toBe('enterprise');
    // Admins see the open checkout; agents see nothing of it.
    expect((await withTenant(admin, (tx) => getBillingOverview(tx, accountA, true))).pending).toEqual([{ kind: 'checkout', status: 'created', plan: lo, interval: 'month' }]);
    expect(await withTenant(agent, (tx) => tx.$queryRaw<unknown[]>`SELECT 1 FROM billing_intents`)).toHaveLength(0);
    await expect(withTenant(admin, (tx) => tx.$executeRaw`INSERT INTO billing_intents(kind) VALUES('cancel')`)).rejects.toThrow(/permission denied/);
  });

  it('activates from the verified webhook and issues one GST invoice per charge', async () => {
    // An unmatched workspace hint is ignored.
    const stray = provider.set(subId, 'created');
    const bogus = await deliver('subscription.activated', { ...stray, id: `sub_Stray${tag}`, notes: { account_id: accountB, intent_id: stray.notes.intent_id } });
    expect(bogus.error).toBe('No workspace matches this subscription');

    const sub = provider.set(subId, 'active', { currentStart: T0, currentEnd: at(30) });
    const processed = await deliver('subscription.charged', sub, { paymentId: `pay_R${tag}1`, invoiceId: `inv_R${tag}1`, amountMinor: 118000 });
    expect(processed).toMatchObject({ account_id: accountA, error: null });
    expect(await subRow()).toMatchObject({ plan_id: lo, status: 'active', provider_subscription_id: subId, provider_customer_id: 'cust_T1', interval: 'month' });
    const invoices = await withTenant(admin, (tx) => listInvoices(tx, accountA));
    expect(invoices).toHaveLength(1);
    const inv = (await owner.query('SELECT * FROM invoices WHERE account_id=$1', [accountA])).rows[0];
    expect(inv).toMatchObject({ subtotal_minor: '100000', cgst_minor: '9000', sgst_minor: '9000', igst_minor: '0', total_minor: '118000',
      status: 'paid', place_of_supply_state_code: '29', gstin_snapshot: GSTIN });
    expect(inv.number).toMatch(new RegExp(`^BX/${fy}/\\d{6}$`));
    // The same charge again (invoice.paid for the same payment) issues nothing new.
    await deliver('invoice.paid', sub, { paymentId: `pay_R${tag}1`, amountMinor: 118000 });
    expect(await withTenant(admin, (tx) => listInvoices(tx, accountA))).toHaveLength(1);
    expect(await notices()).toEqual(expect.arrayContaining(['activated', 'invoice_issued']));
    // Owner and admin are notified; the agent is not; an email job is queued once per notice.
    const recipients = (await owner.query("SELECT DISTINCT user_id FROM notifications WHERE account_id=$1 AND type='billing'", [accountA])).rows.map((r) => r.user_id).sort();
    expect(recipients).toEqual([ownerA, adminA].sort());
    expect((await owner.query("SELECT count(*)::int AS n FROM jobs WHERE type='billing.email' AND tenant_id=$1", [accountA])).rows[0].n).toBe(2);
    // Another workspace never sees these invoices.
    expect(await withTenant({ accountId: accountB, userId: ownerB, role: 'owner' }, (tx) => listInvoices(tx, accountA))).toHaveLength(0);
  });

  it('goes past_due -> grace -> suspended, blocks automatic sends, then recovers on payment', async () => {
    await deliver('subscription.pending', provider.set(subId, 'pending'), undefined, at(30));
    expect((await subRow()).status).toBe('past_due');
    await deliver('subscription.halted', provider.set(subId, 'halted'), undefined, at(33));
    const grace = await subRow();
    expect(grace.status).toBe('grace');
    expect(new Date(grace.grace_ends_at).getTime()).toBe(at(40).getTime());
    await assertOutboundAllowed(accountA);

    await runLifecycleSweep(accountA, provider, at(39));
    expect((await subRow()).status).toBe('grace');
    await runLifecycleSweep(accountA, provider, at(41));
    expect((await subRow()).status).toBe('suspended');
    await expect(assertOutboundAllowed(accountA)).rejects.toBeInstanceOf(WorkspaceSuspendedError);
    expect((await withTenant(agent, (tx) => getEntitlements(tx, accountA))).planId).toBe('free');
    expect(await notices()).toEqual(expect.arrayContaining(['payment_failed', 'grace_started', 'grace_ending', 'suspended']));
    // Changing the plan is refused until the workspace pays.
    await expect(requestPlanChange({ accountId: accountA, userId: adminA, plan: hi, interval: 'month' }, provider, at(41))).rejects.toBeInstanceOf(BillingError);

    const paid = provider.set(subId, 'active', { currentStart: at(42), currentEnd: at(72) });
    await deliver('subscription.charged', paid, { paymentId: `pay_R${tag}2`, amountMinor: 118000 }, at(42));
    expect(await subRow()).toMatchObject({ status: 'active', grace_ends_at: null, suspended_at: null, plan_id: lo });
    await assertOutboundAllowed(accountA);
    expect(await withTenant(admin, (tx) => listInvoices(tx, accountA))).toHaveLength(2);
    expect(await notices()).toContain('recovered');
  });

  it('upgrades now and downgrades at the end of the period', async () => {
    expect(await requestPlanChange({ accountId: accountA, userId: adminA, plan: hi, interval: 'month' }, provider, at(43))).toEqual({ state: 'done' });
    expect((await subRow()).plan_id).toBe(hi);
    expect(provider.calls).toContain('change:now');

    expect(await requestPlanChange({ accountId: accountA, userId: adminA, plan: lo, interval: 'month' }, provider, at(44))).toEqual({ state: 'scheduled' });
    expect(await subRow()).toMatchObject({ plan_id: hi, scheduled_plan: lo });
    // Renewal: the provider now bills the lower plan.
    const renewed = provider.set(subId, 'active', { planId: ppLo, currentStart: at(72), currentEnd: at(102), hasScheduledChanges: false });
    await deliver('subscription.charged', renewed, { paymentId: `pay_R${tag}3`, amountMinor: 118000 }, at(72));
    expect(await subRow()).toMatchObject({ plan_id: lo, scheduled_plan: null });
  });

  it('reconciles a lost cancel answer from the provider state, then ends at period end', async () => {
    provider.next.cancel = 'unknown';
    expect(await requestCancel({ accountId: accountA, userId: adminA }, provider, at(80))).toEqual({ state: 'pending' });
    expect((await subRow()).cancel_at_period_end).toBe(false);
    // While unconfirmed, no plan change may start.
    await expect(requestPlanChange({ accountId: accountA, userId: adminA, plan: hi, interval: 'month' }, provider, at(80))).rejects.toMatchObject({ billingCode: 'change_pending' });
    // The provider did schedule it; the sweep finds that out.
    provider.set(subId, 'active', { hasScheduledChanges: true });
    resetBillingSweepScheduleForTests();
    expect(await scheduleBillingSweeps()).toBeGreaterThan(0);
    expect((await owner.query("SELECT count(*)::int AS n FROM jobs WHERE type='billing.lifecycle_sweep' AND tenant_id=$1", [accountA])).rows[0].n).toBe(1);
    await runLifecycleSweep(accountA, provider, at(81));
    expect((await subRow()).cancel_at_period_end).toBe(true);
    expect((await owner.query("SELECT status FROM billing_intents WHERE account_id=$1 AND kind='cancel'", [accountA])).rows).toEqual([{ status: 'completed' }]);

    await deliver('subscription.cancelled', provider.set(subId, 'cancelled'), undefined, at(102));
    expect(await subRow()).toMatchObject({ status: 'cancelled', cancel_at_period_end: false });
    expect((await withTenant(agent, (tx) => getEntitlements(tx, accountA))).planId).toBe('free');
    // Nothing was deleted along the way: every invoice from the paid charges remains.
    expect((await owner.query('SELECT count(*)::int AS n FROM invoices WHERE account_id=$1', [accountA])).rows[0].n).toBe(3);
  });

  it('cancels a superseded checkout authorised later instead of switching to it, and notifies admins', async () => {
    const replaced = await startCheckout({ accountId: accountA, userId: adminA, plan: lo, interval: 'month' }, provider, at(103));
    const current = await startCheckout({ accountId: accountA, userId: adminA, plan: hi, interval: 'month' }, provider, at(103));
    const oldId = (replaced as { subscriptionId: string }).subscriptionId, newId = (current as { subscriptionId: string }).subscriptionId;
    expect(oldId).not.toBe(newId);
    // The buyer pays the older link anyway.
    const stray = await deliver('subscription.authenticated', provider.set(oldId, 'authenticated'), undefined, at(104));
    expect(stray).toMatchObject({ account_id: accountA, error: 'Superseded checkout: cancelled at the provider' });
    expect(await subRow()).toMatchObject({ status: 'cancelled', provider_subscription_id: subId });
    expect(provider.subs.get(oldId)?.state).toBe('cancelled');
    expect(provider.calls).toContain('cancel:false');
    expect(await notices()).toContain('checkout_superseded');
    const audit = (await owner.query("SELECT action, metadata FROM audit_logs WHERE account_id=$1 AND resource_id=$2 ORDER BY created_at", [accountA, oldId])).rows;
    expect(audit.map((r) => r.action)).toEqual(expect.arrayContaining(['billing.checkout_superseded', 'billing.stray_subscription_cancel']));
    expect(audit.find((r) => r.action === 'billing.stray_subscription_cancel')?.metadata).toEqual({ outcome: 'cancelled' });
    expect((await owner.query("SELECT status FROM billing_intents WHERE account_id=$1 AND provider_subscription_id=$2", [accountA, oldId])).rows).toEqual([{ status: 'superseded' }]);
    // A paid charge on that stray is cancelled too, and never silent: it opens a charge_unapplied item.
    // (The provider still reports it active when the charge event is handled, so the stray branch runs.)
    const strayCharge = await deliver('subscription.charged', provider.set(oldId, 'active'), { paymentId: `pay_S${tag}`, amountMinor: 118000 }, at(104));
    expect(provider.subs.get(oldId)?.state).toBe('cancelled');
    expect(strayCharge).toMatchObject({ account_id: accountA, error: expect.stringMatching(/^Superseded checkout: cancelled at the provider, but a paid charge/) });
    const items = (await owner.query("SELECT kind, detail->>'reason' AS reason FROM billing_reconciliation_items WHERE account_id=$1 AND detail->>'subscription_id'=$2",
      [accountA, oldId])).rows;
    expect(items).toEqual(expect.arrayContaining([{ kind: 'event_error', reason: 'charge_unapplied' }]));
    // Razorpay also sends invoice.paid for the same charge: still exactly one item for that money,
    // keyed by the payment and carrying its ids and amount.
    await deliver('invoice.paid', provider.set(oldId, 'active'), { paymentId: `pay_S${tag}`, invoiceId: `inv_S${tag}`, amountMinor: 118000 }, at(104));
    const chargeItems = (await owner.query(`SELECT source_ref, detail->>'payment_id' AS payment_id, (detail->>'amount_minor')::int AS amount_minor
      FROM billing_reconciliation_items WHERE kind='event_error' AND detail->>'reason'='charge_unapplied' AND detail->>'payment_id'=$1`, [`pay_S${tag}`])).rows;
    expect(chargeItems).toEqual([{ source_ref: `charge:pay_S${tag}`, payment_id: `pay_S${tag}`, amount_minor: 118000 }]);
    expect((await owner.query('SELECT count(*)::int AS n FROM invoices WHERE account_id=$1 AND provider_payment_id=$2', [accountA, `pay_S${tag}`])).rows[0].n).toBe(0);
    // Its cancellation event changes nothing either.
    expect(await deliver('subscription.cancelled', provider.subs.get(oldId)!, undefined, at(104))).toMatchObject({ error: null });
    expect((await subRow()).provider_subscription_id).toBe(subId);

    // The current checkout still becomes the subscription.
    await deliver('subscription.activated', provider.set(newId, 'active', { currentStart: at(104), currentEnd: at(134) }), undefined, at(104));
    expect(await subRow()).toMatchObject({ status: 'active', plan_id: hi, provider_subscription_id: newId });
    // A second subscription beside a live one is stray too, even for an open intent.
    const second = await provider.createSubscription({ planId: ppLo, customerId: 'cust_T1', notes: { account_id: accountA, intent_id: randomUUID() } });
    await owner.query("INSERT INTO billing_intents(account_id,kind,plan,\"interval\",status,provider_subscription_id) VALUES($1,'checkout',$2,'month','created',$3)",
      [accountA, lo, second.value.id]);
    const intentId = (await owner.query('SELECT id FROM billing_intents WHERE provider_subscription_id=$1', [second.value.id])).rows[0].id;
    provider.set(second.value.id, 'active', { notes: { account_id: accountA, intent_id: intentId } });
    expect(await deliver('subscription.activated', provider.subs.get(second.value.id)!, undefined, at(105))).toMatchObject({ error: expect.stringMatching(/^Superseded checkout/) });
    expect(await subRow()).toMatchObject({ plan_id: hi, provider_subscription_id: newId });
    expect(provider.subs.get(second.value.id)?.state).toBe('cancelled');
  });

  it('moves to past_due on a payment.failed that names its subscription, like subscription.pending', async () => {
    const live = (await subRow()).provider_subscription_id as string;
    await deliver('payment.failed', provider.set(live, 'pending'), undefined, at(110));
    expect((await subRow()).status).toBe('past_due');
    expect(await notices()).toContain('payment_failed');
  });

  it('archives (never deletes) what exceeds a scheduled downgrade when the renewal applies it, and restores on upgrade', async () => {
    const segs = [randomUUID(), randomUUID(), randomUUID()];
    for (const [i, id] of segs.entries())
      await owner.query(`INSERT INTO segments(id,account_id,user_id,name,filter) VALUES($1,$2,$3,$4,'{"conditions":[]}')`, [id, accountB, ownerB, `Seg R ${i}`]);
    await owner.query(`UPDATE plans SET limits='{"segments":1}' WHERE id=$1`, [lo]);
    const subB = `sub_B${tag}`;
    provider.subs.set(subB, { id: subB, planId: ppHi, customerId: 'cust_B', state: 'active', status: 'active', currentStart: at(100), currentEnd: at(130),
      startAt: null, endedAt: null, shortUrl: null, hasScheduledChanges: true, notes: {} });
    await owner.query(`INSERT INTO account_subscriptions(account_id,plan_id,status,provider,provider_subscription_id,"interval",current_period_start,current_period_end,scheduled_plan)
      VALUES($1,$2,'active','razorpay',$3,'month',$4,$5,$6)`, [accountB, hi, subB, at(100), at(130), lo]);
    const ownerCtx: TenantContext = { accountId: accountB, userId: ownerB, role: 'owner' };
    // The admin's choice is stored now and used when the plan starts.
    expect(await withTenant(ownerCtx, (tx) => saveDowngradeSelection(tx, accountB, ownerB, lo, { segments: [segs[2]] }))).toEqual({ applied: false });
    const live = async () => (await owner.query('SELECT id FROM segments WHERE account_id=$1 AND archived_at IS NULL ORDER BY id', [accountB])).rows.map((r) => r.id);
    expect(await live()).toHaveLength(3);

    await deliver('subscription.updated', provider.set(subB, 'active', { planId: ppLo, currentStart: at(130), currentEnd: at(160), hasScheduledChanges: false }), undefined, at(130));
    const subRowB = (await owner.query('SELECT plan_id, scheduled_plan FROM account_subscriptions WHERE account_id=$1', [accountB])).rows[0];
    expect(subRowB).toEqual({ plan_id: lo, scheduled_plan: null });
    expect(await live()).toEqual([segs[2]]);
    expect((await owner.query('SELECT count(*)::int AS n FROM segments WHERE account_id=$1', [accountB])).rows[0].n).toBe(3);
    expect((await owner.query('SELECT item_id FROM plan_archives WHERE account_id=$1 AND restored_at IS NULL ORDER BY item_id', [accountB])).rows.map((r) => r.item_id))
      .toEqual([segs[0], segs[1]].sort());
    expect((await owner.query('SELECT applied_at IS NOT NULL AS applied FROM downgrade_selections WHERE account_id=$1', [accountB])).rows).toEqual([{ applied: true }]);

    // Upgrading again brings the archived segments back.
    await deliver('subscription.updated', provider.set(subB, 'active', { planId: ppHi }), undefined, at(131));
    expect(await live()).toEqual([...segs].sort());
  });

  it('keeps a checkout started before a price change, and applies a charge whose invoice cannot be issued', async () => {
    await owner.query("INSERT INTO auth_users(id,email,full_name,password_hash) VALUES($1,$2,'Billing R C','test-only-hash')", [ownerC, `${ownerC}@example.invalid`]);
    await owner.query("INSERT INTO accounts(id,name,owner_user_id) VALUES($1,'Billing R C',$2)", [accountC, ownerC]);
    await owner.query("INSERT INTO account_memberships(account_id,user_id,role) VALUES($1,$2,'owner')", [accountC, ownerC]);
    const ownerCtx: TenantContext = { accountId: accountC, userId: ownerC, role: 'owner' };
    await withTenant(ownerCtx, (tx) => saveBillingProfile(tx, accountC, { legalName: 'Acme C', gstin: null, addressLine1: '2 MG Road', addressLine2: null,
      city: 'Mumbai', stateCode: '27', postalCode: '400001', country: 'IN', email: 'billing@c.example' }));
    const checkout = await startCheckout({ accountId: accountC, userId: ownerC, plan: lo, interval: 'month' }, provider);
    const cSub = (checkout as { subscriptionId: string }).subscriptionId;
    expect(provider.subs.get(cSub)!.planId).toBe(ppLo);
    expect((await owner.query('SELECT provider_plan_id FROM billing_intents WHERE account_id=$1', [accountC])).rows).toEqual([{ provider_plan_id: ppLo }]);

    // The platform admin moves Low to a new provider plan before the buyer authorises the old link.
    await upsertPlanPrices([{ plan: lo, interval: 'month', currency: 'INR', amountMinor: 129_800, provider: 'razorpay', providerPlanId: `${ppLo}n`, active: true }]);
    // The charge arrives while the seller's GST state is missing: the state still applies; the invoice is left for reconciliation.
    delete process.env.BILLING_SELLER_STATE_CODE;
    try {
      const calls = provider.calls.length;
      const sub = provider.set(cSub, 'active', { currentStart: at(200), currentEnd: at(230) });
      const processed = await deliver('subscription.charged', sub, { paymentId: `pay_C${tag}`, amountMinor: 118000 }, at(200));
      expect(processed.account_id).toBe(accountC);
      expect(processed.error).toMatch(/^Invoice not issued \(InvoiceConfigError\)/);
      // Not treated as stray: never cancelled at the provider, and the workspace is on the plan it paid for.
      expect(provider.calls.slice(calls)).toEqual([]);
      expect((await owner.query('SELECT plan_id, status, provider_subscription_id FROM account_subscriptions WHERE account_id=$1', [accountC])).rows[0])
        .toEqual({ plan_id: lo, status: 'active', provider_subscription_id: cSub });
      expect((await owner.query('SELECT count(*)::int AS n FROM invoices WHERE account_id=$1', [accountC])).rows[0].n).toBe(0);
      const audit = (await owner.query("SELECT resource_id, metadata FROM audit_logs WHERE account_id=$1 AND action='billing.invoice_unissued'", [accountC])).rows;
      expect(audit).toEqual([{ resource_id: `pay_C${tag}`, metadata: expect.objectContaining({ reason: 'InvoiceConfigError', amount_minor: 118000 }) }]);
      // New checkouts are refused until the seller state is set: no charge may go uninvoiced by design.
      await expect(startCheckout({ accountId: accountC, userId: ownerC, plan: hi, interval: 'month' }, provider)).rejects.toMatchObject({ billingCode: 'not_configured' });
    } finally {
      process.env.BILLING_SELLER_STATE_CODE = '29';
    }
  });
});
