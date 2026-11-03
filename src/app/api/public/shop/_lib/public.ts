/**
 * Shared plumbing for the anonymous storefront APIs (/api/public/shop/**,
 * design §4), following the public booking helpers.
 *
 * - The proxy lets these paths through before any session handling; every
 *   mutation checks its own Origin (assertOrigin).
 * - Tokens are format-checked before the database is touched, then resolved
 *   through the SECURITY DEFINER lookup with the worker client; only
 *   sha256(token) reaches the database. Tenant work runs in withTenant(role
 *   'owner') on the worker client, after the storefront feature and the
 *   suspension check.
 * - An unknown, revoked or expired token, a workspace without the feature and
 *   a suspended workspace all get the same plain 404.
 * - Responses are code-only and never cached; logs carry no token, address or
 *   customer input.
 */
import { NextResponse } from 'next/server';
import { assertOrigin } from '@/lib/auth/csrf';
import { AuthError } from '@/lib/auth/errors';
import { enforceAuthRateLimit } from '@/lib/auth/service';
import { PlanLimitError, requireFeature } from '@/lib/billing/entitlements';
import { requireSendingAllowed } from '@/lib/billing/suspension';
import { StoreError } from '@/lib/commerce/store-settings';
import { isStorefrontTokenFormat, storefrontTokenHash } from '@/lib/commerce/storefront-token';
import { getWorkerPrisma } from '@/lib/db/prisma';
import { withTenant, type TenantTransaction } from '@/lib/db/tenant';
import { checkRateLimit } from '@/lib/rate-limit';

export const NO_STORE = { 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Robots-Tag': 'noindex' } as const;
/** Public JSON bodies are small; anything larger is refused unread. */
export const MAX_BODY_BYTES = 8192;

/** Durable limits (hashed keys in auth_rate_limits). */
export const SHOP_LIMITS = {
  /** identity: client IP; counts lookups of tokens that do not resolve (token guessing). */
  resolveMiss: { action: 'shop_resolve_miss', maximum: 30, windowSeconds: 600 },
  /** identity: sha256 of the token */
  mutate: { action: 'shop_mutate', maximum: 120, windowSeconds: 600 },
  place: { action: 'shop_place', maximum: 10, windowSeconds: 600 },
} as const;

/** In-memory burst budgets per IP (best effort; the durable limits are the backstop). */
export const SHOP_BURST = {
  read: { limit: 120, windowMs: 60_000 },
  mutate: { limit: 60, windowMs: 60_000 },
} as const;

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

/** Rightmost x-forwarded-for hop (the edge's view of the client), as the booking pages do. */
export function clientIp(request: Request): string {
  const forwarded = request.headers.get('x-forwarded-for')?.split(',').map((hop) => hop.trim()).filter(Boolean).at(-1);
  return (forwarded || request.headers.get('x-real-ip')?.trim() || 'unknown').slice(0, 64);
}

export function burstAllowed(scope: keyof typeof SHOP_BURST, request: Request): boolean {
  return checkRateLimit(`shop:${scope}:${clientIp(request)}`, SHOP_BURST[scope]).success;
}

export interface ShopRef { accountId: string; sessionId: string; tokenHash: string }

/**
 * The session a token belongs to, or null. A token that does not resolve
 * counts against the caller's IP (throws a 429 AuthError past the limit).
 */
export async function resolveToken(token: string, request: Request): Promise<ShopRef | null> {
  if (!isStorefrontTokenFormat(token)) return null;
  const tokenHash = storefrontTokenHash(token);
  const [hit] = await getWorkerPrisma().$queryRaw<{ account_id: string; session_id: string }[]>`
    SELECT account_id::text, session_id::text FROM resolve_storefront_token(${tokenHash})`;
  if (hit) return { accountId: hit.account_id, sessionId: hit.session_id, tokenHash };
  const { action, maximum, windowSeconds } = SHOP_LIMITS.resolveMiss;
  await enforceAuthRateLimit(action, clientIp(request), maximum, windowSeconds);
  return null;
}

/** Durable per-token limit for mutations (or place). Throws a 429 AuthError. */
export function enforceTokenLimit(ref: ShopRef, kind: 'mutate' | 'place'): Promise<void> {
  const { action, maximum, windowSeconds } = SHOP_LIMITS[kind];
  return enforceAuthRateLimit(action, ref.tokenHash, maximum, windowSeconds);
}

/** Tenant work for an anonymous caller: worker client, owner role, the plan feature and the suspension check first. */
export function inPublicTenant<T>(accountId: string, work: (tx: TenantTransaction) => Promise<T>): Promise<T> {
  return withTenant({ accountId, role: 'owner' }, async (tx) => {
    await requireFeature(tx, accountId, 'storefront');
    await requireSendingAllowed(tx, accountId);
    return work(tx);
  }, getWorkerPrisma());
}

/** Read a small JSON object body; null when missing, too large or not an object. */
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

export function versionOf(body: Record<string, unknown> | null): number | null {
  const v = body?.expectedVersion;
  return typeof v === 'number' && Number.isInteger(v) && v >= 1 ? v : null;
}

/**
 * Code-only error mapping. Plan, suspension and not_found refusals are the
 * plain 404; a durable-limit AuthError(429) is too_many; a bad Origin is 403.
 * A refusal may carry safe detail (the new quote, a variant id).
 */
export function publicError(error: unknown, scope: string): NextResponse {
  if (error instanceof StoreError) {
    if (error.code === 'not_found' || error.code === 'feature_unavailable') return notFound();
    const detail: Record<string, unknown> = {};
    if (error.detail?.quote) detail.quote = error.detail.quote;
    if (typeof error.detail?.variantId === 'string') detail.variantId = error.detail.variantId;
    if (typeof error.detail?.field === 'string') detail.field = error.detail.field;
    return json({ code: error.code, ...detail }, error.status);
  }
  if (error instanceof PlanLimitError) return notFound();
  if (error instanceof AuthError) {
    if (error.status === 429) return tooMany();
    if (error.status === 403) return json({ code: 'forbidden' }, 403);
  }
  // Ids only: never the token, address or any customer input.
  console.error(`[storefront] ${scope} failed`, error instanceof Error ? error.name : 'unknown');
  return json({ code: 'error' }, 500);
}

export type TokenParams = { params: Promise<{ token: string }> };

/**
 * One version-checked change to the session: Origin, burst, body, durable
 * per-token limit, token, then `change` in the tenant; answers with the
 * fresh view so the page never re-fetches.
 */
export async function mutateSession(
  request: Request, { params }: TokenParams, scope: string,
  change: (tx: TenantTransaction, ref: ShopRef, body: Record<string, unknown>, expectedVersion: number) => Promise<void>,
  view: (tx: TenantTransaction, ref: ShopRef) => Promise<unknown>,
): Promise<NextResponse> {
  try {
    assertOrigin(request);
    if (!burstAllowed('mutate', request)) return tooMany();
    const { token } = await params;
    if (!isStorefrontTokenFormat(token)) return notFound();
    const body = await readBody(request);
    const expectedVersion = versionOf(body);
    if (!body || expectedVersion === null) return json({ code: 'invalid' }, 400);
    const ref = await resolveToken(token, request);
    if (!ref) return notFound();
    await enforceTokenLimit(ref, 'mutate');
    const result = await inPublicTenant(ref.accountId, async (tx) => {
      await change(tx, ref, body, expectedVersion);
      return view(tx, ref);
    });
    return result ? json(result) : notFound();
  } catch (error) {
    return publicError(error, scope);
  }
}
