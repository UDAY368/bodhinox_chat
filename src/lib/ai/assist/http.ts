// Shared request handling for /api/ai/assist/* routes: an agent (or above)
// with the 'ai.assist' permission, inside the per-member and per-workspace
// assistant rate limits. Session and CSRF for mutations are enforced by the
// proxy. Fallbacks are 200 { ok: false, reason } so the UI can explain them
// (AiFallback.<reason>); a conversation that is not the caller's is 404.

import { NextResponse } from 'next/server';
import { requireRole, type AccountContext } from '@/lib/auth/account';
import { requirePermission } from '@/lib/auth/permissions';
import { tenantOf } from '@/lib/audience/http';
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit';
import type { AssistFailure } from './assist';

export const NO_STORE = { 'Cache-Control': 'private, no-store' };
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** The caller, or a ready response (rate limited). Throws auth errors for toErrorResponse. */
export async function assistCaller(opts: { rateLimited: boolean }): Promise<{ ctx: AccountContext } | { response: NextResponse }> {
  const ctx = await requireRole('agent');
  await requirePermission(tenantOf(ctx), 'ai.assist');
  if (opts.rateLimited) {
    const user = checkRateLimit(`ai-assist:${ctx.userId}`, RATE_LIMITS.aiAssistUser);
    if (!user.success) return { response: rateLimitResponse(user) };
    const account = checkRateLimit(`ai-assist-acct:${ctx.accountId}`, RATE_LIMITS.aiAssistAccount);
    if (!account.success) return { response: rateLimitResponse(account) };
  }
  return { ctx };
}

export function failureResponse(failure: AssistFailure): NextResponse {
  if (failure.reason === 'not_found') return NextResponse.json({ ok: false, reason: 'not_found' }, { status: 404, headers: NO_STORE });
  if (failure.reason === 'no_messages') return NextResponse.json({ ok: false, reason: 'no_messages' }, { status: 400, headers: NO_STORE });
  return NextResponse.json({ ok: false, reason: failure.reason, guard_flags: failure.guardFlags }, { headers: NO_STORE });
}

export const invalidRequest = () => NextResponse.json({ ok: false, reason: 'invalid_request' }, { status: 400, headers: NO_STORE });
