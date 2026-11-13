// POST /api/conversations/{id}/unread — { unread: boolean } (agent and above).
//   unread: true keeps at least one unread message on the conversation so it
//   shows as unread in every member's list; false marks it read. 200 { unread_count }.
//   Another workspace's id, or a conversation the member cannot see, is 404.

import { NextResponse } from 'next/server';

import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { tenantOf } from '@/lib/audience/http';
import { withTenant } from '@/lib/db/tenant';
import { ConversationActionError, setConversationUnread } from '@/lib/inbox/conversation-actions';
import { checkRateLimit, rateLimitResponse } from '@/lib/rate-limit';

type Context = { params: Promise<{ id: string }> };
const NO_STORE = { 'Cache-Control': 'private, no-store' };

export async function POST(request: Request, context: Context) {
  try {
    const ctx = await requireRole('agent');
    const { id } = await context.params;
    const limit = checkRateLimit(`conversationUnread:${ctx.userId}`, { limit: 120, windowMs: 60_000 });
    if (!limit.success) return rateLimitResponse(limit);
    const body = (await request.json().catch(() => null)) as { unread?: unknown } | null;
    if (typeof body?.unread !== 'boolean')
      return NextResponse.json({ error: 'invalid_request' }, { status: 400, headers: NO_STORE });
    const unread = body.unread;
    const count = await withTenant(tenantOf(ctx), (tx) => setConversationUnread(tx, ctx.accountId, id, unread));
    return NextResponse.json({ unread_count: count }, { headers: NO_STORE });
  } catch (error) {
    if (error instanceof ConversationActionError)
      return NextResponse.json({ error: error.code }, { status: error.status, headers: NO_STORE });
    return toErrorResponse(error);
  }
}
