// POST /api/contacts/{id}/erase (admins and owners)
//   Queues the complete erasure of one contact (src/lib/privacy/contact-erasure.ts) and
//   audits the request, both before answering. The contact disappears once the worker
//   has run the job. 202 { queued: true }; 400 invalid_request; 401; 403 forbidden;
//   404 not_found; 429.
import { NextResponse } from 'next/server';
import { toErrorResponse } from '@/lib/auth/account';
import { hasMinRole } from '@/lib/auth/roles';
import { assertMutation, requireSession } from '@/lib/auth/session';
import { ContactErasureError, requestContactErasure } from '@/lib/privacy/contact-erasure';
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit';

const NO_STORE = { 'Cache-Control': 'no-store' };

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const session = await requireSession(request);
    await assertMutation(request, session);
    if (!hasMinRole(session.role, 'admin'))
      return NextResponse.json({ error: 'forbidden', code: 'forbidden' }, { status: 403, headers: NO_STORE });
    const limit = checkRateLimit(`contactErase:${session.userId}`, RATE_LIMITS.adminAction);
    if (!limit.success) return rateLimitResponse(limit);
    const { id } = await params;
    await requestContactErasure({ accountId: session.accountId, userId: session.userId, role: session.role }, id);
    return NextResponse.json({ queued: true }, { status: 202, headers: NO_STORE });
  } catch (error) {
    if (error instanceof ContactErasureError)
      return NextResponse.json({ error: error.code, code: error.code }, { status: error.status, headers: NO_STORE });
    return toErrorResponse(error);
  }
}
