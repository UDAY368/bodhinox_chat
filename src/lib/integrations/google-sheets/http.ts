// Stage 5 (5G): shared helpers of the /api/integrations/google-sheets routes.
import { NextResponse } from 'next/server';
import { toErrorResponse } from '@/lib/auth/account';
import { ForbiddenError } from '@/lib/auth/errors';
import { hasMinRole } from '@/lib/auth/roles';
import { assertMutation, requireSession, type AuthContext } from '@/lib/auth/session';
import { getT } from '@/lib/i18n/translate';
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit';
import { SheetsConnectionError, type SheetsActor } from './connection';

export const NO_STORE = { 'Cache-Control': 'private, no-store' };

export const sheetsActorOf = (s: AuthContext): SheetsActor => ({ accountId: s.accountId, userId: s.userId, role: s.role });

/**
 * A mutation by a workspace admin: live session, Origin + CSRF proof, admin
 * role, a rate limit. RLS on google_sheets_connections requires an admin too.
 */
export async function sheetsAdminMutation(request: Request): Promise<AuthContext | NextResponse> {
  const session = await requireSession(request);
  await assertMutation(request, session);
  if (!hasMinRole(session.role, 'admin')) throw new ForbiddenError('Connecting Google Sheets requires an admin role');
  const limit = checkRateLimit(`googleSheets:${session.userId}`, RATE_LIMITS.adminAction);
  if (!limit.success) return rateLimitResponse(limit);
  return session;
}

/** A refusal as a fixed code with its translated message (Integrations.googleSheets.errors.*). */
export function sheetsErrorResponse(error: unknown): NextResponse {
  if (error instanceof SheetsConnectionError) {
    const status = error.code === 'not_enabled' ? 503 : error.code === 'provider_unreachable' ? 502 : 400;
    return NextResponse.json({ error: getT('Integrations.googleSheets.errors')(error.code), code: error.code }, { status, headers: NO_STORE });
  }
  const response = toErrorResponse(error);
  response.headers.set('Cache-Control', 'private, no-store');
  return response;
}
