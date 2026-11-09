// Phase 14 T3 on a real PostgreSQL: plan versions pinned on apply (a new plan
// or subscription is pinned to the current version, a renewal keeps its pin),
// the downgrade archive evaluated against the pinned terms, "move subscribers"
// from the console, the preview-hash check, and SaaS billing reconciliation:
// every producer opens one item per source, the daily reconcile only reads
// (never writes the subscription or an intent), and resolving changes nothing
// but the item. Runs only against an isolated *test* database.
import { randomUUID } from 'node:crypto';
import { config } from 'dotenv';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { disconnectDatabases, getWorkerPrisma } from '@/lib/db/prisma';
import { withTenant } from '@/lib/db/tenant';
import { platformPlanPreview, PlatformDbError } from '@/lib/platform/db';
import { resolveReconciliation } from '@/lib/platform/billing';
import { moveSubscribers, previewPlan, publishPlan } from '@/lib/platform/plans';
import { getEntitlements } from './entitlements';
import type { BillingProvider, BillingSubscription, BillingWebhookEvent, ProviderResult, ProviderSubscriptionState } from './provider';
import { toSubscriptionStatus } from './provider';
import { resetBillingReconcileScheduleForTests, runBillingReconcile, scheduleBillingReconcile } from './reconciliation';
import { handleBillingEventJob, recordBillingEvent, runLifecycleSweep, writeSubscription } from './subscriptions';

const configured = config({ path: '.env.test', quiet: true }).parsed;
const ownerUrl = process.env.TEST_DATABASE_URL;
const appUrl = process.env.TEST_APP_DATABASE_URL || configured?.DATABASE_URL;
const workerUrl = process.env.TEST_WORKER_DATABASE_URL || configured?.WORKER_DATABASE_URL;
const platformUrl = process.env.TEST_PLATFORM_DATABASE_URL || configured?.PLATFORM_DATABASE_URL;
if (appUrl) process.env.DATABASE_URL = appUrl;
if (workerUrl) process.env.WORKER_DATABASE_URL = workerUrl;
if (platformUrl) process.env.PLATFORM_DATABASE_URL = platformUrl;
const BILLING_ENV = {
  BILLING_RAZORPAY_KEY_ID: 'rzp_test_t3recon', BILLING_RAZORPAY_KEY_SECRET: 'test-only', BILLING_RAZORPAY_WEBHOOK_SECRET: 'test-only',
  BILLING_SELLER_STATE_CODE: '29',
};
Object.assign(process.env, BILLING_ENV);

const tag = randomUUID().slice(0, 6);
const lo = `t3lo_${tag}`, hi = `t3hi_${tag}`;
const ppLo = `plan_T3Lo${tag}`, ppHi = `plan_T3Hi${tag}`;
const accountA = randomUUID(), accountB = randomUUID(), ownerA = randomUUID(), ownerB = randomUUID();
const subA = `sub_T3A${tag}`, subB = `sub_T3B${tag}`;
const admin = { userId: randomUUID(), sessionId: randomUUID(), email: 'ops-t3@bodhinox.test' };
const T0 = new Date('2094-02-01T06:00:00Z');
const DAY = 86_400_000;
const at = (days: number) => new Date(T0.getTime() + days * DAY);
let owner: pg.Client;
let seq = 0;

class FakeProvider implements BillingProvider {
  readonly name = 'razorpay' as const;
  subs = new Map<string, BillingSubscription>();
  fetches = 0;
  put(id: string, planId: string, state: ProviderSubscriptionState, start: Date, end: Date) {
    const sub: BillingSubscription = { id, planId, customerId: 'cust_T3', state, status: toSubscriptionStatus(state), currentStart: start,
      currentEnd: end, startAt: null, endedAt: null, shortUrl: null, hasScheduledChanges: false, notes: {} };
    this.subs.set(id, sub);
    return sub;
  }
  async createCustomer() { return { outcome: 'unknown' as const }; }
  async createSubscription() { return { outcome: 'unknown' as const }; }
  async cancelSubscription() { return { outcome: 'unknown' as const }; }
  async changePlan() { return { outcome: 'unknown' as const }; }
  async createAddon() { return { outcome: 'unknown' as const }; }
  async findAddon() { return { outcome: 'unknown' as const }; }
  async fetchSubscription(id: string): Promise<ProviderResult<BillingSubscription>> {
    this.fetches += 1;
    const sub = this.subs.get(id);
    return sub ? { outcome: 'ok', value: sub } : { outcome: 'rejected', reason: 'not_found', httpStatus: 404 };
  }
  async findSubscription() { return { outcome: 'ok' as const, value: null }; }
  verifyWebhook() { return true; }
  parseWebhook() { return null; }
}
const provider = new FakeProvider();

