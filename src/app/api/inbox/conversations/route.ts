// GET /api/inbox/conversations — the inbox conversation list, filtered and paged
//   in SQL (src/lib/inbox/conversation-list.ts). Any member (viewer+); only the
//   conversations the member may see (agent visibility), numbers masked for a
//   masked member. The filter is the list query (inbox-filters.ts listQueryParams:
//   scope, filter, channel, number, agent, agentMode, tags, company, consent, q, session).
//   Three modes:
//   - a page: cursor= (from the previous page) and limit= (1..100, default 50).
//     200 { conversations, nextCursor, counts?, companies? }; counts and
//     companies come with the first page only.
//   - ids=<id,...> (at most 100): which of these conversations match now.
//   - since=<ISO time>: the conversations changed since then (at most 200);
//     with counts=1 the counts too.
//     Both answer 200 { conversations (matching rows), removedIds, overflow, counts? }.
//   400 bad cursor or ids; 429 rate limited; 503 the query took too long.
// Customer content and the search text are never logged.

import { NextResponse } from 'next/server';

import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { tenantOf } from '@/lib/audience/http';
import {
  InboxListError,
  countInboxConversations,
  listInboxConversations,
  matchInboxConversations,
} from '@/lib/inbox/conversation-list';
import { parseListQuery } from '@/lib/inbox/inbox-filters';
import { checkRateLimit, rateLimitResponse } from '@/lib/rate-limit';

const NO_STORE = { 'Cache-Control': 'private, no-store' };

function isStatementTimeout(error: unknown): boolean {
  const e = error as { code?: unknown; meta?: { code?: unknown }; message?: unknown };
  return e?.code === '57014' || e?.meta?.code === '57014'
    || (typeof e?.message === 'string' && e.message.includes('statement timeout'));
}

export async function GET(request: Request) {
  try {
    const ctx = await requireRole('viewer');
    // Pages, realtime checks and resyncs of a few open tabs fit well inside this.
    const limit = await checkRateLimit(`inbox-list:${ctx.userId}`, { limit: 240, windowMs: 60_000 });
    if (!limit.success) return rateLimitResponse(limit);
    const params = new URL(request.url).searchParams;
    const query = parseListQuery(params);
    const tenant = tenantOf(ctx);
    const ids = params.get('ids');
    const since = params.get('since');
    if (ids !== null)
      return NextResponse.json(await matchInboxConversations(tenant, query, { ids: ids.split(',') }), { headers: NO_STORE });
    if (since !== null) {
      const changes = await matchInboxConversations(tenant, query, { since });
      // counts=1: the resync also refreshes the view counts.
      const counts = params.get('counts') === '1' ? await countInboxConversations(tenant, query) : undefined;
      return NextResponse.json({ ...changes, ...(counts ? { counts } : {}) }, { headers: NO_STORE });
    }
    const pageSize = Number(params.get('limit') ?? '') || undefined;
    return NextResponse.json(await listInboxConversations(tenant, query, { cursor: params.get('cursor'), limit: pageSize }), { headers: NO_STORE });
  } catch (error) {
    if (error instanceof InboxListError) return NextResponse.json({ error: error.code }, { status: 400, headers: NO_STORE });
    if (isStatementTimeout(error)) return NextResponse.json({ error: 'timeout' }, { status: 503, headers: NO_STORE });
    return toErrorResponse(error);
  }
}
