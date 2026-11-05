// Platform administration access (Phase 14).
//
// A platform admin is a signed-in user whose verified email is listed in
// PLATFORM_ADMIN_EMAILS. It is not a tenant role, cannot be granted from the
// app and has no database flag. Every platform request additionally needs a
// verified MFA factor and a session whose MFA was verified within
// PLATFORM_ADMIN_MFA_MAX_AGE (default 12 hours; "mfa-step-up" refreshes it),
// the origin/CSRF check for mutations, and a rate limit.
//
// The console (pages and /api/platform/*) also needs PLATFORM_DATABASE_URL:
// without it, and for anyone who is not an allowlisted admin, it answers 404.

import { NextResponse } from 'next/server';
import { AuthError, ForbiddenError, UnauthorizedError } from '@/lib/auth/errors';
import { assertMutation, requireSession, resolveSession, type AuthContext } from '@/lib/auth/session';
import { isPlatformAdmin } from '@/lib/billing/prices';
import { getAuthPrisma, platformDatabaseConfigured } from '@/lib/db/prisma';
import { checkRateLimit } from '@/lib/rate-limit';
import type { PlatformAdmin } from '@/types/platform';

export const DEFAULT_PLATFORM_MFA_MAX_AGE_MS = 12 * 60 * 60 * 1000;

/** The console does not exist for this caller (or this deployment). */
export class PlatformNotFoundError extends AuthError {
  constructor() {
    super('Not found', 404, 'not_found');
  }
}

/**
 * PLATFORM_ADMIN_MFA_MAX_AGE: minutes ("90m"), hours ("12h" or a bare number of hours). Out of range or
 * malformed values fall back to the 12-hour default; the maximum is 24 hours.
 */
export function platformMfaMaxAgeMs(env: Record<string, string | undefined> = process.env): number {
  const match = /^\s*(\d{1,4})\s*([mh]?)\s*$/i.exec(env.PLATFORM_ADMIN_MFA_MAX_AGE ?? '');
  if (!match) return DEFAULT_PLATFORM_MFA_MAX_AGE_MS;
  const ms = Number(match[1]) * (match[2].toLowerCase() === 'm' ? 60_000 : 3_600_000);
  return ms >= 60_000 && ms <= 24 * 3_600_000 ? ms : DEFAULT_PLATFORM_MFA_MAX_AGE_MS;
}

type MfaState = { factor: boolean; verifiedAt: Date | null };
async function mfaState(context: AuthContext): Promise<MfaState> {
  const rows = await getAuthPrisma().$queryRaw<{ factor: boolean; mfa_verified_at: Date | null }[]>`
    SELECT EXISTS (SELECT 1 FROM auth_mfa_factors f WHERE f.user_id=${context.userId}::uuid AND f.verified_at IS NOT NULL) AS factor,
      s.mfa_verified_at
    FROM auth_sessions s
    WHERE s.id=${context.sessionId}::uuid AND s.user_id=${context.userId}::uuid AND s.revoked_at IS NULL AND s.expires_at>NOW()`;
  if (!rows[0]) throw new UnauthorizedError();
  return { factor: rows[0].factor, verifiedAt: rows[0].mfa_verified_at };
}

/** Pure check of the MFA rule, for tests and the server layout. */
export function mfaDecision(state: MfaState, now = Date.now(), maxAgeMs = platformMfaMaxAgeMs()): 'ok' | 'enroll' | 'step_up' {
  if (!state.factor) return 'enroll';
  if (!state.verifiedAt || now - state.verifiedAt.getTime() > maxAgeMs || state.verifiedAt.getTime() > now + 60_000) return 'step_up';
  return 'ok';
}

export interface PlatformAccessOptions {
  /** Mutations also pass the origin/CSRF (or bearer-binding) check. */
  mutation?: boolean;
  /**
   * true (default) for the console and /api/platform/*: needs PLATFORM_DATABASE_URL and answers 404 to
   * everyone who is not an allowlisted admin. false for the older platform-wide routes that run on the
   * worker role (plan prices, Meta rate cards): they keep answering 403 to non-admins.
   */
  console?: boolean;
}

/**
 * Session -> allowlist -> verified factor -> recent MFA -> mutation check -> rate limit.
 * Throws AuthError subclasses: 401 signed out (also for the console, so the client refreshes an
 * expired access cookie), 404/403 not an admin, 403 'mfa_enrollment_required',
 * 403 'mfa_step_up_required', 429 'rate_limited'.
 */
export async function requirePlatformAdmin(request: Request, options: PlatformAccessOptions = {}): Promise<PlatformAdmin> {
  const consoleAccess = options.console !== false;
  if (consoleAccess && !platformDatabaseConfigured()) throw new PlatformNotFoundError();
  // A signed-out caller (or an expired access cookie) gets the usual 401, so the
  // client's authFetch refreshes the session and retries; the console stays
  // hidden (404) when unconfigured or for anyone not on the allowlist.
  const context: AuthContext = await requireSession(request);
  if (!isPlatformAdmin(context.user.email)) throw consoleAccess ? new PlatformNotFoundError() : new ForbiddenError();
  const decision = mfaDecision(await mfaState(context));
  if (decision === 'enroll')
    throw new AuthError('Set up two-step verification to use platform administration', 403, 'mfa_enrollment_required');
  if (decision === 'step_up')
    throw new AuthError('Confirm your two-step verification code to continue', 403, 'mfa_step_up_required');
  if (options.mutation) await assertMutation(request, context);
  const limit = checkRateLimit(`platform:${options.mutation ? 'write' : 'read'}:${context.userId}`,
    { limit: options.mutation ? 30 : 240, windowMs: 60_000 });
  if (!limit.success) throw new AuthError('Too many requests. Try again shortly.', 429, 'rate_limited');
  return { userId: context.userId, sessionId: context.sessionId, email: context.user.email.trim().toLowerCase() };
}

export type PlatformPageAccess =
  | { kind: 'ok'; admin: PlatformAdmin }
  | { kind: 'enroll' }
  | { kind: 'step_up' };

/**
 * For the console's server layout (cookies, no request): null means render notFound() - the console
 * is not configured, the visitor is signed out, or is not an allowlisted admin.
 */
export async function getPlatformPageAccess(): Promise<PlatformPageAccess | null> {
  if (!platformDatabaseConfigured()) return null;
  try {
    const context = await resolveSession();
    if (!context || !isPlatformAdmin(context.user.email)) return null;
    const decision = mfaDecision(await mfaState(context));
    if (decision !== 'ok') return { kind: decision };
    return { kind: 'ok', admin: { userId: context.userId, sessionId: context.sessionId, email: context.user.email.trim().toLowerCase() } };
  } catch {
    return null;
  }
}

/** JSON error for platform routes: { error, code } with the error's status; unknown errors are 500 and logged by name only. */
export function platformErrorResponse(error: unknown): NextResponse {
  if (error instanceof AuthError)
    return NextResponse.json({ error: error.message, code: error.code }, { status: error.status, headers: { 'Cache-Control': 'no-store' } });
  console.error('Platform operation failed', error instanceof Error ? error.name : 'unknown');
  return NextResponse.json({ error: 'Internal server error', code: 'internal' }, { status: 500 });
}
