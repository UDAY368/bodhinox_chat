import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { leaseFetch as fetch } from '@/lib/jobs/lease';
import { isCurrencyCode } from '@/lib/commerce/money';
import { appOrigin } from '@/lib/auth/csrf';

/**
 * Razorpay Payment Links client. Server only: key secrets and webhook secrets
 * never leave the server and are never logged, and neither are customer details.
 *
 * Idempotency: every link carries our random `reference_id`, which Razorpay
 * keeps unique per account. A create whose outcome is unknown (timeout, network
 * error, 5xx) is NEVER retried blindly: the caller records status 'unknown' and
 * reconciles with fetchPaymentLinkByReference. A retried create with the same
 * reference is refused by Razorpay ('duplicate_reference'), which also means
 * "look it up by reference".
 */

const API_BASE = 'https://api.razorpay.com/v1';
const TIMEOUT_MS = 15_000;

export interface RazorpayCredentials { keyId: string; keySecret: string }

/** Our statuses for payment_links.status that come from Razorpay. */
export type RazorpayLinkStatus = 'created' | 'partially_paid' | 'paid' | 'expired' | 'cancelled';

export interface RazorpayPaymentLink {
  id: string;
  shortUrl: string | null;
  status: RazorpayLinkStatus | 'unknown';
  amountMinor: number;
  amountPaidMinor: number;
  currency: string;
  referenceId: string | null;
  /** Unix seconds, or null when the link does not expire. */
  expireBy: number | null;
  /** The payments made against this link (ids and amounts only). Evidence to verify, never settlement by itself. */
  payments: RazorpayLinkPayment[];
}

export interface RazorpayLinkPayment {
  paymentId: string;
  amountMinor: number;
  status: string;
}

export const PAYMENT_ID = /^pay_[A-Za-z0-9]{1,40}$/;
export const REFUND_ID = /^rfnd_[A-Za-z0-9]{1,40}$/;

export type RejectReason = 'auth' | 'duplicate_reference' | 'invalid_request' | 'rate_limited' | 'not_found';

export class RazorpayError extends Error {
  constructor(public readonly reason: RejectReason | 'unknown', public readonly httpStatus: number | null) {
    super(reason === 'unknown' ? 'Razorpay outcome unknown' : `Razorpay rejected the request (${reason})`);
    this.name = 'RazorpayError';
  }
}

export type CreatePaymentLinkResult =
  | { outcome: 'created'; link: RazorpayPaymentLink }
  /** Razorpay definitely did not create a link (4xx). Safe to show; nothing to reconcile, except 'duplicate_reference'. */
  | { outcome: 'rejected'; reason: RejectReason; httpStatus: number }
  /** Timeout, network failure or 5xx: the link may exist. Store status 'unknown' and reconcile by reference. */
  | { outcome: 'unknown' };

export interface CreatePaymentLinkArgs extends RazorpayCredentials {
  amountMinor: number;
  currency: string;
  description?: string;
  /** From newReferenceId(); stored in payment_links.reference_id before calling. */
  referenceId: string;
  customer?: { name?: string; contact?: string; email?: string };
  /** When the link expires; Razorpay needs at least 15 minutes from now. */
  expireBy?: Date;
  /** Up to 15 string notes (each ≤ 256 chars). Never put secrets here. */
  notes?: Record<string, string>;
  /** Where Razorpay sends the customer after paying: our own /shop/ or /my-booking/ page only (isAllowedCallbackUrl). */
  callbackUrl?: string;
}

/**
 * A callback is allowed only on this app's origin under /shop/<token>[/done] or
 * /my-booking/<token>. The page it opens is read-only (design E13).
 */
export function isAllowedCallbackUrl(value: string, origin: string): boolean {
  if (typeof value !== 'string' || value.length > 1024) return false;
  let url: URL;
  try { url = new URL(value); } catch { return false; }
  if (url.origin !== origin || url.username || url.password || url.search || url.hash) return false;
  return /^\/(shop|my-booking)\/[A-Za-z0-9_-]{1,100}(\/done)?$/.test(url.pathname);
}

const REFERENCE = /^[A-Za-z0-9_-]{16,40}$/;

/** A random reference id (32 url-safe characters) that fits payment_links.reference_id. */
export function newReferenceId(): string {
  return randomBytes(24).toString('base64url');
}

function authHeader({ keyId, keySecret }: RazorpayCredentials): string {
  if (!keyId || !keySecret) throw new RazorpayError('auth', null);
  return `Basic ${Buffer.from(`${keyId}:${keySecret}`).toString('base64')}`;
}