async function deliver(type: string, sub: BillingSubscription | { id: string }, charge?: { paymentId: string; amountMinor: number; currency: string }, now = T0) {
  const full = 'planId' in sub ? sub : null;
  const event: BillingWebhookEvent = {
    type, subscriptionId: sub.id, state: full?.state ?? null, planId: full?.planId ?? null, paymentId: charge?.paymentId ?? null, invoiceId: null,
    amountMinor: charge?.amountMinor ?? null, currency: charge?.currency ?? null, currentStart: full?.currentStart ?? null,
    currentEnd: full?.currentEnd ?? null, notes: {}, createdAt: null,
  };
  const eventId = `evt_T3${tag}_${++seq}`;
  expect(await recordBillingEvent(eventId, event)).toBe(true);
  const row = (await owner.query('SELECT id FROM billing_events WHERE event_id=$1', [eventId])).rows[0];
  await handleBillingEventJob({ eventId: row.id }, provider, now);
  return row.id as string;
}

const sub = async (account: string) => (await owner.query(
  `SELECT s.plan_id, s.status, s.current_period_end, s.plan_version_id, v.version FROM account_subscriptions s
   LEFT JOIN plan_versions v ON v.id = s.plan_version_id WHERE s.account_id=$1`, [account])).rows[0];
const versionId = async (plan: string, version: number) =>
  (await owner.query('SELECT id FROM plan_versions WHERE plan_id=$1 AND version=$2', [plan, version])).rows[0].id as string;
const liveSegments = async (account: string) =>
  Number((await owner.query('SELECT count(*) AS n FROM segments WHERE account_id=$1 AND archived_at IS NULL', [account])).rows[0].n);
const items = async (account: string | null, kind: string) => (await owner.query(
  'SELECT * FROM billing_reconciliation_items WHERE kind=$1 AND account_id IS NOT DISTINCT FROM $2 ORDER BY opened_at', [kind, account])).rows;
const limitsOf = async (account: string) => withTenant({ accountId: account }, (tx) => getEntitlements(tx, account), getWorkerPrisma());

