// PATCH /api/inbox/scheduled-replies/:id (agent or above), one of:
//   { status: 'cancelled' }          cancel while pending (the creator or an admin)
//   { content?, send_at? }           change the text or time while pending (the creator or an admin)
//   { reconcile: 'sent' | 'failed' } say what happened to a reply whose outcome was ambiguous ('unknown');
//                                    never re-sends
//   200 { scheduled_reply }; 400 invalid_request | the schedule refusals of POST; 404 notFound;
//   409 notPending (already claimed, sent or cancelled; or not 'unknown' for reconcile).

import { NextResponse } from 'next/server';

import { requireRole } from '@/lib/auth/account';
import { tenantOf } from '@/lib/audience/http';
import {
  parseScheduledReplyPatch,
  reconcileScheduledReply,
  scheduledReplyErrorResponse,
  scheduledReplyHeaders,
  SCHEDULED_REPLY_WRITE_LIMIT,
  updateScheduledReply,
} from '@/lib/inbox/scheduled-replies';
import { checkRateLimit, rateLimitResponse } from '@/lib/rate-limit';

type Params = { params: Promise<{ id: string }> };

export async function PATCH(request: Request, { params }: Params) {
  try {
    const { id } = await params;
    const ctx = await requireRole('agent');
    const limit = checkRateLimit(`inbox:scheduled:${ctx.userId}`, SCHEDULED_REPLY_WRITE_LIMIT);
    if (!limit.success) return rateLimitResponse(limit);
    const patch = parseScheduledReplyPatch(await request.json().catch(() => null));
    const row = patch.kind === 'reconcile'
      ? await reconcileScheduledReply(tenantOf(ctx), id, patch.outcome)
      : await updateScheduledReply(tenantOf(ctx), id, patch);
    return NextResponse.json({ scheduled_reply: row }, { headers: scheduledReplyHeaders });
  } catch (error) {
    return scheduledReplyErrorResponse(error);
  }
}