function rejectReason(status: number, body: unknown): RejectReason {
  if (status === 401 || status === 403) return 'auth';
  if (status === 404) return 'not_found';
  if (status === 429) return 'rate_limited';
  const description = (body as { error?: { description?: unknown } } | null)?.error?.description;
  if (typeof description === 'string' && /reference/i.test(description) && /(already|exist|duplicate|unique)/i.test(description))
    return 'duplicate_reference';
  return 'invalid_request';
}

const LINK_STATUSES: ReadonlySet<string> = new Set(['created', 'partially_paid', 'paid', 'expired', 'cancelled']);

function toLink(raw: Record<string, unknown>): RazorpayPaymentLink {
  if (typeof raw.id !== 'string') throw new RazorpayError('unknown', null);
  const status = typeof raw.status === 'string' && LINK_STATUSES.has(raw.status) ? (raw.status as RazorpayLinkStatus) : 'unknown';
  const int = (v: unknown) => (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : 0);
  return {
    id: raw.id,
    shortUrl: typeof raw.short_url === 'string' ? raw.short_url : null,
    status,
    amountMinor: int(raw.amount),
    amountPaidMinor: int(raw.amount_paid),
    currency: typeof raw.currency === 'string' ? raw.currency : '',
    referenceId: typeof raw.reference_id === 'string' && raw.reference_id ? raw.reference_id : null,
    expireBy: typeof raw.expire_by === 'number' && raw.expire_by > 0 ? raw.expire_by : null,
    payments: linkPayments(raw.payments),
  };
}

function linkPayments(value: unknown): RazorpayLinkPayment[] {
  if (!Array.isArray(value)) return [];
  const out: RazorpayLinkPayment[] = [];
  for (const item of value.slice(0, 50)) {
    const p = item as Record<string, unknown> | null;
    if (!p || typeof p.payment_id !== 'string' || !PAYMENT_ID.test(p.payment_id)) continue;
    out.push({
      paymentId: p.payment_id,
      amountMinor: typeof p.amount === 'number' && Number.isSafeInteger(p.amount) && p.amount >= 0 ? p.amount : 0,
      status: typeof p.status === 'string' ? p.status.slice(0, 32) : 'unknown',
    });
  }
  return out;
}

