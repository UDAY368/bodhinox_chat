// POST /api/inbox/conversations/bulk — one action on many conversations (agent and above).
//   { action: { type: 'assign', agentId: uuid | null } | { type: 'resolve' }
//             | { type: 'label', labelId } | { type: 'read' },
//     target: { ids: uuid[] (1..500) } | { query: '<list query parameters>' } }
//   ids: the ticked rows; ids the member may not act on (another workspace,
//   hidden by agent visibility, gone) are left alone and listed in refusedIds.
//   query: every conversation matching the list's filter, at most 5000 (400
//   too_many past that). Worked in chunks with an audit row each; the row
//   triggers send the same realtime events, notifications and handling log as
//   single edits.
//   200 { matched, changed, refusedIds }; 400 invalid_request | too_many;
//   401; 403 forbidden (viewer, or a failed Origin/CSRF check); 404 not_found
//   (unknown label); 429. Origin/CSRF is checked here as well as in src/proxy.ts.

import { NextResponse } from 'next/server';

import { toErrorResponse } from '@/lib/auth/account';
import { hasMinRole } from '@/lib/auth/roles';
import { assertMutation, requireSession } from '@/lib/auth/session';
import { BulkConversationError, bulkConversationAction } from '@/lib/inbox/bulk-actions';
import { ConversationActionError } from '@/lib/inbox/conversation-actions';
import { checkRateLimit, rateLimitResponse } from '@/lib/rate-limit';

const NO_STORE = { 'Cache-Control': 'private, no-store' };

export async function POST(request: Request) {
  try {
    const session = await requireSession(request);
    await assertMutation(request, session);
    if (!hasMinRole(session.role, 'agent'))
      return NextResponse.json({ error: 'forbidden', code: 'forbidden' }, { status: 403, headers: NO_STORE });
    const limit = await checkRateLimit(`inboxBulk:${session.userId}`, { limit: 20, windowMs: 60_000 });
    if (!limit.success) return rateLimitResponse(limit);
    const body = await request.json().catch(() => null);
    const result = await bulkConversationAction({ accountId: session.accountId, userId: session.userId, role: session.role }, body);
    return NextResponse.json(result, { headers: NO_STORE });
  } catch (error) {
    if (error instanceof BulkConversationError)
      return NextResponse.json({ error: error.code, code: error.code, ...(error.matched ? { matched: error.matched } : {}) }, { status: error.status, headers: NO_STORE });
    if (error instanceof ConversationActionError)
      return NextResponse.json({ error: error.code, code: error.code }, { status: error.status, headers: NO_STORE });
    return toErrorResponse(error);
  }
}
