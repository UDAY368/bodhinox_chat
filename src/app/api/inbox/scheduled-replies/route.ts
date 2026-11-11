// GET  /api/inbox/scheduled-replies?conversation_id= — the conversation's scheduled replies that still matter (any member).
//   200 { scheduled_replies: ScheduledReply[] }
// POST /api/inbox/scheduled-replies — { conversation_id, content, send_at } (agent or above).
//   201 { scheduled_reply }, answered only after the row is stored.
//   400 empty | tooLong | tooLongInstagram | past | tooFarWhatsapp | tooFarInstagram | invalid_request;
//   404 notFound; 409 windowClosed | humanAgentOff (Instagram) or an Instagram account refusal; 503 instagram_not_enabled.
// The channel comes from the conversation row, never from the client.

import { NextResponse } from 'next/server';

import { requireRole } from '@/lib/auth/account';
import { tenantOf } from '@/lib/audience/http';
import {
  createScheduledReply,
  listScheduledReplies,
  parseScheduleCreate,
  scheduledReplyErrorResponse,
  scheduledReplyHeaders,
  SCHEDULED_REPLY_WRITE_LIMIT,
} from '@/lib/inbox/scheduled-replies';
import { manualRepliesBlocked } from '@/lib/platform/lifecycle';
import { checkRateLimit, rateLimitResponse } from '@/lib/rate-limit';

export async function GET(request: Request) {
  try {
    const ctx = await requireRole('viewer');
    const conversationId = new URL(request.url).searchParams.get('conversation_id') ?? '';
    const scheduled = await listScheduledReplies(tenantOf(ctx), conversationId);
    return NextResponse.json({ scheduled_replies: scheduled }, { headers: scheduledReplyHeaders });
  } catch (error) {
    return scheduledReplyErrorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    const ctx = await requireRole('agent');
    const limit = checkRateLimit(`inbox:scheduled:${ctx.userId}`, SCHEDULED_REPLY_WRITE_LIMIT);
    if (!limit.success) return rateLimitResponse(limit);
    // A platform admin may block manual replies for a workspace (abuse); a scheduled one is a manual reply.
    if (await manualRepliesBlocked({ accountId: ctx.accountId, userId: ctx.userId, role: ctx.role }))
      return NextResponse.json({ error: 'workspace_manual_blocked', code: 'workspace_manual_blocked' }, { status: 403, headers: scheduledReplyHeaders });
    const input = parseScheduleCreate(await request.json().catch(() => null));
    const created = await createScheduledReply(tenantOf(ctx), input);
    return NextResponse.json({ scheduled_reply: created }, { status: 201, headers: scheduledReplyHeaders });
  } catch (error) {
    return scheduledReplyErrorResponse(error);
  }
}