async function call(creds: RazorpayCredentials, path: string, init: { method?: string; body?: unknown } = {}): Promise<Record<string, unknown>> {
  let response: Response;
  try {
    response = await fetch(`${API_BASE}${path}`, {
      method: init.method ?? 'GET',
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: {
        Authorization: authHeader(creds),
        ...(init.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    });
  } catch (error) {
    if (error instanceof RazorpayError) throw error;
    throw new RazorpayError('unknown', null);
  }
  const body = await response.json().catch(() => null);
  if (response.status >= 500) throw new RazorpayError('unknown', response.status);
  if (!response.ok) throw new RazorpayError(rejectReason(response.status, body), response.status);
  if (!body || typeof body !== 'object') throw new RazorpayError('unknown', response.status);
  return body as Record<string, unknown>;
}

function validateCreate(args: CreatePaymentLinkArgs): void {
  const invalid = () => new RazorpayError('invalid_request', null);
  if (!args.keyId || !args.keySecret) throw new RazorpayError('auth', null);
  if (!Number.isSafeInteger(args.amountMinor) || args.amountMinor <= 0) throw invalid();
  if (!isCurrencyCode(args.currency)) throw invalid();
  if (!REFERENCE.test(args.referenceId)) throw invalid();
  if (args.description && args.description.length > 2048) throw invalid();
  if (args.expireBy && args.expireBy.getTime() < Date.now() + 15 * 60_000) throw invalid();
  const notes = Object.entries(args.notes ?? {});
  if (notes.length > 15 || notes.some(([k, v]) => k.length > 256 || typeof v !== 'string' || v.length > 256)) throw invalid();
  if (args.callbackUrl !== undefined && !isAllowedCallbackUrl(args.callbackUrl, appOrigin())) throw invalid();
}

/** Creates a link. Never throws for provider outcomes: see CreatePaymentLinkResult. Throws RazorpayError('invalid_request') for bad input before any request. */
export async function createPaymentLink(args: CreatePaymentLinkArgs): Promise<CreatePaymentLinkResult> {
  validateCreate(args);
  const customer = Object.fromEntries(
    Object.entries(args.customer ?? {}).filter(([, v]) => typeof v === 'string' && v.trim()),
  );
  try {
    const raw = await call(args, '/payment_links', {
      method: 'POST',
      body: {
        amount: args.amountMinor,
        currency: args.currency,
        accept_partial: false,
        reference_id: args.referenceId,
        ...(args.description ? { description: args.description } : {}),
        ...(Object.keys(customer).length ? { customer } : {}),
        // We deliver the link over WhatsApp; Razorpay's own SMS/email stay off.
        notify: { sms: false, email: false },
        reminder_enable: false,
        ...(args.expireBy ? { expire_by: Math.floor(args.expireBy.getTime() / 1000) } : {}),
        ...(args.notes ? { notes: args.notes } : {}),
        ...(args.callbackUrl ? { callback_url: args.callbackUrl, callback_method: 'get' } : {}),
      },
    });
    return { outcome: 'created', link: toLink(raw) };
  } catch (error) {
    if (error instanceof RazorpayError && error.reason !== 'unknown' && error.httpStatus !== null)
      return { outcome: 'rejected', reason: error.reason, httpStatus: error.httpStatus };
    return { outcome: 'unknown' };
  }
}

/** Reads one link by Razorpay id. Throws RazorpayError. */
export async function fetchPaymentLink(args: RazorpayCredentials & { id: string }): Promise<RazorpayPaymentLink> {
  if (!/^plink_[A-Za-z0-9]{1,40}$/.test(args.id)) throw new RazorpayError('invalid_request', null);
  return toLink(await call(args, `/payment_links/${args.id}`));
}

/** Reconciliation: the link created with our reference id, or null when Razorpay has none. Throws RazorpayError. */
export async function fetchPaymentLinkByReference(args: RazorpayCredentials & { referenceId: string }): Promise<RazorpayPaymentLink | null> {
  if (!REFERENCE.test(args.referenceId)) throw new RazorpayError('invalid_request', null);
  const raw = await call(args, `/payment_links?reference_id=${encodeURIComponent(args.referenceId)}`);
  const links = Array.isArray(raw.payment_links) ? (raw.payment_links as Record<string, unknown>[]) : [];
  const match = links.find((l) => l && l.reference_id === args.referenceId);
  return match ? toLink(match) : null;
}

/** Cancels an unpaid link. Throws RazorpayError. */
export async function cancelPaymentLink(args: RazorpayCredentials & { id: string }): Promise<RazorpayPaymentLink> {
  if (!/^plink_[A-Za-z0-9]{1,40}$/.test(args.id)) throw new RazorpayError('invalid_request', null);
  return toLink(await call(args, `/payment_links/${args.id}/cancel`, { method: 'POST', body: {} }));
}

/** Checks a key pair with a cheap read. Only says whether it works; never echoes provider text. */
export async function testCredentials(creds: RazorpayCredentials): Promise<{ ok: true } | { ok: false; reason: 'auth' | 'unreachable' }> {
  try {
    await call(creds, '/payment_links?count=1');
    return { ok: true };
  } catch (error) {
    if (error instanceof RazorpayError && error.reason === 'auth') return { ok: false, reason: 'auth' };
    return { ok: false, reason: 'unreachable' };
  }
}

/** Mode implied by a key id (rzp_test_… / rzp_live_…), or null when it is neither. */
export function keyMode(keyId: string): 'test' | 'live' | null {
  const match = /^rzp_(test|live)_[A-Za-z0-9]{6,40}$/.exec(keyId.trim());
  return match ? (match[1] as 'test' | 'live') : null;
}

/**
 * Verifies X-Razorpay-Signature: hex HMAC-SHA256 of the exact raw request body
 * with the webhook secret, compared in constant time. Verify before parsing.
 */
export function verifyWebhookSignature(rawBody: string | Buffer, signatureHeader: string | null | undefined, secret: string): boolean {
  if (!secret || typeof signatureHeader !== 'string' || !/^[0-9a-f]{64}$/i.test(signatureHeader.trim())) return false;
  const expected = createHmac('sha256', secret).update(rawBody).digest();
  const given = Buffer.from(signatureHeader.trim(), 'hex');
  return given.length === expected.length && timingSafeEqual(given, expected);
}

export interface RazorpayLinkEvent {
  /** e.g. 'payment_link.paid', 'payment_link.partially_paid', 'payment_link.expired', 'payment_link.cancelled'. */
  event: string;
  paymentLinkId: string;
  referenceId: string | null;
  status: RazorpayLinkStatus | 'unknown';
  amountPaidMinor: number;
  /** The payment the event reports (payment_link.paid carries it), or null. Verified by fetch before use. */
  paymentId: string | null;
  /** The payload's merchant account id (audit only), or null. */
  providerAccountId: string | null;
}

const ACCOUNT_ID = /^acc_[A-Za-z0-9]{1,40}$/;

function providerAccountOf(root: { account_id?: unknown }): string | null {
  return typeof root.account_id === 'string' && ACCOUNT_ID.test(root.account_id) ? root.account_id : null;
}

/** The payment-link part of a verified webhook body, or null for any other event. Never returns customer details. */
export function parsePaymentLinkEvent(body: unknown): RazorpayLinkEvent | null {
  const root = body as {
    event?: unknown; account_id?: unknown;
    payload?: { payment_link?: { entity?: Record<string, unknown> }; payment?: { entity?: Record<string, unknown> } };
  } | null;
  if (!root || typeof root.event !== 'string' || !root.event.startsWith('payment_link.')) return null;
  const entity = root.payload?.payment_link?.entity;
  if (!entity || typeof entity.id !== 'string') return null;
  const link = toLink(entity);
  const paymentId = root.payload?.payment?.entity?.id;
  return {
    event: root.event, paymentLinkId: link.id, referenceId: link.referenceId, status: link.status, amountPaidMinor: link.amountPaidMinor,
    paymentId: typeof paymentId === 'string' && PAYMENT_ID.test(paymentId) ? paymentId : null,
    providerAccountId: providerAccountOf(root),
  };
}

// ---------------------------------------------------------------------------
// Payments and refunds (design E7, E11). Ids, amounts and statuses only.

export interface RazorpayPayment {
  id: string;
  amountMinor: number;
  currency: string;
  /** created | authorized | captured | refunded | failed, or 'unknown'. */
  status: string;
  /** True once Razorpay captured it (stays true after a refund). */
  captured: boolean;
  method: string | null;
  amountRefundedMinor: number;
  /** Unix seconds. */
  createdAt: number | null;
}

/** Reads one payment by id with the tenant's keys. Throws RazorpayError. */
export async function fetchPayment(args: RazorpayCredentials & { id: string }): Promise<RazorpayPayment> {
  if (!PAYMENT_ID.test(args.id)) throw new RazorpayError('invalid_request', null);
  const raw = await call(args, `/payments/${args.id}`);
  if (raw.id !== args.id) throw new RazorpayError('unknown', null);
  const int = (v: unknown) => (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : 0);
  return {
    id: args.id,
    amountMinor: int(raw.amount),
    currency: typeof raw.currency === 'string' ? raw.currency : '',
    status: typeof raw.status === 'string' ? raw.status.slice(0, 32) : 'unknown',
    captured: raw.captured === true,
    method: typeof raw.method === 'string' && /^[a-z_]{1,32}$/.test(raw.method) ? raw.method : null,
    amountRefundedMinor: int(raw.amount_refunded),
    createdAt: typeof raw.created_at === 'number' && raw.created_at > 0 ? raw.created_at : null,
  };
}

/** A captured payment, including one refunded later (Razorpay then reports status 'refunded' with captured true). */
export function isCaptured(payment: Pick<RazorpayPayment, 'status' | 'captured'>): boolean {
  return payment.status === 'captured' || (payment.status === 'refunded' && payment.captured);
}

export type RazorpayRefundStatus = 'pending' | 'processed' | 'failed' | 'unknown';

export interface RazorpayRefund {
  id: string;
  paymentId: string;
  amountMinor: number;
  currency: string;
  status: RazorpayRefundStatus;
  /** notes.bodhinox_refund_id when we created it; null for a dashboard refund. */
  bodhinoxRefundId: string | null;
  /** notes.attempt (1-20) when we created it; null otherwise. */
  attempt: number | null;
}

const REFUND_STATUSES: ReadonlySet<string> = new Set(['pending', 'processed', 'failed']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function toRefund(raw: Record<string, unknown>): RazorpayRefund | null {
  if (typeof raw.id !== 'string' || !REFUND_ID.test(raw.id) || typeof raw.payment_id !== 'string' || !PAYMENT_ID.test(raw.payment_id)) return null;
  const notes = (raw.notes && typeof raw.notes === 'object' && !Array.isArray(raw.notes) ? raw.notes : {}) as Record<string, unknown>;
  const ours = typeof notes.bodhinox_refund_id === 'string' && UUID.test(notes.bodhinox_refund_id) ? notes.bodhinox_refund_id.toLowerCase() : null;
  const attemptNote = typeof notes.attempt === 'string' && /^\d{1,2}$/.test(notes.attempt) ? Number(notes.attempt) : null;
  return {
    id: raw.id,
    paymentId: raw.payment_id,
    amountMinor: typeof raw.amount === 'number' && Number.isSafeInteger(raw.amount) && raw.amount > 0 ? raw.amount : 0,
    currency: typeof raw.currency === 'string' ? raw.currency : '',
    status: typeof raw.status === 'string' && REFUND_STATUSES.has(raw.status) ? (raw.status as RazorpayRefundStatus) : 'unknown',
    bodhinoxRefundId: ours,
    attempt: ours && attemptNote !== null && attemptNote >= 1 && attemptNote <= 20 ? attemptNote : null,
  };
}

export type CreateRefundResult =
  | { outcome: 'created'; refund: RazorpayRefund }
  /** Razorpay definitely refused (4xx): nothing was refunded. */
  | { outcome: 'rejected'; reason: RejectReason; httpStatus: number }
  /** Timeout, network failure or 5xx: the refund may exist. Reconcile with listRefunds; never re-send blindly. */
  | { outcome: 'unknown' };

/**
 * Asks Razorpay to refund part or all of a captured payment. Our refund id
 * travels in notes.bodhinox_refund_id and receipt (<id>:<attempt>, so each attempt has its own receipt), so reconciliation can find
 * it. Never throws for provider outcomes; throws RazorpayError for bad input.
 */
export async function createRefund(args: RazorpayCredentials & { paymentId: string; amountMinor: number; refundId: string; attempt: number }): Promise<CreateRefundResult> {
  if (!args.keyId || !args.keySecret) throw new RazorpayError('auth', null);
  if (!PAYMENT_ID.test(args.paymentId) || !UUID.test(args.refundId) || !Number.isSafeInteger(args.amountMinor) || args.amountMinor <= 0
    || !Number.isInteger(args.attempt) || args.attempt < 1) throw new RazorpayError('invalid_request', null);
  try {
    const raw = await call(args, `/payments/${args.paymentId}/refund`, {
      method: 'POST',
      body: { amount: args.amountMinor, speed: 'normal', receipt: `${args.refundId}:${args.attempt}`, notes: { bodhinox_refund_id: args.refundId, attempt: String(args.attempt) } },
    });
    const refund = toRefund(raw);
    if (!refund) return { outcome: 'unknown' };
    return { outcome: 'created', refund };
  } catch (error) {
    if (error instanceof RazorpayError && error.reason !== 'unknown' && error.httpStatus !== null)
      return { outcome: 'rejected', reason: error.reason, httpStatus: error.httpStatus };
    return { outcome: 'unknown' };
  }
}

/** Every refund Razorpay holds for a payment (ours and the dashboard's). Throws RazorpayError. */
export async function listRefunds(args: RazorpayCredentials & { paymentId: string }): Promise<RazorpayRefund[]> {
  if (!PAYMENT_ID.test(args.paymentId)) throw new RazorpayError('invalid_request', null);
  const raw = await call(args, `/payments/${args.paymentId}/refunds?count=100`);
  const items = Array.isArray(raw.items) ? (raw.items as unknown[]) : [];
  return items
    .map((item) => (item && typeof item === 'object' ? toRefund(item as Record<string, unknown>) : null))
    .filter((r): r is RazorpayRefund => r !== null && r.paymentId === args.paymentId);
}

export interface RazorpayRefundEvent {
  /** refund.created, refund.processed, refund.failed, refund.speed_changed. */
  event: string;
  refundId: string;
  paymentId: string;
  status: RazorpayRefundStatus;
  amountMinor: number;
  currency: string;
  bodhinoxRefundId: string | null;
  providerAccountId: string | null;
}

/** The refund part of a verified webhook body, or null for any other event. Never returns customer details. */
export function parseRefundEvent(body: unknown): RazorpayRefundEvent | null {
  const root = body as { event?: unknown; account_id?: unknown; payload?: { refund?: { entity?: Record<string, unknown> } } } | null;
  if (!root || typeof root.event !== 'string' || !/^refund\.[a-z_]{1,32}$/.test(root.event)) return null;
  const entity = root.payload?.refund?.entity;
  const refund = entity && typeof entity === 'object' ? toRefund(entity) : null;
  if (!refund) return null;
  return {
    event: root.event, refundId: refund.id, paymentId: refund.paymentId, status: refund.status, amountMinor: refund.amountMinor,
    currency: refund.currency, bodhinoxRefundId: refund.bodhinoxRefundId, providerAccountId: providerAccountOf(root),
  };
}
