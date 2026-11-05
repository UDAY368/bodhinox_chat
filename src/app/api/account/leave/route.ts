// POST /api/account/leave: the caller leaves the current workspace (Phase 14).
// Any non-owner member; the owner transfers ownership first (409
// owner_must_transfer). Refused when it is the caller's only workspace (409
// last_workspace: delete the account instead). The session moves to the caller's
// oldest remaining workspace and, for a cookie session, a new access cookie is set.

import { NextResponse } from 'next/server';

import { assertMutation, requireSession } from '@/lib/auth/session';
import { signAccessToken } from '@/lib/auth/jwt';
import { setAccessCookie } from '@/lib/auth/cookies';
import { accountActionResponse } from '@/lib/account/deletion';
import { leaveAccount } from '@/lib/repositories/memberships';
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit';

export async function POST(request: Request) {
  try {
    const session = await requireSession(request);
    await assertMutation(request, session);
    const limit = checkRateLimit(`account:leave:${session.userId}`, RATE_LIMITS.adminAction);
    if (!limit.success) return rateLimitResponse(limit);
    const { nextAccountId } = await leaveAccount(session);
    const response = NextResponse.json({ ok: true, accountId: nextAccountId });
    // A bearer client switches its own token; a cookie session gets the new workspace's token now.
    if (!request.headers.get('authorization'))
      setAccessCookie(response, await signAccessToken({ userId: session.userId, accountId: nextAccountId, sessionId: session.sessionId }));
    return response;
  } catch (error) {
    return accountActionResponse(error);
  }
}
