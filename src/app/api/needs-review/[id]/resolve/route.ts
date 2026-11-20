// POST /api/needs-review/[id]/resolve { action: 'was_sent' | 'send_again' } (admins and owners;
//   Origin + CSRF proof). 'was_sent' marks the uncertain send delivered (nothing sends it again);
//   'send_again' retires it and queues its job once more (src/lib/needs-review/review.ts).
//   200 { id, action, requeued }; 400 invalid_request; 404 not_found (also another workspace's id);
//   409 not_open (already resolved, or its job is sending right now).
import { NextResponse } from 'next/server';

import { ForbiddenError, toErrorResponse } from '@/lib/auth/account';
import { hasMinRole } from '@/lib/auth/roles';
import { assertMutation, requireSession } from '@/lib/auth/session';
import { isNeedsReviewAction, NeedsReviewError, resolveNeedsReview } from '@/lib/needs-review/review';
import { checkRateLimit, rateLimitResponse } from '@/lib/rate-limit';

type Context = { params: Promise<{ id: string }> };

export async function POST(request: Request, context: Context) {
  try {
    const session = await requireSession(request);
    await assertMutation(request, session);
    if (!hasMinRole(session.role, 'admin')) throw new ForbiddenError('Reviewing sends requires an admin role');
    const limit = checkRateLimit(`needsReview:resolve:${session.userId}`, { limit: 60, windowMs: 60_000 });
    if (!limit.success) return rateLimitResponse(limit);
    const { id } = await context.params;
    const body = (await request.json().catch(() => null)) as { action?: unknown } | null;
    const action = body && typeof body === 'object' && !Array.isArray(body) ? body.action : undefined;
    if (!isNeedsReviewAction(action))
      return NextResponse.json({ error: 'Invalid request', code: 'invalid_request' }, { status: 400 });
    const result = await resolveNeedsReview({ accountId: session.accountId, userId: session.userId, role: session.role }, id, action);
    return NextResponse.json(result, { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (error) {
    if (error instanceof NeedsReviewError) return NextResponse.json({ error: error.code, code: error.code }, { status: error.status });
    return toErrorResponse(error);
  }
}
