// Workspace subscriptions on the platform's billing provider. Server only.
//
// Writes go through the worker role in the workspace's tenant scope, after the
// route has checked the admin's live session, role and mutation origin.
//
// Durability rules:
//   - Every provider call that creates or changes a subscription is recorded
//     first (billing_intents). 'ok' is applied, 'rejected' is closed, 'unknown'
//     is never retried: the sweep reconciles it from the provider's state.
//   - The plan and status change only from the provider's reported state (a
//     confirmed response, a verified webhook followed by a fetch, or the sweep's
//     fetch). The browser's Checkout callback changes nothing.
//   - A checkout stays out of account_subscriptions until it is authorised, so
//     an unrestricted workspace is never dropped to 'free' while it pays.
//   - Webhook events are stored once per provider event id and processed by a
//     job queued in the same transaction, before the HTTP acknowledgment.
//   - A checkout authorised after it was replaced (an older link, or a second
//     subscription while one is live) never becomes the workspace's
//     subscription: it is cancelled at the provider, audit-logged and admins
//     are told.
// Nothing here deletes customer data: when the plan switches, what exceeds the
// new limits is archived (lib/billing/downgrade) and restored when it fits again.

import { getWorkerPrisma } from '@/lib/db/prisma';
import { withTenant, type TenantTransaction } from '@/lib/db/tenant';
import { AuthError } from '@/lib/auth/errors';
import type { SubscriptionStatus } from './entitlements-catalogue';
import { recordBillingNotice, type NoticeValues } from './billing-notify';
import { applyPlanLimits } from './downgrade';
import { GstError, sellerStateCode } from './gst';
import { InvoiceConfigError, issueInvoice } from './invoices';
import {
  applySnapshot,
  changeTiming,
  grantsPlan,
  needsReconcile,
  sweepTransition,
  switchesPlanLimits,
  type BillingNotice,
  type ProviderSnapshot,
  type SubscriptionRow,
  type Transition,
} from './lifecycle';
import { providerPlanFor } from './prices';
import type { BillingInterval, BillingProvider, BillingSubscription, BillingWebhookEvent } from './provider';
import { billingConfig, billingConfigured, getBillingProvider } from './razorpay-billing';
import { INTENT_UNKNOWN_AFTER_MS, openReconciliationItem } from './reconciliation';

export const BILLING_EVENT_JOB = 'billing.event';
export const BILLING_SWEEP_JOB = 'billing.lifecycle_sweep';
export const SWEEP_INTERVAL_MS = 30 * 60_000;
/** Checkout links are reused for the same plan this long. */
const CHECKOUT_REUSE_MS = 24 * 3_600_000;
/** A change the provider never shows this long after an unknown answer did not happen. */
const CHANGE_EVIDENCE_MS = 30 * 60_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const HANDLED_EVENTS: ReadonlySet<string> = new Set([
  'subscription.authenticated', 'subscription.activated', 'subscription.charged', 'subscription.pending', 'subscription.halted',
  'subscription.cancelled', 'subscription.completed', 'subscription.paused', 'subscription.resumed', 'subscription.updated', 'invoice.paid',
  // Acted on only when the payment names its subscription; the state (past_due) is then fetched, as for subscription.pending.
  'payment.failed',
]);
const CHARGE_EVENTS: ReadonlySet<string> = new Set(['subscription.charged', 'invoice.paid']);

export type BillingErrorCode =
  | 'not_configured' | 'plan_unavailable' | 'profile_required' | 'already_subscribed' | 'no_subscription' | 'payment_issue'
  | 'change_pending' | 'same_plan' | 'cancel_pending' | 'provider_rejected' | 'provider_unavailable' | 'nothing_to_resume' | 'resume_unsupported';

/** A refusal with a stable code; routes translate it (Validation.billing.<code>). */
export class BillingError extends AuthError {
  constructor(public readonly billingCode: BillingErrorCode, status: number) {
    super(billingCode, status, billingCode);
  }
}

const worker = <T>(accountId: string, fn: (tx: TenantTransaction) => Promise<T>) =>
  withTenant({ accountId, role: 'owner' }, fn, getWorkerPrisma());

