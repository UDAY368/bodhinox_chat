// Razorpay Subscriptions on the PLATFORM's own Razorpay account (env
// BILLING_RAZORPAY_*), not a workspace's payment-link account. Server only:
// keys and the webhook secret never leave the server and are never logged, and
// neither are customer details or provider error text.
//
// Every call has a timeout. A timeout, network failure or 5xx is 'unknown' and
// is never retried here; see provider.ts for what callers do with it.

import { leaseFetch } from '@/lib/jobs/lease';
import { verifyWebhookSignature } from '@/lib/payments/razorpay';
import {
  toSubscriptionStatus,
  type BillingAddon,
  type BillingCustomer,
  type BillingProvider,
  type BillingSubscription,
  type BillingWebhookEvent,
  type CreateCustomerArgs,
  type CreateSubscriptionArgs,
  type ProviderNotes,
  type ProviderRejectReason,
  type ProviderResult,
  type ProviderSubscriptionState,
} from './provider';

const API_BASE = 'https://api.razorpay.com/v1';
const TIMEOUT_MS = 15_000;
const SUB_ID = /^sub_[A-Za-z0-9]{1,40}$/;
const PLAN_ID = /^plan_[A-Za-z0-9]{1,40}$/;
const CUSTOMER_ID = /^cust_[A-Za-z0-9]{1,40}$/;
/** How far back findSubscription pages (100 per page) before giving up. */
const FIND_MAX_PAGES = 5;

export interface RazorpayBillingConfig {
  keyId: string;
  keySecret: string;
  webhookSecret: string;
}

type Env = Record<string, string | undefined>;

/** The platform billing credentials, or null when any is missing. */
export function billingConfig(env: Env = process.env): RazorpayBillingConfig | null {
  const keyId = env.BILLING_RAZORPAY_KEY_ID?.trim();
  const keySecret = env.BILLING_RAZORPAY_KEY_SECRET?.trim();
  const webhookSecret = env.BILLING_RAZORPAY_WEBHOOK_SECRET?.trim();
  return keyId && keySecret && webhookSecret ? { keyId, keySecret, webhookSecret } : null;
}

/** False until all three BILLING_RAZORPAY_* variables are set; billing UI and routes stay off until then. */
export function billingConfigured(env: Env = process.env): boolean {
  return billingConfig(env) !== null;
}

/** The configured provider, or null when billing is not configured. */
export function getBillingProvider(env: Env = process.env): BillingProvider | null {
  const config = billingConfig(env);
  return config ? new RazorpayBilling(config) : null;
}

class Rejected extends Error {
  constructor(public readonly reason: ProviderRejectReason, public readonly httpStatus: number) {
    super('Razorpay rejected the request');
  }
}
class Unknown extends Error {
  constructor() {
    super('Razorpay outcome unknown');
  }
}

function rejectReason(status: number): ProviderRejectReason {
  if (status === 401 || status === 403) return 'auth';
  if (status === 404) return 'not_found';
  if (status === 409) return 'conflict';
  if (status === 429) return 'rate_limited';
  return 'invalid_request';
}

const STATES: ReadonlySet<string> = new Set(['created', 'authenticated', 'active', 'pending', 'halted', 'paused', 'cancelled', 'completed', 'expired']);
const state = (v: unknown): ProviderSubscriptionState => (typeof v === 'string' && STATES.has(v) ? (v as ProviderSubscriptionState) : 'unknown');
const date = (v: unknown): Date | null => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? new Date(v * 1000) : null);
const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);
const amount = (v: unknown): number | null => (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : null);
function notesOf(v: unknown): ProviderNotes {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return {};
  return Object.fromEntries(Object.entries(v as Record<string, unknown>).filter(([, x]) => typeof x === 'string').slice(0, 15)) as ProviderNotes;
}

function toSubscription(raw: Record<string, unknown>): BillingSubscription {
  if (typeof raw.id !== 'string' || typeof raw.plan_id !== 'string') throw new Unknown();
  const s = state(raw.status);
  return {
    id: raw.id,
    planId: raw.plan_id,
    customerId: str(raw.customer_id),
    state: s,
    status: toSubscriptionStatus(s),
    currentStart: date(raw.current_start),
    currentEnd: date(raw.current_end),
    startAt: date(raw.start_at),
    endedAt: date(raw.ended_at),
    shortUrl: str(raw.short_url),
    hasScheduledChanges: raw.has_scheduled_changes === true,
    notes: notesOf(raw.notes),
  };
}

