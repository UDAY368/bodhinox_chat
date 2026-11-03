/**
 * Shared plumbing for the anonymous booking APIs (/api/public/booking/**,
 * design section 5).
 *
 * - The proxy lets these paths through before any session handling; each POST
 *   checks its own Origin (assertOrigin).
 * - Slugs and tokens are format-checked before the database is touched, then
 *   resolved through the SECURITY DEFINER lookups with the worker client. All
 *   tenant work runs in withTenant(role 'owner') on the worker client.
 * - An unknown or inactive page or token, a workspace without the
 *   appointments feature and a suspended workspace all get the same plain 404.
 * - Responses are code-only and never cached; logs carry no slug, token, code,
 *   phone or name.
 */
import { createHmac, hkdfSync } from 'node:crypto';
import { NextResponse } from 'next/server';
import { AuthError } from '@/lib/auth/errors';
import { enforceAuthRateLimit } from '@/lib/auth/service';
import { PlanLimitError, requireFeature } from '@/lib/billing/entitlements';
import { requireSendingAllowed } from '@/lib/billing/suspension';
import { getWorkerPrisma } from '@/lib/db/prisma';
import { withTenant, type TenantTransaction } from '@/lib/db/tenant';
import { isCalendarDate } from '@/lib/appointments/time';
import { isManageTokenFormat, manageTokenHash } from '@/lib/appointments/tokens';
import { BOOKING_DURABLE_LIMITS, isAppointmentError, type Slot } from '@/lib/appointments/types';
import { checkRateLimit, type RateLimitOptions } from '@/lib/rate-limit';

