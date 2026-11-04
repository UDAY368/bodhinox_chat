// DELETE /api/analytics/reports/[id]/shares/[shareId] — revokes a share
// (admins and owners; audited). 204, or 404 for an unknown share.

import { ForbiddenError, toErrorResponse } from '@/lib/auth/account';
import { hasMinRole } from '@/lib/auth/roles';
import { assertMutation, requireSession } from '@/lib/auth/session';
import { revokeShare } from '@/lib/analytics/report-shares';
import { checkRateLimit, rateLimitResponse } from '@/lib/rate-limit';
import { shareErrorResponse } from '../errors';

export async function DELETE(request: Request, { params }: { params: Promise<{ id: string; shareId: string }> }) {
  try {
    const session = await requireSession(request);
    await assertMutation(request, session);
    if (!hasMinRole(session.role, 'admin')) throw new ForbiddenError();
    const limit = checkRateLimit(`analyticsReportShares:${session.userId}`, { limit: 20, windowMs: 60_000 });
    if (!limit.success) return rateLimitResponse(limit);
    const { id, shareId } = await params;
    try {
      await revokeShare(session, id, shareId);
      return new Response(null, { status: 204 });
    } catch (error) {
      return shareErrorResponse(error);
    }
  } catch (error) {
    return toErrorResponse(error);
  }
}
