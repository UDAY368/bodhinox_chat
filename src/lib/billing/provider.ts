// The platform's subscription billing provider, behind one interface so a second
// provider (Stripe) can be added without touching callers. Server only.
//
// Outcomes, never exceptions, for provider calls:
//   ok        the provider confirmed the change; apply it.
//   rejected  the provider definitely did not act (4xx); safe to show, nothing to reconcile.
//   unknown   timeout, network failure or 5xx: the change may or may not have
//             happened. NEVER retry blindly and never change a plan or mark
//             anything paid from it: record the intent and reconcile with
//             fetchSubscription / findSubscription (or wait for the webhook).

import type { SubscriptionStatus } from './entitlements-catalogue';

export type BillingProviderName = 'razorpay';
export type BillingInterval = 'month' | 'year';

export type ProviderRejectReason = 'auth' | 'invalid_request' | 'not_found' | 'rate_limited' | 'conflict';
export type ProviderResult<T> =
  | { outcome: 'ok'; value: T }
  | { outcome: 'rejected'; reason: ProviderRejectReason; httpStatus: number }
  | { outcome: 'unknown' };

/** Notes stored on the provider object: up to 15 string pairs, each ≤ 256 chars. Never secrets or customer content. */
export type ProviderNotes = Record<string, string>;

export interface BillingCustomer {
  id: string;
}

/** The provider's own subscription states (Razorpay's names), mapped by toSubscriptionStatus. */
export type ProviderSubscriptionState =
  | 'created' | 'authenticated' | 'active' | 'pending' | 'halted' | 'paused' | 'cancelled' | 'completed' | 'expired' | 'unknown';

export interface BillingSubscription {
  id: string;
  planId: string;
  customerId: string | null;
  state: ProviderSubscriptionState;
  /** Our status for account_subscriptions.status, or null when the state is unknown (reconcile later). */
  status: SubscriptionStatus | null;
  currentStart: Date | null;
  currentEnd: Date | null;
  /** When the first charge happens (end of a trial), if scheduled. */
  startAt: Date | null;
  endedAt: Date | null;
  /** Hosted page where the customer authorises the mandate. Send to the buyer only. */
  shortUrl: string | null;
  /** A plan change or cancellation is scheduled for the end of the cycle. */
  hasScheduledChanges: boolean;
  notes: ProviderNotes;
}

export interface BillingAddon {
  id: string;
}

export interface CreateCustomerArgs {
  name: string;
  email: string;
  gstin?: string | null;
  notes?: ProviderNotes;
}

export interface CreateSubscriptionArgs {
  /** The provider's plan id (plan_prices.provider_plan_id). */
  planId: string;
  customerId: string;
  /** Delays the first charge by this many days (the mandate is still authorised now). */
  trialDays?: number;
  /** Billing cycles before the subscription completes (Razorpay requires one). Default 120. */
  totalCount?: number;
  /** Must include a unique intent id (e.g. { account_id, intent_id }) so an unknown outcome can be found with findSubscription. */
  notes: ProviderNotes;
}

export interface BillingWebhookEvent {
  /** e.g. 'subscription.activated', 'subscription.charged', 'subscription.halted', 'invoice.paid'. */
  type: string;
  subscriptionId: string | null;
  /** Subscription state carried by the event, when it has one. */
  state: ProviderSubscriptionState | null;
  planId: string | null;
  paymentId: string | null;
  invoiceId: string | null;
  /** Amount of the payment or invoice in minor units, when present. */
  amountMinor: number | null;
  currency: string | null;
  currentStart: Date | null;
  currentEnd: Date | null;
  notes: ProviderNotes;
  /** Unix seconds from the event envelope. */
  createdAt: number | null;
}

export interface BillingProvider {
  readonly name: BillingProviderName;
  /** Creates (or, for a matching email, returns the existing) customer. */
  createCustomer(args: CreateCustomerArgs): Promise<ProviderResult<BillingCustomer>>;
  createSubscription(args: CreateSubscriptionArgs): Promise<ProviderResult<BillingSubscription>>;
  cancelSubscription(args: { id: string; atPeriodEnd: boolean }): Promise<ProviderResult<BillingSubscription>>;
  changePlan(args: { id: string; newPlanId: string; at: 'now' | 'period_end' }): Promise<ProviderResult<BillingSubscription>>;
  /** A charge added to the subscription's next invoice. `reference` (our add_ons id) is stored on it so findAddon can match it. */
  createAddon(args: { subscriptionId: string; name: string; amountMinor: number; currency: string; quantity: number; reference: string }): Promise<ProviderResult<BillingAddon>>;
  /** Reconciliation after an unknown createAddon: the add-on carrying `reference`, created at or after `createdAfter`, or null. */
  findAddon(args: { reference: string; createdAfter: Date }): Promise<ProviderResult<BillingAddon | null>>;
  fetchSubscription(id: string): Promise<ProviderResult<BillingSubscription>>;
  /** Reconciliation after an unknown create: the subscription for `planId` whose notes carry `intentId`, created at or after `createdAfter`, or null. */
  findSubscription(args: { planId: string; intentId: string; createdAfter: Date }): Promise<ProviderResult<BillingSubscription | null>>;
  /** Constant-time signature check of the exact raw body. Verify before parsing. */
  verifyWebhook(rawBody: string | Buffer, signature: string | null | undefined): boolean;
  /** The minimised billing fields of a verified webhook body (no card or customer details), or null for other events. */
  parseWebhook(body: unknown): BillingWebhookEvent | null;
}

/**
 * Provider state -> account_subscriptions.status.
 *   created        incomplete  (mandate not yet authorised)
 *   authenticated  trialing    (authorised; first charge at start_at)
 *   active         active
 *   pending        past_due    (a charge failed; the provider is retrying)
 *   halted         grace       (retries exhausted; we keep access until grace_ends_at, then suspend)
 *   paused         suspended
 *   cancelled, completed, expired  cancelled
 */
export function toSubscriptionStatus(state: ProviderSubscriptionState): SubscriptionStatus | null {
  switch (state) {
    case 'created': return 'incomplete';
    case 'authenticated': return 'trialing';
    case 'active': return 'active';
    case 'pending': return 'past_due';
    case 'halted': return 'grace';
    case 'paused': return 'suspended';
    case 'cancelled': case 'completed': case 'expired': return 'cancelled';
    default: return null;
  }
}