/** One writer per workspace at a time (webhook jobs, sweep, routes). */
const lockAccount = (tx: TenantTransaction, accountId: string) =>
  tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`billing:${accountId}`}))`;

type SubDbRow = {
  plan_id: string; status: SubscriptionStatus; interval: BillingInterval | null; provider: string | null;
  provider_customer_id: string | null; provider_subscription_id: string | null; trial_ends_at: Date | null;
  current_period_start: Date | null; current_period_end: Date | null; cancel_at_period_end: boolean;
  scheduled_plan: string | null; grace_ends_at: Date | null; suspended_at: Date | null;
};

const fromDb = (r: SubDbRow): SubscriptionRow => ({
  planId: r.plan_id, status: r.status, interval: r.interval, provider: r.provider, providerCustomerId: r.provider_customer_id,
  providerSubscriptionId: r.provider_subscription_id, trialEndsAt: r.trial_ends_at, currentPeriodStart: r.current_period_start,
  currentPeriodEnd: r.current_period_end, cancelAtPeriodEnd: r.cancel_at_period_end, scheduledPlan: r.scheduled_plan,
  graceEndsAt: r.grace_ends_at, suspendedAt: r.suspended_at,
});

export async function readSubscription(tx: TenantTransaction, accountId: string): Promise<SubscriptionRow | null> {
  const rows = await tx.$queryRaw<SubDbRow[]>`
    SELECT plan_id, status, "interval", provider, provider_customer_id, provider_subscription_id, trial_ends_at, current_period_start,
      current_period_end, cancel_at_period_end, scheduled_plan, grace_ends_at, suspended_at
    FROM account_subscriptions WHERE account_id=${accountId}::uuid`;
  return rows[0] ? fromDb(rows[0]) : null;
}

export async function writeSubscription(tx: TenantTransaction, accountId: string, r: SubscriptionRow): Promise<void> {
  await tx.$executeRaw`
    INSERT INTO account_subscriptions (account_id, plan_id, status, "interval", provider, provider_customer_id, provider_subscription_id,
      trial_ends_at, current_period_start, current_period_end, cancel_at_period_end, scheduled_plan, grace_ends_at, suspended_at)
    VALUES (${accountId}::uuid, ${r.planId}, ${r.status}, ${r.interval}, ${r.provider}, ${r.providerCustomerId}, ${r.providerSubscriptionId},
      ${r.trialEndsAt}, ${r.currentPeriodStart}, ${r.currentPeriodEnd}, ${r.cancelAtPeriodEnd}, ${r.scheduledPlan}, ${r.graceEndsAt}, ${r.suspendedAt})
    ON CONFLICT (account_id) DO UPDATE SET plan_id=EXCLUDED.plan_id, status=EXCLUDED.status, "interval"=EXCLUDED."interval",
      provider=EXCLUDED.provider, provider_customer_id=EXCLUDED.provider_customer_id, provider_subscription_id=EXCLUDED.provider_subscription_id,
      trial_ends_at=EXCLUDED.trial_ends_at, current_period_start=EXCLUDED.current_period_start, current_period_end=EXCLUDED.current_period_end,
      cancel_at_period_end=EXCLUDED.cancel_at_period_end, scheduled_plan=EXCLUDED.scheduled_plan, grace_ends_at=EXCLUDED.grace_ends_at,
      suspended_at=EXCLUDED.suspended_at`;
}

/** Our plan + interval for a provider plan id (any price row, active or not, so old subscriptions still map). */
async function planForProviderPlan(tx: TenantTransaction, providerPlanId: string): Promise<{ plan: string; interval: BillingInterval } | null> {
  const rows = await tx.$queryRaw<{ plan: string; interval: BillingInterval }[]>`
    SELECT plan, "interval" FROM plan_prices WHERE provider='razorpay' AND provider_plan_id=${providerPlanId} ORDER BY active DESC LIMIT 1`;
  return rows[0] ?? null;
}

/** The provider's subscription with its plan mapped to ours (read only). */
export async function providerSnapshot(tx: TenantTransaction, sub: BillingSubscription): Promise<ProviderSnapshot> {
  const mapped = await planForProviderPlan(tx, sub.planId);
  return {
    subscriptionId: sub.id, customerId: sub.customerId, status: sub.status, planId: mapped?.plan ?? null, interval: mapped?.interval ?? null,
    currentStart: sub.currentStart, currentEnd: sub.currentEnd, startAt: sub.startAt,
  };
}

async function planName(tx: TenantTransaction, planId: string): Promise<string> {
  const rows = await tx.$queryRaw<{ name: string }[]>`SELECT name FROM plans WHERE id=${planId}`;
  return rows[0]?.name ?? planId;
}

const isoDay = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : 'none');

/**
 * Holds the subscription to the plan version current when it started on its
 * plan: a new plan or a new provider subscription is pinned to the plan's
 * current version; a renewal, recovery or status change of the same
 * subscription keeps its pin. A granting row without a pin gets the current
 * version (the terms it already resolves to). Non-granting rows resolve to
 * the live 'free' row whatever their pin says.
 */
async function pinPlanVersion(tx: TenantTransaction, accountId: string, prev: SubscriptionRow | null, next: SubscriptionRow): Promise<void> {
  if (!grantsPlan(next.status)) return;
  const repin = !prev || prev.planId !== next.planId || prev.providerSubscriptionId !== next.providerSubscriptionId;
  await tx.$executeRaw`
    UPDATE account_subscriptions s SET plan_version_id = (SELECT v.id FROM plans p
      JOIN plan_versions v ON v.plan_id = p.id AND v.version = p.current_version WHERE p.id = s.plan_id)
    WHERE s.account_id=${accountId}::uuid AND (${repin} OR s.plan_version_id IS NULL)`;
}

/**
 * Writes a transition and records its notices (deduplicated per subscription and
 * period). When it switches the plan whose limits apply (a scheduled downgrade
 * at renewal, a cancellation ending on Free, an upgrade or a recovery), the
 * workspace is brought within the new limits in the same transaction: what does
 * not fit is archived (the admin's saved choice, else the most recently used
 * stay), never deleted, and archived items come back when there is room.
 */
async function commitTransition(tx: TenantTransaction, accountId: string, t: Transition, now: Date): Promise<void> {
  const prev = await readSubscription(tx, accountId);
  await writeSubscription(tx, accountId, t.next);
  await pinPlanVersion(tx, accountId, prev, t.next);
  if (switchesPlanLimits(prev, t.next)) await applyPlanLimits(tx, accountId);
  if (!t.notices.length) return;
  const plan = await planName(tx, t.next.planId);
  for (const notice of t.notices) {
    const anchor = notice === 'grace_started' || notice === 'grace_ending' ? t.next.graceEndsAt
      : notice === 'suspended' ? t.next.suspendedAt : (t.next.currentPeriodEnd ?? now);
    const values: NoticeValues = { plan, date: (notice === 'grace_started' || notice === 'grace_ending' ? t.next.graceEndsAt : t.next.currentPeriodEnd)?.toISOString() ?? null };
    await recordBillingNotice(tx, accountId, notice, `${notice}:${t.next.providerSubscriptionId ?? 'none'}:${isoDay(anchor)}`, values);
  }
}

// ---------------------------------------------------------------------------
// Overview for the browser.

export interface SubscriptionView {
  plan: string;
  planName: string;
  status: SubscriptionStatus;
  interval: BillingInterval | null;
  trialEndsAt: string | null;
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
  scheduledPlan: string | null;
  graceEndsAt: string | null;
  suspendedAt: string | null;
  /** Billed through the provider (cancel, change and pay are available). */
  managed: boolean;
}

export interface PendingChange {
  kind: 'checkout' | 'change_plan' | 'cancel';
  status: 'pending' | 'unknown' | 'created';
  plan: string | null;
  interval: BillingInterval | null;
}

const iso = (d: Date | null) => (d ? d.toISOString() : null);

/** The workspace's subscription (any member) and, for admins, provider calls still being confirmed. */
export async function getBillingOverview(tx: TenantTransaction, accountId: string, isAdmin: boolean): Promise<{ subscription: SubscriptionView | null; pending: PendingChange[] }> {
  const rows = await tx.$queryRaw<(SubDbRow & { plan_name: string })[]>`
    SELECT s.plan_id, s.status, s."interval", s.provider, s.provider_customer_id, s.provider_subscription_id, s.trial_ends_at,
      s.current_period_start, s.current_period_end, s.cancel_at_period_end, s.scheduled_plan, s.grace_ends_at, s.suspended_at, p.name AS plan_name
    FROM account_subscriptions s JOIN plans p ON p.id=s.plan_id WHERE s.account_id=${accountId}::uuid`;
  const r = rows[0];
  const subscription: SubscriptionView | null = r ? {
    plan: r.plan_id, planName: r.plan_name, status: r.status, interval: r.interval, trialEndsAt: iso(r.trial_ends_at),
    currentPeriodEnd: iso(r.current_period_end), cancelAtPeriodEnd: r.cancel_at_period_end, scheduledPlan: r.scheduled_plan,
    graceEndsAt: iso(r.grace_ends_at), suspendedAt: iso(r.suspended_at), managed: !!r.provider_subscription_id,
  } : null;
  const pending = isAdmin ? await tx.$queryRaw<PendingChange[]>`
    SELECT kind, status, plan, "interval" FROM billing_intents
    WHERE account_id=${accountId}::uuid AND (status IN ('pending','unknown')
      OR (kind='checkout' AND status='created' AND created_at > now() - interval '24 hours'))
    ORDER BY created_at DESC LIMIT 5` : [];
  return { subscription, pending };
}

// ---------------------------------------------------------------------------
// Checkout.

export type CheckoutResult =
  | { state: 'ready'; subscriptionId: string; shortUrl: string | null; keyId: string; prefill: { name: string; email: string } }
  | { state: 'pending' };

type Intent = {
  id: string; kind: 'checkout' | 'change_plan' | 'cancel'; status: string; plan: string | null; interval: BillingInterval | null;
  at: 'now' | 'period_end' | null; provider_subscription_id: string | null; provider_customer_id: string | null; short_url: string | null; created_at: Date;
  provider_plan_id: string | null;
};

const LIVE: ReadonlySet<SubscriptionStatus> = new Set(['trialing', 'active', 'past_due', 'grace']);

function trialDays(env: Record<string, string | undefined> = process.env): number {
  const n = Number(env.BILLING_TRIAL_DAYS ?? 0);
  return Number.isInteger(n) && n > 0 && n <= 30 ? n : 0;
}

/**
 * Starts (or resumes) a checkout for plan + interval. Idempotent per workspace
 * and plan: an unpaid checkout for the same plan from the last 24 hours is
 * returned again instead of creating a second subscription.
 */
export async function startCheckout(
  input: { accountId: string; userId: string; plan: string; interval: BillingInterval },
  provider: BillingProvider | null = getBillingProvider(),
  now: Date = new Date(),
): Promise<CheckoutResult> {
  const keyId = billingConfig()?.keyId;
  // Every charge needs a GST invoice; without the seller's state none can be issued.
  if (!provider || !keyId || !sellerStateCode()) throw new BillingError('not_configured', 503);
  const price = await providerPlanFor(input.plan, input.interval);
  if (!price) throw new BillingError('plan_unavailable', 400);

  type Pre = { reuse: Intent; profile: { legal_name: string; email: string } } | { pending: true }
    | { intentId: string; profile: { legal_name: string; email: string; gstin: string | null }; customerId: string | null; firstSubscription: boolean };
  const pre: Pre = await worker(input.accountId, async (tx) => {
    await lockAccount(tx, input.accountId);
    const current = await readSubscription(tx, input.accountId);
    if (current?.providerSubscriptionId && LIVE.has(current.status)) throw new BillingError('already_subscribed', 409);
    const profiles = await tx.$queryRaw<{ legal_name: string; email: string; gstin: string | null }[]>`
      SELECT legal_name, email, gstin FROM billing_profiles WHERE account_id=${input.accountId}::uuid`;
    if (!profiles[0]) throw new BillingError('profile_required', 409);
    const open = await tx.$queryRaw<Intent[]>`
      SELECT id, kind, status, plan, "interval", at, provider_subscription_id, provider_customer_id, short_url, created_at, provider_plan_id FROM billing_intents
      WHERE account_id=${input.accountId}::uuid AND kind='checkout' AND status IN ('pending','unknown','created') ORDER BY created_at DESC`;
    const reuse = open.find((i) => i.status === 'created' && i.plan === input.plan && i.interval === input.interval
      && i.provider_plan_id === price.providerPlanId && i.provider_subscription_id && now.getTime() - i.created_at.getTime() < CHECKOUT_REUSE_MS);
    if (reuse) return { reuse, profile: profiles[0] };
    // An attempt whose answer was lost is reconciled by the sweep, never repeated.
    if (open.some((i) => i.status === 'pending' || i.status === 'unknown')) return { pending: true as const };
    // Unpaid checkouts for another plan are replaced (their links simply expire unused).
    await tx.$executeRaw`UPDATE billing_intents SET status='superseded' WHERE account_id=${input.accountId}::uuid AND kind='checkout' AND status='created'`;
    const inserted = await tx.$queryRaw<{ id: string }[]>`
      INSERT INTO billing_intents (account_id, kind, plan, "interval", provider, provider_customer_id, provider_plan_id, created_by)
      VALUES (${input.accountId}::uuid, 'checkout', ${input.plan}, ${input.interval}, 'razorpay', ${current?.providerCustomerId ?? null},
        ${price.providerPlanId}, ${input.userId}::uuid)
      RETURNING id`;
    return { intentId: inserted[0].id, profile: profiles[0], customerId: current?.providerCustomerId ?? null, firstSubscription: !current?.providerSubscriptionId };
  });
  if ('pending' in pre) return { state: 'pending' };
  if ('reuse' in pre)
    return { state: 'ready', subscriptionId: pre.reuse.provider_subscription_id!, shortUrl: pre.reuse.short_url, keyId, prefill: { name: pre.profile.legal_name, email: pre.profile.email } };

  const close = (status: 'rejected' | 'unknown' | 'created', extra: { subscriptionId?: string; customerId?: string | null; shortUrl?: string | null } = {}) =>
    worker(input.accountId, (tx) => tx.$executeRaw`
      UPDATE billing_intents SET status=${status}, provider_subscription_id=COALESCE(${extra.subscriptionId ?? null}, provider_subscription_id),
        provider_customer_id=COALESCE(${extra.customerId ?? null}, provider_customer_id), short_url=COALESCE(${extra.shortUrl ?? null}, short_url)
      WHERE account_id=${input.accountId}::uuid AND id=${pre.intentId}::uuid`);

  let customerId = pre.customerId;
  if (!customerId) {
    // The provider returns the existing customer for the same email, so this call is safe to repeat.
    const customer = await provider.createCustomer({ name: pre.profile.legal_name.slice(0, 50), email: pre.profile.email, gstin: pre.profile.gstin, notes: { account_id: input.accountId } });
    if (customer.outcome !== 'ok') {
      await close('rejected');
      throw new BillingError(customer.outcome === 'rejected' ? 'provider_rejected' : 'provider_unavailable', 502);
    }
    customerId = customer.value.id;
  }
  const created = await provider.createSubscription({
    planId: price.providerPlanId,
    customerId,
    trialDays: pre.firstSubscription ? trialDays() : 0,
    notes: { account_id: input.accountId, intent_id: pre.intentId, plan: input.plan, interval: input.interval },
  });
  if (created.outcome === 'rejected') {
    await close('rejected', { customerId });
    throw new BillingError('provider_rejected', 502);
  }
  if (created.outcome === 'unknown') {
    await close('unknown', { customerId });
    return { state: 'pending' };
  }
  await close('created', { subscriptionId: created.value.id, customerId, shortUrl: created.value.shortUrl });
  return { state: 'ready', subscriptionId: created.value.id, shortUrl: created.value.shortUrl, keyId, prefill: { name: pre.profile.legal_name, email: pre.profile.email } };
}

// ---------------------------------------------------------------------------
// Plan change, cancel, pay.

export type ChangeResult = { state: 'done' | 'scheduled' | 'pending' };

async function openIntent(tx: TenantTransaction, accountId: string, kinds: Intent['kind'][]): Promise<boolean> {
  const rows = await tx.$queryRaw<{ id: string }[]>`
    SELECT id FROM billing_intents WHERE account_id=${accountId}::uuid AND kind = ANY(${kinds}::text[]) AND status IN ('pending','unknown') LIMIT 1`;
  return rows.length > 0;
}

/** Records a provider refusal (thrown) or a lost answer (left for the sweep to reconcile). */
async function closeIntent(accountId: string, intentId: string, outcome: 'rejected' | 'unknown'): Promise<ChangeResult> {
  await worker(accountId, (tx) => tx.$executeRaw`UPDATE billing_intents SET status=${outcome} WHERE account_id=${accountId}::uuid AND id=${intentId}::uuid`);
  if (outcome === 'rejected') throw new BillingError('provider_rejected', 502);
  return { state: 'pending' };
}

/** Upgrade now (the provider prorates) or downgrade at the end of the period. */
export async function requestPlanChange(
  input: { accountId: string; userId: string; plan: string; interval: BillingInterval },
  provider: BillingProvider | null = getBillingProvider(),
  now: Date = new Date(),
): Promise<ChangeResult> {
  if (!provider) throw new BillingError('not_configured', 503);
  const price = await providerPlanFor(input.plan, input.interval);
  if (!price) throw new BillingError('plan_unavailable', 400);
  const pre = await worker(input.accountId, async (tx) => {
    await lockAccount(tx, input.accountId);
    const current = await readSubscription(tx, input.accountId);
    if (!current?.providerSubscriptionId || current.status === 'cancelled' || current.status === 'suspended' || current.status === 'incomplete')
      throw new BillingError('no_subscription', 409);
    if (current.status === 'past_due' || current.status === 'grace') throw new BillingError('payment_issue', 409);
    if (current.cancelAtPeriodEnd) throw new BillingError('cancel_pending', 409);
    if (await openIntent(tx, input.accountId, ['change_plan', 'cancel'])) throw new BillingError('change_pending', 409);
    const ranks = await tx.$queryRaw<{ id: string; sort: number }[]>`SELECT id, sort FROM plans WHERE id IN (${current.planId}, ${input.plan})`;
    const sortOf = (id: string) => ranks.find((r) => r.id === id)?.sort ?? 0;
    const at = changeTiming({ plan: current.planId, sort: sortOf(current.planId), interval: current.interval ?? 'month' },
      { plan: input.plan, sort: sortOf(input.plan), interval: input.interval });
    if (!at) throw new BillingError('same_plan', 409);
    const rows = await tx.$queryRaw<{ id: string }[]>`
      INSERT INTO billing_intents (account_id, kind, plan, "interval", at, provider, provider_subscription_id, created_by)
      VALUES (${input.accountId}::uuid, 'change_plan', ${input.plan}, ${input.interval}, ${at}, 'razorpay', ${current.providerSubscriptionId}, ${input.userId}::uuid)
      RETURNING id`;
    return { intentId: rows[0].id, subscriptionId: current.providerSubscriptionId, at };
  });
  const result = await provider.changePlan({ id: pre.subscriptionId, newPlanId: price.providerPlanId, at: pre.at });
  if (result.outcome !== 'ok') return closeIntent(input.accountId, pre.intentId, result.outcome);
  return worker(input.accountId, async (tx) => {
    await lockAccount(tx, input.accountId);
    await tx.$executeRaw`UPDATE billing_intents SET status='completed' WHERE account_id=${input.accountId}::uuid AND id=${pre.intentId}::uuid`;
    const current = await readSubscription(tx, input.accountId);
    if (pre.at === 'period_end') {
      if (current) await writeSubscription(tx, input.accountId, { ...current, scheduledPlan: input.plan });
      return { state: 'scheduled' as const };
    }
    const t = applySnapshot(current, await providerSnapshot(tx, result.value), now);
    if (t) await commitTransition(tx, input.accountId, t, now);
    return { state: 'done' as const };
  });
}

/**
 * Cancels at the end of the paid period (a live subscription), or now when a
 * payment is failing (stops the provider's retries). Cancel moves no money, so
 * an unconfirmed earlier request may be repeated.
 */
export async function requestCancel(
  input: { accountId: string; userId: string },
  provider: BillingProvider | null = getBillingProvider(),
  now: Date = new Date(),
): Promise<ChangeResult> {
  if (!provider) throw new BillingError('not_configured', 503);
  const pre = await worker(input.accountId, async (tx) => {
    await lockAccount(tx, input.accountId);
    const current = await readSubscription(tx, input.accountId);
    if (!current?.providerSubscriptionId || current.status === 'cancelled') throw new BillingError('no_subscription', 409);
    if (current.cancelAtPeriodEnd) return { already: true as const };
    if (await openIntent(tx, input.accountId, ['change_plan'])) throw new BillingError('change_pending', 409);
    await tx.$executeRaw`UPDATE billing_intents SET status='superseded' WHERE account_id=${input.accountId}::uuid AND kind='cancel' AND status IN ('pending','unknown')`;
    const atPeriodEnd = current.status === 'active' || current.status === 'trialing';
    const rows = await tx.$queryRaw<{ id: string }[]>`
      INSERT INTO billing_intents (account_id, kind, at, provider, provider_subscription_id, created_by)
      VALUES (${input.accountId}::uuid, 'cancel', ${atPeriodEnd ? 'period_end' : 'now'}, 'razorpay', ${current.providerSubscriptionId}, ${input.userId}::uuid) RETURNING id`;
    return { intentId: rows[0].id, subscriptionId: current.providerSubscriptionId, atPeriodEnd };
  });
  if ('already' in pre) return { state: 'scheduled' };
  const result = await provider.cancelSubscription({ id: pre.subscriptionId, atPeriodEnd: pre.atPeriodEnd });
  if (result.outcome !== 'ok') return closeIntent(input.accountId, pre.intentId, result.outcome);
  return worker(input.accountId, async (tx) => {
    await lockAccount(tx, input.accountId);
    await tx.$executeRaw`UPDATE billing_intents SET status='completed' WHERE account_id=${input.accountId}::uuid AND id=${pre.intentId}::uuid`;
    const current = await readSubscription(tx, input.accountId);
    if (pre.atPeriodEnd) {
      if (current) await writeSubscription(tx, input.accountId, { ...current, cancelAtPeriodEnd: true, scheduledPlan: null });
      return { state: 'scheduled' as const };
    }
    const t = applySnapshot(current, await providerSnapshot(tx, result.value), now);
    if (t) await commitTransition(tx, input.accountId, t, now);
    return { state: 'done' as const };
  });
}

/** The provider's page where a failing (past due, grace, suspended) subscription is paid. */
export async function paymentLink(accountId: string, provider: BillingProvider | null = getBillingProvider()): Promise<{ shortUrl: string }> {
  if (!provider) throw new BillingError('not_configured', 503);
  const current = await worker(accountId, (tx) => readSubscription(tx, accountId));
  if (current?.cancelAtPeriodEnd && current.status !== 'cancelled') throw new BillingError('resume_unsupported', 409);
  if (!current?.providerSubscriptionId || !['past_due', 'grace', 'suspended'].includes(current.status)) throw new BillingError('nothing_to_resume', 409);
  const sub = await provider.fetchSubscription(current.providerSubscriptionId);
  if (sub.outcome !== 'ok') throw new BillingError(sub.outcome === 'rejected' ? 'provider_rejected' : 'provider_unavailable', 502);
  if (!sub.value.shortUrl || !/^https:\/\//.test(sub.value.shortUrl)) throw new BillingError('nothing_to_resume', 409);
  return { shortUrl: sub.value.shortUrl };
}

// ---------------------------------------------------------------------------
// Webhook events.

/** What billing_events.payload keeps: ids, states and amounts only. */
export interface StoredBillingEvent {
  type: string;
  subscriptionId: string | null;
  paymentId: string | null;
  invoiceId: string | null;
  amountMinor: number | null;
  currency: string | null;
  accountHint: string | null;
  intentHint: string | null;
}

export function storedEvent(event: BillingWebhookEvent): StoredBillingEvent {
  const uuid = (v: string | undefined) => (v && UUID.test(v) ? v : null);
  return {
    type: event.type, subscriptionId: event.subscriptionId, paymentId: event.paymentId, invoiceId: event.invoiceId,
    amountMinor: event.amountMinor, currency: event.currency, accountHint: uuid(event.notes.account_id), intentHint: uuid(event.notes.intent_id),
  };
}

/**
 * Stores a verified event once and queues its processing job in the same
 * worker transaction. Returns false for a redelivery. Call before the 200.
 */
export async function recordBillingEvent(eventId: string, event: BillingWebhookEvent): Promise<boolean> {
  return getWorkerPrisma().$transaction(async (tx) => {
    const rows = await tx.$queryRaw<{ id: string }[]>`
      INSERT INTO billing_events (provider, event_id, type, payload) VALUES ('razorpay', ${eventId}, ${event.type}, ${JSON.stringify(storedEvent(event))}::jsonb)
      ON CONFLICT (event_id) DO NOTHING RETURNING id`;
    if (!rows[0]) return false;
    await tx.$executeRaw`INSERT INTO jobs(type,tenant_id,payload,dedupe_key)
      VALUES(${BILLING_EVENT_JOB},NULL,${JSON.stringify({ eventId: rows[0].id })}::jsonb,${`billing-event:${rows[0].id}`})
      ON CONFLICT(dedupe_key) DO NOTHING`;
    return true;
  });
}

/** The workspace an event belongs to: its subscription, or (first activation) the checkout intent named in its notes. */
async function resolveEventAccount(event: StoredBillingEvent): Promise<{ accountId: string; intentId: string | null } | null> {
  if (!event.subscriptionId) return null;
  const known = await getWorkerPrisma().$queryRaw<{ account_id: string | null }[]>`
    SELECT crm_resolve_billing_subscription('razorpay', ${event.subscriptionId}) AS account_id`;
  if (known[0]?.account_id) return { accountId: known[0].account_id, intentId: event.intentHint };
  if (!event.accountHint || !event.intentHint) return null;
  // Notes come from a signature-verified event, and the intent must exist in that workspace for this subscription.
  const intent = await worker(event.accountHint, (tx) => tx.$queryRaw<{ id: string }[]>`
    SELECT id FROM billing_intents WHERE account_id=${event.accountHint}::uuid AND id=${event.intentHint}::uuid AND kind='checkout'
      AND (provider_subscription_id IS NULL OR provider_subscription_id=${event.subscriptionId})`);
  return intent[0] ? { accountId: event.accountHint, intentId: intent[0].id } : null;
}

/**
 * Marks an event processed. With `item` (a short reason code), the error also
 * opens an event_error reconciliation item in the same transaction.
 */
async function markEvent(id: string, accountId: string | null, error: string | null, item: string | null = null): Promise<void> {
  await getWorkerPrisma().$transaction(async (tx) => {
    const rows = await tx.$queryRaw<{ event_id: string; type: string; subscription_id: string | null; account_id: string | null }[]>`
      UPDATE billing_events SET processed_at=now(), account_id=COALESCE(${accountId}::uuid, account_id), error=${error} WHERE id=${id}::uuid
      RETURNING event_id, type, payload->>'subscriptionId' AS subscription_id, account_id`;
    if (!error || !item || !rows[0]) return;
    await openReconciliationItem(tx, { accountId: rows[0].account_id, kind: 'event_error', sourceRef: id, detail: {
      reason: item, event_id: rows[0].event_id, type: rows[0].type, subscription_id: rows[0].subscription_id } });
  });
}

/**
 * Applies the provider's current state of one subscription to its workspace,
 * plus an invoice when `charge` is a successful charge. The fetch happens
 * before the transaction; the transaction is serialised per workspace.
 */
async function applyProviderState(
  accountId: string,
  sub: BillingSubscription,
  opts: { intentId?: string | null; charge?: StoredBillingEvent | null; now?: Date } = {},
): Promise<ProviderStateResult> {
  const now = opts.now ?? new Date();
  return worker(accountId, async (tx) => {
    await lockAccount(tx, accountId);
    const current = await readSubscription(tx, accountId);
    const snap = await providerSnapshot(tx, sub);
    const ours = current?.providerSubscriptionId === sub.id;
    let intentMatched = false;
    let stray = false;
    // A paid subscription on a provider plan no price row maps (a plan created
    // outside the price table) is never applied, completed or cancelled as
    // stray on a guess: it is left for reconciliation and the event says so.
    if (!ours && snap.planId === null && (snap.status === 'trialing' || snap.status === 'active'))
      return { stray: false, reconcile: 'Provider plan is not in plan_prices; add its price, then reconcile this subscription' };
    if (!ours && (snap.status === 'trialing' || snap.status === 'active')) {
      // Only the workspace's current checkout may become its subscription, and
      // only while it has no live one (the same rule startCheckout applies).
      const replaceable = !(current?.providerSubscriptionId && LIVE.has(current.status));
      if (opts.intentId && replaceable) {
        const done = await tx.$executeRaw`
          UPDATE billing_intents SET status='completed', provider_subscription_id=${sub.id}
          WHERE account_id=${accountId}::uuid AND id=${opts.intentId}::uuid AND kind='checkout'
            AND status IN ('pending','unknown','created') AND (provider_subscription_id IS NULL OR provider_subscription_id=${sub.id})`;
        intentMatched = done > 0;
      }
      if (!intentMatched) {
        // An authorised subscription the workspace must not be switched to: a
        // superseded checkout link, or a second subscription beside a live one.
        stray = true;
        if (opts.intentId)
          await tx.$executeRaw`UPDATE billing_intents SET status='superseded' WHERE account_id=${accountId}::uuid AND id=${opts.intentId}::uuid
            AND kind='checkout' AND status IN ('pending','unknown','created') AND (provider_subscription_id IS NULL OR provider_subscription_id=${sub.id})`;
        await tx.$executeRaw`INSERT INTO audit_logs(account_id,user_id,action,resource_id,metadata)
          VALUES(${accountId}::uuid,NULL,'billing.checkout_superseded',${sub.id},${JSON.stringify({ plan: snap.planId, interval: snap.interval })}::jsonb)`;
        await recordBillingNotice(tx, accountId, 'checkout_superseded', `checkout_superseded:${sub.id}`,
          { plan: await planName(tx, snap.planId ?? current?.planId ?? 'free') });
      }
    }
    // Events for an older subscription than the workspace's current one, or a stray one, change nothing.
    if (ours || intentMatched) {
      const t = applySnapshot(current, snap, now);
      if (t) await commitTransition(tx, accountId, t, now);
      if (snap.planId)
        await tx.$executeRaw`UPDATE billing_intents SET status='completed' WHERE account_id=${accountId}::uuid AND kind='change_plan'
          AND status IN ('pending','unknown') AND plan=${snap.planId} AND "interval"=${snap.interval}`;
      if (snap.status === 'cancelled')
        await tx.$executeRaw`UPDATE billing_intents SET status='completed' WHERE account_id=${accountId}::uuid AND kind='cancel' AND status IN ('pending','unknown')`;
    }
    const charge = opts.charge;
    let reconcile: string | null = null;
    let reconcileItem = true;
    if (charge && (ours || intentMatched) && charge.amountMinor && charge.amountMinor > 0 && (charge.paymentId || charge.invoiceId)) {
      const row = await readSubscription(tx, accountId);
      // The invoice runs in a savepoint: a configuration or tax-data problem
      // must not roll back the state change this paid charge carries. It is
      // audit-logged and the event is marked for reconciliation instead.
      await tx.$executeRaw`SAVEPOINT billing_invoice`;
      try {
        const invoice = await issueInvoice(tx, {
          accountId, provider: 'razorpay', providerInvoiceId: charge.invoiceId, providerPaymentId: charge.paymentId,
          amountMinor: charge.amountMinor, currency: (charge.currency ?? 'INR').toUpperCase(),
          periodStart: sub.currentStart, periodEnd: sub.currentEnd,
          planName: await planName(tx, snap.planId ?? row?.planId ?? 'free'), interval: snap.interval ?? row?.interval ?? null, now,
        });
        if (invoice.created) await recordBillingNotice(tx, accountId, 'invoice_issued', `invoice_issued:${invoice.id}`, { number: invoice.number });
        await tx.$executeRaw`RELEASE SAVEPOINT billing_invoice`;
      } catch (error) {
        if (!(error instanceof InvoiceConfigError || error instanceof GstError)) throw error;
        await tx.$executeRaw`ROLLBACK TO SAVEPOINT billing_invoice`;
        reconcile = `Invoice not issued (${error.name}): ${error.message}; issue it after fixing the billing configuration`;
        reconcileItem = false;
        await openReconciliationItem(tx, { accountId, kind: 'invoice_unissued', sourceRef: (charge.paymentId ?? charge.invoiceId)!, detail: {
          reason: error.name, subscription_id: sub.id, payment_id: charge.paymentId, invoice_id: charge.invoiceId,
          amount_minor: charge.amountMinor, currency: charge.currency } });
        // Ids and the amount only: the reason is our own configuration message, never customer content.
        await tx.$executeRaw`INSERT INTO audit_logs(account_id,user_id,action,resource_id,metadata)
          VALUES(${accountId}::uuid,NULL,'billing.invoice_unissued',${charge.paymentId ?? charge.invoiceId},
            ${JSON.stringify({ reason: error.name, payment_id: charge.paymentId, invoice_id: charge.invoiceId, amount_minor: charge.amountMinor, currency: charge.currency })}::jsonb)`;
      }
    }
    return { stray, reconcile, reconcileItem };
  });
}

interface ProviderStateResult {
  stray: boolean;
  /** Set when part of the event needs an operator (an unmapped plan, an invoice that could not be issued). */
  reconcile?: string | null;
  /** false when the producer already opened its own reconciliation item (invoice_unissued). */
  reconcileItem?: boolean;
}

/**
 * Cancels a stray subscription at the provider now (cancel moves no money, so
 * repeating it is safe) and audit-logs the outcome; 'unknown' when the
 * provider's answer was lost.
 */
async function cancelStray(accountId: string, subscriptionId: string, provider: BillingProvider): Promise<'cancelled' | 'rejected' | 'unknown'> {
  const result = await provider.cancelSubscription({ id: subscriptionId, atPeriodEnd: false });
  const outcome = result.outcome === 'ok' ? 'cancelled' : result.outcome;
  await worker(accountId, (tx) => tx.$executeRaw`INSERT INTO audit_logs(account_id,user_id,action,resource_id,metadata)
    VALUES(${accountId}::uuid,NULL,'billing.stray_subscription_cancel',${subscriptionId},${JSON.stringify({ outcome })}::jsonb)`);
  return outcome;
}

/** The billing.event job: one stored, verified provider event. */
export async function handleBillingEventJob(payload: Record<string, unknown>, provider: BillingProvider | null = getBillingProvider(), now: Date = new Date()): Promise<void> {
  const id = typeof payload.eventId === 'string' && UUID.test(payload.eventId) ? payload.eventId : null;
  if (!id) throw new Error('Invalid billing event job');
  const rows = await getWorkerPrisma().$queryRaw<{ payload: StoredBillingEvent; processed_at: Date | null }[]>`
    SELECT payload, processed_at FROM billing_events WHERE id=${id}::uuid`;
  if (!rows[0] || rows[0].processed_at) return;
  const event = rows[0].payload;
  if (!provider) throw new Error('Billing is not configured');
  const target = await resolveEventAccount(event);
  if (!target || !event.subscriptionId) {
    await markEvent(id, null, 'No workspace matches this subscription', 'no_workspace');
    return;
  }
  const sub = await provider.fetchSubscription(event.subscriptionId);
  // A read: safe to retry through the job's own backoff.
  if (sub.outcome === 'unknown') throw new Error('Billing provider unavailable');
  if (sub.outcome === 'rejected') {
    await markEvent(id, target.accountId, 'Subscription could not be fetched', 'fetch_rejected');
    return;
  }
  const { stray, reconcile, reconcileItem } = await applyProviderState(target.accountId, sub.value, { intentId: target.intentId, charge: CHARGE_EVENTS.has(event.type) ? event : null, now });
  if (stray) {
    const outcome = await cancelStray(target.accountId, sub.value.id, provider);
    // A lost answer: the job retries (and cancels again) through its own backoff.
    if (outcome === 'unknown') throw new Error('Billing provider unavailable');
    // A cancelled stray needs nobody; a refused cancel does.
    await markEvent(id, target.accountId, outcome === 'cancelled'
      ? 'Superseded checkout: cancelled at the provider'
      : 'Superseded checkout: the provider refused the cancel; cancel it in the provider dashboard', outcome === 'cancelled' ? null : 'stray_cancel_refused');
    return;
  }
  await markEvent(id, target.accountId, reconcile ?? null, reconcile && reconcileItem !== false ? 'unmapped_plan' : null);
}

// ---------------------------------------------------------------------------
// Lifecycle sweep.

/** Reconciles provider calls whose answer was lost, from the provider's own state. */
async function reconcileIntents(accountId: string, provider: BillingProvider, now: Date): Promise<void> {
  const intents = await worker(accountId, (tx) => tx.$queryRaw<Intent[]>`
    SELECT id, kind, status, plan, "interval", at, provider_subscription_id, provider_customer_id, short_url, created_at, provider_plan_id FROM billing_intents
    WHERE account_id=${accountId}::uuid AND (status='unknown' OR (status='pending' AND created_at < ${new Date(now.getTime() - 120_000)}))`);
  for (const intent of intents) {
    const setStatus = (status: string, subscriptionId: string | null = null, shortUrl: string | null = null) =>
      worker(accountId, (tx) => tx.$executeRaw`UPDATE billing_intents SET status=${status},
        provider_subscription_id=COALESCE(${subscriptionId}, provider_subscription_id), short_url=COALESCE(${shortUrl}, short_url)
        WHERE account_id=${accountId}::uuid AND id=${intent.id}::uuid AND status IN ('pending','unknown')`);
    if (intent.kind === 'checkout') {
      // The provider plan the checkout was created on (the active price may have changed since).
      const planId = intent.provider_plan_id
        ?? (intent.plan && intent.interval ? (await providerPlanFor(intent.plan, intent.interval))?.providerPlanId : null);
      if (!planId) continue;
      const found = await provider.findSubscription({ planId, intentId: intent.id, createdAfter: intent.created_at });
      if (found.outcome !== 'ok') continue;
      // The provider shows no subscription for this attempt: it was never created.
      if (!found.value) { await setStatus('rejected'); continue; }
      await setStatus('created', found.value.id, found.value.shortUrl && /^https:\/\//.test(found.value.shortUrl) ? found.value.shortUrl : null);
      if (found.value.status === 'trialing' || found.value.status === 'active') {
        const { stray } = await applyProviderState(accountId, found.value, { intentId: intent.id, now });
        // Best effort here; its webhook events retry the cancel until the provider answers.
        if (stray) await cancelStray(accountId, found.value.id, provider);
      }
      continue;
    }
    if (!intent.provider_subscription_id) continue;
    const sub = await provider.fetchSubscription(intent.provider_subscription_id);
    if (sub.outcome !== 'ok') continue;
    const mapped = await worker(accountId, (tx) => planForProviderPlan(tx, sub.value.planId));
    const old = now.getTime() - intent.created_at.getTime() > CHANGE_EVIDENCE_MS;
    if (intent.kind === 'change_plan') {
      if (mapped?.plan === intent.plan && mapped?.interval === intent.interval) {
        await applyProviderState(accountId, sub.value, { now });
        await setStatus('completed');
      } else if (intent.at === 'period_end' && sub.value.hasScheduledChanges) {
        await worker(accountId, async (tx) => {
          await lockAccount(tx, accountId);
          const current = await readSubscription(tx, accountId);
          if (current?.providerSubscriptionId === sub.value.id) await writeSubscription(tx, accountId, { ...current, scheduledPlan: intent.plan });
        });
        await setStatus('completed');
      } else if (old) await setStatus('rejected');
    } else if (intent.kind === 'cancel') {
      if (sub.value.status === 'cancelled') {
        await applyProviderState(accountId, sub.value, { now });
        await setStatus('completed');
      } else if (sub.value.hasScheduledChanges && intent.at === 'period_end') {
        await worker(accountId, async (tx) => {
          const current = await readSubscription(tx, accountId);
          if (current?.providerSubscriptionId === sub.value.id) await writeSubscription(tx, accountId, { ...current, cancelAtPeriodEnd: true });
        });
        await setStatus('completed');
      }
      // Otherwise it stays unknown: the admin may simply cancel again.
    }
  }
  // Still unknown a day later, after this attempt: an operator looks (the intent itself is left alone).
  await worker(accountId, async (tx) => {
    const stale = await tx.$queryRaw<{ id: string; kind: string; plan: string | null; interval: string | null; provider_subscription_id: string | null; created_at: Date }[]>`
      SELECT id, kind, plan, "interval", provider_subscription_id, created_at FROM billing_intents
      WHERE account_id=${accountId}::uuid AND status='unknown' AND created_at < ${new Date(now.getTime() - INTENT_UNKNOWN_AFTER_MS)}`;
    for (const i of stale)
      await openReconciliationItem(tx, { accountId, kind: 'intent_unknown', sourceRef: i.id, detail: {
        intent_id: i.id, intent_kind: i.kind, plan: i.plan, interval: i.interval, subscription_id: i.provider_subscription_id,
        created_at: i.created_at.toISOString() } });
  });
}

/** The billing.lifecycle_sweep job for one workspace. */
export async function runLifecycleSweep(accountId: string, provider: BillingProvider | null = getBillingProvider(), now: Date = new Date()): Promise<void> {
  if (!provider) return;
  await reconcileIntents(accountId, provider, now);
  const before = await worker(accountId, (tx) => readSubscription(tx, accountId));
  if (before?.providerSubscriptionId && needsReconcile(before, now)) {
    const sub = await provider.fetchSubscription(before.providerSubscriptionId);
    if (sub.outcome === 'ok') await applyProviderState(accountId, sub.value, { now });
  }
  await worker(accountId, async (tx) => {
    await lockAccount(tx, accountId);
    const current = await readSubscription(tx, accountId);
    const t = current ? sweepTransition(current, now) : null;
    if (t) await commitTransition(tx, accountId, t, now);
  });
}

let lastSweepSchedule = Number.NEGATIVE_INFINITY;

/** Called from the worker's scheduling loop: one sweep job per workspace with a due transition, every SWEEP_INTERVAL_MS. */
export async function scheduleBillingSweeps(now: number = Date.now()): Promise<number> {
  if (!billingConfigured() || now - lastSweepSchedule < 5 * 60_000) return 0;
  const db = getWorkerPrisma();
  const rows = await db.$queryRaw<{ account_id: string }[]>`
    SELECT account_id FROM crm_accounts_for_billing_sweep() UNION SELECT account_id FROM crm_accounts_with_open_billing_intents()`;
  const window = Math.floor(now / SWEEP_INTERVAL_MS);
  for (const { account_id } of rows)
    await db.$executeRaw`INSERT INTO jobs(type,tenant_id,payload,dedupe_key,max_attempts)
      VALUES(${BILLING_SWEEP_JOB},${account_id}::uuid,'{}'::jsonb,${`billing-sweep:${account_id}:${window}`},3)
      ON CONFLICT(dedupe_key) DO NOTHING`;
  lastSweepSchedule = now;
  return rows.length;
}

/** Test hook. */
export function resetBillingSweepScheduleForTests(): void {
  lastSweepSchedule = Number.NEGATIVE_INFINITY;
}

export type { BillingNotice };
