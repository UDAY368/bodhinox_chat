// Shared helpers of the Zoom connection routes (Phase 9, T2).
import { NextResponse } from 'next/server';
import { toErrorResponse } from '@/lib/auth/account';
import { ForbiddenError } from '@/lib/auth/errors';
import { requirePermission } from '@/lib/auth/permissions';
import { hasMinRole } from '@/lib/auth/roles';
import { assertMutation, requireSession, type AuthContext } from '@/lib/auth/session';
import { getT } from '@/lib/i18n/translate';
import { MeetingError, type MeetingActor } from '@/lib/meetings/types';
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit';

export const NO_STORE = { 'Cache-Control': 'private, no-store' };

export const actorOf = (s: AuthContext): MeetingActor => ({ accountId: s.accountId, userId: s.userId, role: s.role });

/** Code-only refusal, translated for the toast (Validation.meetings.*). */
export function meetingErrorResponse(code: MeetingError['code']): NextResponse {
  const error = new MeetingError(code);
  return NextResponse.json({ error: getT('Validation.meetings')(code), code }, { status: error.status, headers: NO_STORE });
}

export function zoomRouteError(error: unknown): NextResponse {
  if (error instanceof MeetingError) return meetingErrorResponse(error.code);
  const response = toErrorResponse(error);
  response.headers.set('Cache-Control', 'private, no-store');
  return response;
}

/**
 * A mutation by a workspace admin holding integrations.meetings: live session,
 * Origin + CSRF proof (the session's), admin role, the permission, a rate limit.
 */
export async function adminMutation(request: Request): Promise<AuthContext | NextResponse> {
  const session = await requireSession(request);
  await assertMutation(request, session);
  if (!hasMinRole(session.role, 'admin')) throw new ForbiddenError('Connecting Zoom requires an admin role');
  await requirePermission(actorOf(session), 'integrations.meetings');
  const limit = checkRateLimit(`zoomConnection:${session.userId}`, RATE_LIMITS.adminAction);
  if (!limit.success) return rateLimitResponse(limit);
  return session;
}
