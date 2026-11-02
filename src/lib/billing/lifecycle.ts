// The subscription state machine (pure: no I/O). subscriptions.ts loads the
// row, asks the provider for its current state and writes what this returns.
//
//   checkout ── authorised ──> trialing ── first charge ──> active
//   active ── charge fails ──> past_due (provider retrying)
//   past_due ── retries exhausted (halted) ──> grace (GRACE_DAYS of full access)
//   grace ── GRACE_DAYS pass (our sweep) ──> suspended (signs in and pays; no outbound sends)
//   past_due | grace | suspended ── a charge succeeds ──> active (recovery)
//   cancel at period end: stays active until the provider ends it ──> cancelled (free plan)
//   upgrade: provider changes the plan now and prorates; we apply the plan it reports.
//   downgrade: provider schedules the change for the cycle end (scheduled_plan);
//              applied when the provider reports the new plan at renewal.
//
// The plan and every status other than our own grace -> suspended step come
// only from the provider's reported state, never from a request we made.

import type { SubscriptionStatus } from './entitlements-catalogue';
import type { BillingInterval } from './provider';

export const GRACE_DAYS = 7;
const DAY_MS = 86_400_000;
/** Warn admins this long before grace ends. */
export const GRACE_WARNING_MS = 2 * DAY_MS;
/** A trial whose first charge has not happened this long after it ended is treated as a failed payment. */
export const TRIAL_CHARGE_ALLOWANCE_MS = 3 * DAY_MS;
/** A renewal not reported this long after the period ended is fetched from the provider. */
export const RENEWAL_ALLOWANCE_MS = DAY_MS;

export interface SubscriptionRow {
  planId: string;
  status: SubscriptionStatus;
  interval: BillingInterval | null;
  provider: string | null;
  providerCustomerId: string | null;
  providerSubscriptionId: string | null;
  trialEndsAt: Date | null;
  currentPeriodStart: Date | null;
  currentPeriodEnd: Date | null;
  cancelAtPeriodEnd: boolean;
  scheduledPlan: string | null;
  graceEndsAt: Date | null;
  suspendedAt: Date | null;
}

/** The provider's current view of one subscription, with its plan mapped to ours. */
export interface ProviderSnapshot {
  subscriptionId: string;
  customerId: string | null;
  /** null: a state we do not know; nothing changes until it is reconciled. */
  status: SubscriptionStatus | null;
  /** Our plan id for the provider plan, or null when no plan_prices row maps it. */
  planId: string | null;
  interval: BillingInterval | null;
  currentStart: Date | null;
  currentEnd: Date | null;
  /** First charge (end of a trial), when scheduled. */
  startAt: Date | null;
}

export const BILLING_NOTICES = ['activated', 'payment_failed', 'grace_started', 'grace_ending', 'suspended', 'recovered', 'cancelled', 'invoice_issued',
  'checkout_superseded'] as const;
export type BillingNotice = (typeof BILLING_NOTICES)[number];

export interface Transition {
  next: SubscriptionRow;
  notices: BillingNotice[];
}

const GRANTING: ReadonlySet<SubscriptionStatus> = new Set(['trialing', 'active', 'past_due', 'grace']);
const TROUBLED: ReadonlySet<SubscriptionStatus> = new Set(['past_due', 'grace', 'suspended']);

/** Whether the status keeps the subscribed plan (others fall back to 'free'). */
export const grantsPlan = (status: SubscriptionStatus): boolean => GRANTING.has(status);

/**
 * Applies the provider's current state to our row. Returns null when nothing
 * may change: an unknown state, an unmapped plan, or a checkout that is not
 * authorised yet (pending checkouts stay out of account_subscriptions, so an
 * unrestricted workspace is not dropped to 'free' before it pays).
 */