describe.skipIf(!ownerUrl || !appUrl || !workerUrl || !platformUrl)('plan pinning and billing reconciliation on PostgreSQL', { timeout: 120_000 }, () => {
  beforeAll(async () => {
    owner = new pg.Client({ connectionString: ownerUrl });
    await owner.connect();
    if (!/test/i.test((await owner.query('SELECT current_database() AS name')).rows[0].name)) throw new Error('Requires an isolated test database');
    await owner.query("INSERT INTO auth_users(id,email,full_name,password_hash) SELECT x, x::text || '@example.invalid', 'T3', 'test-only-hash' FROM unnest($1::uuid[]) x",
      [[ownerA, ownerB]]);
    await owner.query("INSERT INTO accounts(id,name,owner_user_id) VALUES($1,'T3 A',$2),($3,'T3 B',$4)", [accountA, ownerA, accountB, ownerB]);
    await owner.query("INSERT INTO account_memberships(account_id,user_id,role) VALUES($1,$2,'owner'),($3,$4,'owner')", [accountA, ownerA, accountB, ownerB]);
    await owner.query(`INSERT INTO plans(id,name,sort,features,limits) VALUES($1,'T3 Low',911,'{}','{"segments":2}'),($2,'T3 High',912,'{}','{}')`, [lo, hi]);
    await owner.query('INSERT INTO plan_versions(plan_id,version,features,limits) SELECT id,1,features,limits FROM plans WHERE id = ANY($1::text[])', [[lo, hi]]);
    await owner.query(`INSERT INTO plan_prices(plan,"interval",amount_minor,provider_plan_id) VALUES($1,'month',118000,$3),($2,'month',236000,$4)`, [lo, hi, ppLo, ppHi]);
    // A on High (pinned v1), B on Low (pinned v1); both with a live provider subscription.
    for (const [account, plan, subId] of [[accountA, hi, subA], [accountB, lo, subB]] as const) {
      await withTenant({ accountId: account, role: 'owner' }, (tx) => writeSubscription(tx, account, {
        planId: plan, status: 'active', interval: 'month', provider: 'razorpay', providerCustomerId: 'cust_T3', providerSubscriptionId: subId,
        trialEndsAt: null, currentPeriodStart: at(-30), currentPeriodEnd: at(0), cancelAtPeriodEnd: false, scheduledPlan: null, graceEndsAt: null, suspendedAt: null,
      }), getWorkerPrisma());
      await owner.query('UPDATE account_subscriptions SET plan_version_id=$2 WHERE account_id=$1', [account, await versionId(plan, 1)]);
    }
    for (const [account, user] of [[accountA, ownerA], [accountA, ownerA], [accountA, ownerA], [accountB, ownerB], [accountB, ownerB]])
      await owner.query(`INSERT INTO segments(account_id,user_id,name,filter) VALUES($1,$2,$3,'{"conditions":[{"field":"opted_out","op":"is","value":false}]}')`,
        [account, user, `T3 seg ${randomUUID().slice(0, 4)}`]);
  });

  afterAll(async () => {
    if (owner) {
      await owner.query('DELETE FROM jobs WHERE tenant_id = ANY($1::uuid[])', [[accountA, accountB]]);
      await owner.query(`DELETE FROM billing_reconciliation_items WHERE account_id = ANY($1::uuid[]) OR source_ref LIKE $2
        OR source_ref IN (SELECT id::text FROM billing_events WHERE event_id LIKE $3)`, [[accountA, accountB], `%${tag}%`, `evt_T3${tag}%`]);
      await owner.query("DELETE FROM jobs WHERE type='billing.reconcile' AND dedupe_key LIKE $1", [`%:${new Date(at(3).getTime() + 330 * 60_000).toISOString().slice(0, 10)}`]);
      await owner.query("DELETE FROM billing_events WHERE event_id LIKE $1", [`evt_T3${tag}%`]);
      await owner.query('DELETE FROM accounts WHERE id = ANY($1::uuid[])', [[accountA, accountB]]);
      await owner.query('DELETE FROM auth_users WHERE id = ANY($1::uuid[])', [[ownerA, ownerB]]);
      await owner.query('DELETE FROM plan_prices WHERE plan = ANY($1::text[])', [[lo, hi]]);
      await owner.query('DELETE FROM plan_versions WHERE plan_id = ANY($1::text[])', [[lo, hi]]);
      await owner.query('DELETE FROM plans WHERE id = ANY($1::text[])', [[lo, hi]]);
      await owner.end();
    }
    await disconnectDatabases();
  });

  it('publishes Low v2 only with the hash of a preview of the same draft against the same version', async () => {
    const draft = { features: {}, limits: { segments: 1 } };
    const preview = await previewPlan(lo, draft);
    expect(preview).toMatchObject({ plan: lo, current_version: 1, affected_workspaces: 0 });
    // B is pinned, so it is not in the live-row audience.
    expect(preview.tightened).toEqual([{ key: 'segments', current: 2, next: 1, over: 0 }]);
    await expect(publishPlan(admin, lo, { ...draft, limits: { segments: 0 }, previewHash: preview.preview_hash }))
      .rejects.toMatchObject({ code: 'preview_mismatch', status: 409 });
    expect(await publishPlan(admin, lo, { ...draft, note: 'Low allows one segment', previewHash: preview.preview_hash })).toEqual({ version: 2 });
    // The same preview again is stale now (the current version moved on).
    await expect(publishPlan(admin, lo, { ...draft, previewHash: preview.preview_hash })).rejects.toBeInstanceOf(PlatformDbError);
    // B stays on v1 terms.
    expect((await limitsOf(accountB)).limits.segments).toBe(2);
    expect((await sub(accountB)).version).toBe(1);
    const audit = await owner.query("SELECT detail FROM platform_audit_log WHERE action='plan.publish' AND target_ref=$1", [`${lo}:v2`]);
    expect(audit.rows[0].detail).toMatchObject({ plan: lo, version: 2, previous_version: 1 });
  });

  it('a renewal of the same subscription keeps its pin', async () => {
    const renewed = provider.put(subB, ppLo, 'active', at(0), at(30));
    await deliver('subscription.charged', renewed, { paymentId: `pay_T3B${tag}`, amountMinor: 118000, currency: 'INR' });
    const row = await sub(accountB);
    expect(row.current_period_end.toISOString()).toBe(at(30).toISOString());
    expect(row.version).toBe(1);
    expect(await liveSegments(accountB)).toBe(2);
  });

  it('a plan change pins the new plan\'s current version and archives (never deletes) against those terms', async () => {
    provider.put(subA, ppLo, 'active', at(0), at(30));
    await deliver('subscription.updated', provider.subs.get(subA)!);
    const row = await sub(accountA);
    expect(row).toMatchObject({ plan_id: lo, status: 'active', plan_version_id: await versionId(lo, 2), version: 2 });
    expect((await limitsOf(accountA)).limits.segments).toBe(1);
    expect(await liveSegments(accountA)).toBe(1);
    expect(Number((await owner.query('SELECT count(*) AS n FROM segments WHERE account_id=$1', [accountA])).rows[0].n)).toBe(3);
  });

  it('moving subscribers to the latest version is explicit, names the version, and archives what no longer fits', async () => {
    await expect(moveSubscribers(admin, lo, { reason: 'Align Low subscribers with v2', version: 1 })).rejects.toMatchObject({ code: 'stale_version' });
    expect((await sub(accountB)).version).toBe(1);
    const result = await moveSubscribers(admin, lo, { reason: 'Align Low subscribers with v2', version: 2 });
    expect(result).toEqual({ version: 2, moved: 1, archivedWorkspaces: 1, failedAccounts: [] });
    expect((await sub(accountB)).version).toBe(2);
    expect(await liveSegments(accountB)).toBe(1);
    const tenantAudit = await owner.query("SELECT 1 FROM platform_audit_log WHERE action='plan.move_subscribers' AND target_ref=$1", [lo]);
    expect(tenantAudit.rowCount).toBe(1);
  });

  it('the daily reconcile opens one state_mismatch per subscription and day, and changes nothing else', async () => {
    resetBillingReconcileScheduleForTests();
    // In agreement: nothing opened.
    await runBillingReconcile(accountA, provider, at(1));
    expect(await items(accountA, 'state_mismatch')).toEqual([]);
    // The provider halted it, and the webhook never arrived.
    provider.put(subA, ppLo, 'halted', at(0), at(30));
    const before = await sub(accountA);
    const intentsBefore = (await owner.query('SELECT id, status FROM billing_intents WHERE account_id=$1 ORDER BY id', [accountA])).rows;
    await runBillingReconcile(accountA, provider, at(1));
    await runBillingReconcile(accountA, provider, at(1));
    const opened = await items(accountA, 'state_mismatch');
    expect(opened).toHaveLength(1);
    expect(opened[0]).toMatchObject({ status: 'open', source_ref: `${subA}:${new Date(at(1).getTime() + 330 * 60_000).toISOString().slice(0, 10)}` });
    expect(opened[0].detail).toMatchObject({ reason: 'differs', fields: ['status'], subscription_id: subA,
      stored: { plan: lo, status: 'active' }, provider: { plan: lo, status: 'grace' } });
    expect(await sub(accountA)).toEqual(before);
    expect((await owner.query('SELECT id, status FROM billing_intents WHERE account_id=$1 ORDER BY id', [accountA])).rows).toEqual(intentsBefore);
    // A subscription the provider no longer knows, on another day.
    provider.subs.delete(subA);
    await runBillingReconcile(accountA, provider, at(2));
    expect((await items(accountA, 'state_mismatch')).map((i) => i.detail.reason)).toEqual(['differs', 'fetch_rejected']);
    provider.put(subA, ppLo, 'active', at(0), at(30));
  });

  it('resolving an item needs a note, is audited and edits nothing else', async () => {
    const [item] = await items(accountA, 'state_mismatch');
    const before = await sub(accountA);
    await expect(resolveReconciliation(admin, item.id, { note: 'x' })).rejects.toMatchObject({ code: 'note_required' });
    await resolveReconciliation(admin, item.id, { note: 'Webhook replayed by hand' });
    await expect(resolveReconciliation(admin, item.id, { note: 'Again' })).rejects.toMatchObject({ status: 404 });
    const [resolved] = (await owner.query('SELECT * FROM billing_reconciliation_items WHERE id=$1', [item.id])).rows;
    expect(resolved).toMatchObject({ status: 'resolved', resolved_by_email: admin.email, resolution_note: 'Webhook replayed by hand' });
    expect(await sub(accountA)).toEqual(before);
    const tenantAudit = await owner.query("SELECT metadata FROM audit_logs WHERE account_id=$1 AND action='billing.reconciliation_resolved'", [accountA]);
    expect(tenantAudit.rows[0].metadata).toMatchObject({ platform_admin_email: admin.email });
  });

  it('an unknown intent a day old opens intent_unknown once and stays unknown', async () => {
    const intent = (await owner.query(`INSERT INTO billing_intents(account_id,kind,at,provider,provider_subscription_id,status,created_at)
      VALUES($1,'cancel','period_end','razorpay',$2,'unknown',$3) RETURNING id`, [accountB, subB, at(-2)])).rows[0].id;
    // While a provider call is unconfirmed the daily reconcile stays out of the way.
    provider.put(subB, ppLo, 'halted', at(0), at(30));
    await runBillingReconcile(accountB, provider, at(1));
    expect(await items(accountB, 'state_mismatch')).toEqual([]);
    provider.put(subB, ppLo, 'active', at(0), at(30));
    await runLifecycleSweep(accountB, provider, T0);
    await runLifecycleSweep(accountB, provider, T0);
    const opened = await items(accountB, 'intent_unknown');
    expect(opened).toHaveLength(1);
    expect(opened[0]).toMatchObject({ source_ref: intent, detail: expect.objectContaining({ intent_id: intent, intent_kind: 'cancel', subscription_id: subB }) });
    expect((await owner.query('SELECT status FROM billing_intents WHERE id=$1', [intent])).rows[0].status).toBe('unknown');
    await owner.query("UPDATE billing_intents SET status='superseded' WHERE id=$1", [intent]);
  });

  it('an event for no workspace and an invoice that cannot be issued each open their own item, once', async () => {
    const orphan = await deliver('subscription.activated', { id: `sub_T3none${tag}` });
    const errs = await items(null, 'event_error');
    const mine = errs.filter((i) => i.source_ref === orphan);
    expect(mine).toHaveLength(1);
    expect(mine[0].detail).toMatchObject({ reason: 'no_workspace', subscription_id: `sub_T3none${tag}`, type: 'subscription.activated' });
    // A USD charge is never invoiced: the state applies, the invoice is left for an operator.
    const charged = provider.put(subB, ppLo, 'active', at(30), at(60));
    const eventId = await deliver('subscription.charged', charged, { paymentId: `pay_T3usd${tag}`, amountMinor: 5000, currency: 'USD' });
    const unissued = (await items(accountB, 'invoice_unissued')).filter((i) => i.source_ref === `pay_T3usd${tag}`);
    expect(unissued).toHaveLength(1);
    expect(unissued[0].detail).toMatchObject({ reason: 'InvoiceConfigError', amount_minor: 5000, currency: 'USD', subscription_id: subB });
    expect((await items(accountB, 'event_error')).filter((i) => i.source_ref === eventId)).toEqual([]);
    expect((await sub(accountB)).current_period_end.toISOString()).toBe(at(60).toISOString());
  });

  it('schedules one reconcile per subscribed workspace per day, and nothing without billing keys', async () => {
    resetBillingReconcileScheduleForTests();
    expect(await scheduleBillingReconcile(at(3).getTime())).toBeGreaterThan(0);
    const jobs = await owner.query("SELECT tenant_id FROM jobs WHERE type='billing.reconcile' AND tenant_id = ANY($1::uuid[])", [[accountA, accountB]]);
    expect(jobs.rows.map((r) => r.tenant_id).sort()).toEqual([accountA, accountB].sort());
    resetBillingReconcileScheduleForTests();
    await scheduleBillingReconcile(at(3).getTime());
    expect((await owner.query("SELECT count(*) AS n FROM jobs WHERE type='billing.reconcile' AND tenant_id = ANY($1::uuid[])", [[accountA, accountB]])).rows[0].n).toBe('2');
    for (const key of Object.keys(BILLING_ENV)) delete process.env[key];
    try {
      resetBillingReconcileScheduleForTests();
      expect(await scheduleBillingReconcile(at(4).getTime())).toBe(0);
    } finally {
      Object.assign(process.env, BILLING_ENV);
    }
  });

  it('the preview counts workspaces on the live row that are over a tightened limit', async () => {
    // A has 1 live segment on Low v2 (pinned); unpin it so it resolves to the live row, then preview 0 segments.
    await owner.query('UPDATE account_subscriptions SET plan_version_id=NULL WHERE account_id=$1', [accountA]);
    const preview = await platformPlanPreview(lo, {}, { segments: 0 });
    expect(preview.affected_workspaces).toBe(1);
    expect(preview.tightened).toEqual([{ key: 'segments', current: 1, next: 0, over: 1 }]);
  });
});
