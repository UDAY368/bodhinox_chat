import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { leaseFetch as fetch } from '@/lib/jobs/lease';
import { isCurrencyCode } from '@/lib/commerce/money';

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
}

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
  };
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
}

/** The payment-link part of a verified webhook body, or null for any other event. Never returns customer details. */
export function parsePaymentLinkEvent(body: unknown): RazorpayLinkEvent | null {
  const root = body as { event?: unknown; payload?: { payment_link?: { entity?: Record<string, unknown> } } } | null;
  if (!root || typeof root.event !== 'string' || !root.event.startsWith('payment_link.')) return null;
  const entity = root.payload?.payment_link?.entity;
  if (!entity || typeof entity.id !== 'string') return null;
  const link = toLink(entity);
  return { event: root.event, paymentLinkId: link.id, referenceId: link.referenceId, status: link.status, amountPaidMinor: link.amountPaidMinor };
}