export function applySnapshot(current: SubscriptionRow | null, snap: ProviderSnapshot, now: Date): Transition | null {
  if (snap.status === null) return null;
  const sameSubscription = current?.providerSubscriptionId === snap.subscriptionId;
  // A new subscription (first checkout, or one replacing a cancelled one) is
  // recorded only once it grants a plan.
  if (!sameSubscription && !(snap.status === 'trialing' || snap.status === 'active')) return null;
  const base = sameSubscription ? current : null;
  const planId = snap.planId ?? base?.planId ?? null;
  if (!planId) return null;
  const prev = base?.status ?? null;
  // A trial whose first charge is overdue was moved to grace by our sweep; the
  // provider still reporting it as authenticated (trialing) is not a payment.
  // Only a charge (active) or a first charge rescheduled into the future
  // recovers it, so grace keeps running out instead of restarting every sweep.
  if (snap.status === 'trialing' && prev && TROUBLED.has(prev)) {
    const firstCharge = snap.startAt ?? base?.trialEndsAt ?? null;
    if (!firstCharge || firstCharge.getTime() + TRIAL_CHARGE_ALLOWANCE_MS <= now.getTime()) return null;
  }

  let status: SubscriptionStatus = snap.status;
  let graceEndsAt: Date | null = null;
  let suspendedAt: Date | null = null;
  if (status === 'grace') {
    // Our sweep already suspended it; the provider still says halted.
    if (prev === 'suspended') {
      status = 'suspended';
      suspendedAt = base?.suspendedAt ?? now;
    } else graceEndsAt = prev === 'grace' && base?.graceEndsAt ? base.graceEndsAt : new Date(now.getTime() + GRACE_DAYS * DAY_MS);
  } else if (status === 'suspended') suspendedAt = prev === 'suspended' && base?.suspendedAt ? base.suspendedAt : now;

  const cancelled = status === 'cancelled';
  const scheduled = base?.scheduledPlan ?? null;
  const next: SubscriptionRow = {
    planId,
    status,
    interval: snap.interval ?? base?.interval ?? null,
    provider: 'razorpay',
    providerCustomerId: snap.customerId ?? base?.providerCustomerId ?? current?.providerCustomerId ?? null,
    providerSubscriptionId: snap.subscriptionId,
    trialEndsAt: status === 'trialing' ? (snap.startAt ?? base?.trialEndsAt ?? null) : (base?.trialEndsAt ?? null),
    currentPeriodStart: snap.currentStart ?? base?.currentPeriodStart ?? null,
    currentPeriodEnd: snap.currentEnd ?? base?.currentPeriodEnd ?? null,
    cancelAtPeriodEnd: cancelled ? false : (base?.cancelAtPeriodEnd ?? false),
    // A scheduled downgrade is done once the provider reports that plan.
    scheduledPlan: cancelled || scheduled === planId ? null : scheduled,
    graceEndsAt,
    suspendedAt,
  };

  const notices: BillingNotice[] = [];
  if (status !== prev) {
    if ((status === 'active' || status === 'trialing') && prev && TROUBLED.has(prev)) notices.push('recovered');
    else if ((status === 'active' || status === 'trialing') && (prev === null || prev === 'cancelled' || prev === 'incomplete')) notices.push('activated');
    else if (status === 'past_due') notices.push('payment_failed');
    else if (status === 'grace') notices.push('grace_started');
    else if (status === 'suspended') notices.push('suspended');
    else if (status === 'cancelled') notices.push('cancelled');
  }
  return { next, notices };
}

/**
 * The plan whose limits saved segments, lists, flows and automations must fit
 * (archived beyond, restored within), or null when nothing is archived or
 * restored: no subscription (unrestricted) or a suspension (temporary; paying
 * restores everything at once, so nothing is archived for it).
 */
export function enforcedPlan(row: SubscriptionRow | null): string | null {
  if (!row || row.status === 'suspended') return null;
  return grantsPlan(row.status) ? row.planId : 'free';
}

/**
 * Whether a transition switches the plan limits apply to: a scheduled
 * downgrade reported at renewal, a cancellation ending on 'free', an upgrade,
 * or recovery after suspension (restores). A first subscription of a workspace
 * that had none is not a switch: nothing it already runs is archived for it.
 */
export function switchesPlanLimits(prev: SubscriptionRow | null, next: SubscriptionRow): boolean {
  if (!prev) return false;
  const to = enforcedPlan(next);
  return to !== null && to !== enforcedPlan(prev);
}

/** Time-based steps that need no provider call: grace expiry and its warning, and a trial that never charged. */
export function sweepTransition(current: SubscriptionRow, now: Date): Transition | null {
  if (current.status === 'grace' && current.graceEndsAt) {
    if (current.graceEndsAt.getTime() <= now.getTime())
      return { next: { ...current, status: 'suspended', suspendedAt: now }, notices: ['suspended'] };
    if (current.graceEndsAt.getTime() - now.getTime() <= GRACE_WARNING_MS) return { next: current, notices: ['grace_ending'] };
    return null;
  }
  if (current.status === 'trialing' && current.trialEndsAt && current.trialEndsAt.getTime() + TRIAL_CHARGE_ALLOWANCE_MS <= now.getTime())
    return { next: { ...current, status: 'grace', graceEndsAt: new Date(now.getTime() + GRACE_DAYS * DAY_MS) }, notices: ['grace_started'] };
  return null;
}

/** Whether the sweep should fetch the provider's state: a transition is due that its webhook has not reported. */
export function needsReconcile(current: SubscriptionRow, now: Date): boolean {
  if (!current.providerSubscriptionId) return false;
  const t = now.getTime();
  const ended = current.currentPeriodEnd !== null && current.currentPeriodEnd.getTime() + RENEWAL_ALLOWANCE_MS <= t;
  if (current.status === 'trialing') return current.trialEndsAt !== null && current.trialEndsAt.getTime() <= t;
  if (current.status === 'past_due' || current.status === 'grace' || current.status === 'incomplete') return true;
  if (current.status === 'active') return ended || ((current.cancelAtPeriodEnd || current.scheduledPlan !== null) && current.currentPeriodEnd !== null && current.currentPeriodEnd.getTime() <= t);
  return false;
}

export interface PlanRank {
  plan: string;
  sort: number;
  interval: BillingInterval;
}

/**
 * When a plan change takes effect: an upgrade (a higher plan, or the same plan
 * billed yearly) now, prorated by the provider; anything else at the end of
 * the current period, so a paid term is never cut short.
 */
export function changeTiming(from: PlanRank, to: PlanRank): 'now' | 'period_end' | null {
  if (from.plan === to.plan && from.interval === to.interval) return null;
  if (to.sort > from.sort) return 'now';
  if (to.sort === from.sort && from.interval === 'month' && to.interval === 'year') return 'now';
  return 'period_end';
}