export const NO_STORE = { 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' } as const;
/** Same shape as booking_pages.slug's CHECK. */
export const PAGE_SLUG = /^[a-z0-9][a-z0-9-]{1,46}[a-z0-9]$/;
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
/** A real YYYY-MM-DD (2026-02-30 is refused here, not by a Postgres ::date cast). */
export const isLocalDate = isCalendarDate;
/** Public JSON bodies are small; anything larger is refused unread. */
export const MAX_BODY_BYTES = 4096;

export const isId = (value: unknown): value is string => typeof value === 'string' && UUID.test(value);

export function json(body: unknown, status = 200): NextResponse {
  return NextResponse.json(body, { status, headers: NO_STORE });
}

/** The one 404 for every "not here" case, so a probe learns nothing. */
export function notFound(): NextResponse {
  return json({ code: 'not_found' }, 404);
}

export function tooMany(): NextResponse {
  return json({ code: 'too_many' }, 429);
}

/**
 * Client IP for the per-IP limits: the rightmost x-forwarded-for hop, which
 * Railway's edge appends (the client's own address as the edge saw it).
 * Entries to its left are whatever the client sent and are ignored, so a
 * client cannot pick a fresh identity per request by spoofing the header.
 */
export function clientIp(request: Request): string {
  const forwarded = request.headers.get('x-forwarded-for')?.split(',').map((hop) => hop.trim()).filter(Boolean).at(-1);
  return (forwarded || request.headers.get('x-real-ip')?.trim() || 'unknown').slice(0, 64);
}

const HOLD_CLIENT_INFO = 'booking-hold-client';

/**
 * Keyed hash (HMAC-SHA256, key derived from ENCRYPTION_KEY) of the client IP,
 * stored on a public hold for the per-client hold cap. Keyed so the stored
 * value cannot be reversed by hashing every IPv4 address.
 */
export function holdClientHash(request: Request): string {
  const hex = process.env.ENCRYPTION_KEY;
  if (!hex || !/^[0-9a-fA-F]{64}$/.test(hex)) throw new Error('ENCRYPTION_KEY must be a 32-byte hex key');
  const key = Buffer.from(hkdfSync('sha256', Buffer.from(hex, 'hex'), Buffer.alloc(0), HOLD_CLIENT_INFO, 32));
  return createHmac('sha256', key).update(clientIp(request).toLowerCase()).digest('hex');
}

/** In-memory burst limit; true when allowed. */
export function burstAllowed(scope: string, request: Request, options: RateLimitOptions): boolean {
  return checkRateLimit(`booking:${scope}:${clientIp(request)}`, options).success;
}

/** Durable per-IP hold creation limit (hashed key in auth_rate_limits). Throws a 429 AuthError. */
export function enforceCreateLimit(request: Request): Promise<void> {
  const { action, maximum, windowSeconds } = BOOKING_DURABLE_LIMITS.createPerIp;
  return enforceAuthRateLimit(action, clientIp(request), maximum, windowSeconds);
}

/** Durable per-token limit for the manage endpoints. Throws a 429 AuthError. */
export function enforceManageLimit(token: string): Promise<void> {
  const { action, maximum, windowSeconds } = BOOKING_DURABLE_LIMITS.managePerToken;
  return enforceAuthRateLimit(action, manageTokenHash(token), maximum, windowSeconds);
}

export interface PageRef { accountId: string; pageId: string }
export interface TokenRef { accountId: string; appointmentId: string }

/** An active booking page by slug, or null. */
export async function resolvePage(slug: string): Promise<PageRef | null> {
  if (!PAGE_SLUG.test(slug)) return null;
  const [hit] = await getWorkerPrisma().$queryRaw<{ account_id: string; page_id: string }[]>`
    SELECT account_id::text, page_id::text FROM resolve_booking_page(${slug})`;
  return hit ? { accountId: hit.account_id, pageId: hit.page_id } : null;
}

/** The appointment a manage token belongs to, or null. Only sha256(token) reaches the database. */
export async function resolveToken(token: string): Promise<TokenRef | null> {
  if (!isManageTokenFormat(token)) return null;
  const [hit] = await getWorkerPrisma().$queryRaw<{ account_id: string; appointment_id: string }[]>`
    SELECT account_id::text, appointment_id::text FROM resolve_appointment_token(${manageTokenHash(token)})`;
  return hit ? { accountId: hit.account_id, appointmentId: hit.appointment_id } : null;
}

/**
 * Tenant work for an anonymous caller: worker client, owner role, and the
 * plan feature plus the suspension check first (both become the plain 404).
 */
export function inPublicTenant<T>(accountId: string, work: (tx: TenantTransaction) => Promise<T>): Promise<T> {
  return withTenant({ accountId, role: 'owner' }, async (tx) => {
    await requireFeature(tx, accountId, 'appointments');
    await requireSendingAllowed(tx, accountId);
    return work(tx);
  }, getWorkerPrisma());
}

/** Read a small JSON body; null when missing, too large or not an object. */
export async function readBody(request: Request): Promise<Record<string, unknown> | null> {
  const length = Number(request.headers.get('content-length') ?? '0');
  if (length > MAX_BODY_BYTES) return null;
  const text = await request.text().catch(() => '');
  if (!text || text.length > MAX_BODY_BYTES) return null;
  try {
    const value: unknown = JSON.parse(text);
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

/** Slots carry times and remaining capacity only (no practitioner ids). */
export function publicSlots(slots: Slot[]) {
  return slots.map(({ startAt, endAt, localDate, hhmm, remaining }) => ({ startAt, endAt, localDate, hhmm, remaining }));
}

/**
 * Code-only error mapping. Plan, suspension and not_found refusals are the
 * plain 404; a durable-limit AuthError(429) is too_many; a bad Origin is 403.
 */
export function publicError(error: unknown, scope: string): NextResponse {
  if (isAppointmentError(error)) {
    if (error.code === 'not_found' || error.code === 'feature_unavailable') return notFound();
    return json({ code: error.code }, error.status);
  }
  if (error instanceof PlanLimitError) return notFound();
  if (error instanceof AuthError) {
    if (error.status === 429) return tooMany();
    if (error.status === 403) return json({ code: 'forbidden' }, 403);
  }
  // Ids only: never the slug, token, code or any customer input.
  console.error(`[booking] ${scope} failed`, error instanceof Error ? error.name : 'unknown');
  return json({ code: 'error' }, 500);
}