function validNotes(notes: ProviderNotes | undefined): boolean {
  const entries = Object.entries(notes ?? {});
  return entries.length <= 15 && entries.every(([k, v]) => k.length <= 256 && typeof v === 'string' && v.length <= 256);
}

export class RazorpayBilling implements BillingProvider {
  readonly name = 'razorpay' as const;
  private readonly auth: string;

  constructor(private readonly config: RazorpayBillingConfig, private readonly fetchImpl: typeof fetch = leaseFetch) {
    this.auth = `Basic ${Buffer.from(`${config.keyId}:${config.keySecret}`).toString('base64')}`;
  }

  private async call(path: string, init: { method?: string; body?: unknown } = {}): Promise<Record<string, unknown>> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${API_BASE}${path}`, {
        method: init.method ?? 'GET',
        signal: AbortSignal.timeout(TIMEOUT_MS),
        headers: { Authorization: this.auth, ...(init.body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
        ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
      });
    } catch {
      throw new Unknown();
    }
    const body = await response.json().catch(() => null);
    if (response.status >= 500) throw new Unknown();
    if (!response.ok) throw new Rejected(rejectReason(response.status), response.status);
    if (!body || typeof body !== 'object') throw new Unknown();
    return body as Record<string, unknown>;
  }

  /** Runs a call and maps its failure to an outcome. Bad input is 'rejected' before any request. */
  private async run<T>(work: () => Promise<T>): Promise<ProviderResult<T>> {
    try {
      return { outcome: 'ok', value: await work() };
    } catch (error) {
      if (error instanceof Rejected) return { outcome: 'rejected', reason: error.reason, httpStatus: error.httpStatus };
      return { outcome: 'unknown' };
    }
  }

  private invalid<T>(): ProviderResult<T> {
    return { outcome: 'rejected', reason: 'invalid_request', httpStatus: 400 };
  }

  createCustomer(args: CreateCustomerArgs): Promise<ProviderResult<BillingCustomer>> {
    if (!args.name.trim() || args.name.length > 50 || !/^[^\s@]+@[^\s@]+$/.test(args.email) || args.email.length > 254 || !validNotes(args.notes))
      return Promise.resolve(this.invalid());
    return this.run(async () => {
      const raw = await this.call('/customers', {
        method: 'POST',
        body: {
          name: args.name.trim(),
          email: args.email,
          // Returns the existing customer for the same email instead of failing.
          fail_existing: '0',
          ...(args.gstin ? { gstin: args.gstin } : {}),
          ...(args.notes ? { notes: args.notes } : {}),
        },
      });
      if (typeof raw.id !== 'string' || !CUSTOMER_ID.test(raw.id)) throw new Unknown();
      return { id: raw.id };
    });
  }

  createSubscription(args: CreateSubscriptionArgs): Promise<ProviderResult<BillingSubscription>> {
    const totalCount = args.totalCount ?? 120;
    const trialDays = args.trialDays ?? 0;
    if (!PLAN_ID.test(args.planId) || !CUSTOMER_ID.test(args.customerId) || !validNotes(args.notes) || !Object.keys(args.notes).length
      || !Number.isInteger(totalCount) || totalCount < 1 || totalCount > 1200 || !Number.isInteger(trialDays) || trialDays < 0 || trialDays > 365)
      return Promise.resolve(this.invalid());
    return this.run(async () => toSubscription(await this.call('/subscriptions', {
      method: 'POST',
      body: {
        plan_id: args.planId,
        customer_id: args.customerId,
        total_count: totalCount,
        quantity: 1,
        // We send our own emails; Razorpay's stay off.
        customer_notify: 0,
        ...(trialDays > 0 ? { start_at: Math.floor(Date.now() / 1000) + trialDays * 86_400 } : {}),
        notes: args.notes,
      },
    })));
  }

  cancelSubscription(args: { id: string; atPeriodEnd: boolean }): Promise<ProviderResult<BillingSubscription>> {
    if (!SUB_ID.test(args.id)) return Promise.resolve(this.invalid());
    return this.run(async () => toSubscription(await this.call(`/subscriptions/${args.id}/cancel`, {
      method: 'POST',
      body: { cancel_at_cycle_end: args.atPeriodEnd ? 1 : 0 },
    })));
  }

  changePlan(args: { id: string; newPlanId: string; at: 'now' | 'period_end' }): Promise<ProviderResult<BillingSubscription>> {
    if (!SUB_ID.test(args.id) || !PLAN_ID.test(args.newPlanId) || (args.at !== 'now' && args.at !== 'period_end')) return Promise.resolve(this.invalid());
    return this.run(async () => toSubscription(await this.call(`/subscriptions/${args.id}`, {
      method: 'PATCH',
      body: { plan_id: args.newPlanId, schedule_change_at: args.at === 'now' ? 'now' : 'cycle_end', customer_notify: 0 },
    })));
  }

  createAddon(args: { subscriptionId: string; name: string; amountMinor: number; currency: string; quantity: number }): Promise<ProviderResult<BillingAddon>> {
    if (!SUB_ID.test(args.subscriptionId) || !args.name.trim() || args.name.length > 100 || !Number.isSafeInteger(args.amountMinor) || args.amountMinor <= 0
      || !/^[A-Z]{3}$/.test(args.currency) || !Number.isInteger(args.quantity) || args.quantity < 1 || args.quantity > 100_000)
      return Promise.resolve(this.invalid());
    return this.run(async () => {
      const raw = await this.call(`/subscriptions/${args.subscriptionId}/addons`, {
        method: 'POST',
        body: { item: { name: args.name.trim(), amount: args.amountMinor, currency: args.currency }, quantity: args.quantity },
      });
      if (typeof raw.id !== 'string') throw new Unknown();
      return { id: raw.id };
    });
  }

  fetchSubscription(id: string): Promise<ProviderResult<BillingSubscription>> {
    if (!SUB_ID.test(id)) return Promise.resolve(this.invalid());
    return this.run(async () => toSubscription(await this.call(`/subscriptions/${id}`)));
  }

  findSubscription(args: { planId: string; intentId: string; createdAfter: Date }): Promise<ProviderResult<BillingSubscription | null>> {
    if (!PLAN_ID.test(args.planId) || !args.intentId || Number.isNaN(args.createdAfter.getTime())) return Promise.resolve(this.invalid());
    // Small clock-skew allowance before the intent was recorded.
    const from = Math.floor(args.createdAfter.getTime() / 1000) - 300;
    return this.run(async () => {
      for (let page = 0; page < FIND_MAX_PAGES; page++) {
        const raw = await this.call(`/subscriptions?plan_id=${encodeURIComponent(args.planId)}&from=${from}&count=100&skip=${page * 100}`);
        const items = Array.isArray(raw.items) ? (raw.items as Record<string, unknown>[]) : [];
        const match = items.find((item) => notesOf(item?.notes).intent_id === args.intentId);
        if (match) return toSubscription(match);
        if (items.length < 100) return null;
      }
      // Too many to search: the outcome stays unknown rather than "not created".
      throw new Unknown();
    });
  }

  verifyWebhook(rawBody: string | Buffer, signature: string | null | undefined): boolean {
    return verifyWebhookSignature(rawBody, signature, this.config.webhookSecret);
  }

  parseWebhook(body: unknown): BillingWebhookEvent | null {
    const root = body as { event?: unknown; created_at?: unknown; payload?: Record<string, { entity?: Record<string, unknown> } | undefined> } | null;
    // payment.failed: Razorpay's payment entity names its subscription only on some
    // subscription charges (subscription_id); without it the event maps to no
    // workspace and is ignored, and the subscription.pending / halted events for
    // the same failure move the workspace to past_due instead.
    if (!root || typeof root.event !== 'string' || !/^(subscription\.|invoice\.|payment\.failed$)/.test(root.event)) return null;
    const sub = root.payload?.subscription?.entity;
    const payment = root.payload?.payment?.entity;
    const invoice = root.payload?.invoice?.entity;
    return {
      type: root.event,
      subscriptionId: str(sub?.id) ?? str(invoice?.subscription_id) ?? str(payment?.subscription_id),
      state: sub ? state(sub.status) : null,
      planId: str(sub?.plan_id),
      paymentId: str(payment?.id) ?? str(invoice?.payment_id),
      invoiceId: str(invoice?.id) ?? str(payment?.invoice_id),
      amountMinor: amount(payment?.amount) ?? amount(invoice?.amount),
      currency: str(payment?.currency) ?? str(invoice?.currency),
      currentStart: date(sub?.current_start),
      currentEnd: date(sub?.current_end),
      notes: notesOf(sub?.notes),
      createdAt: typeof root.created_at === 'number' ? root.created_at : null,
    };
  }
}
