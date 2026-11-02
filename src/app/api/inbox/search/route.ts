// GET /api/inbox/search?q=&whatsapp_config_id=&status=&assignee=&from=&to=&cursor=&limit=
//   Any member who can read conversations (viewer+), rate limited per user.
//   q: 1..200 chars after trimming. status: open|pending|closed. assignee: me|unassigned|<user uuid>.
//   from/to: ISO 8601 datetimes, from inclusive, to exclusive. limit: 1..50 (default 20).
//   200 { results: [{ message_id, conversation_id, snippet, created_at, contact_name }], next_cursor, mode }
//   snippet marks matches with U+E000 … U+E001 (src/lib/inbox/search-snippet.ts); render it as text.
//   contact_name falls back to the contact's number, masked for members whose numbers are masked.
//   400 bad input; 429 rate limited; 503 the search took too long.
// Customer content and the query are never logged.

import { NextResponse } from 'next/server';

import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { tenantOf } from '@/lib/audience/http';
import { withTenant } from '@/lib/db/tenant';
import { getT } from '@/lib/i18n/translate';
import { checkRateLimit, rateLimitResponse } from '@/lib/rate-limit';
import {
  INBOX_SEARCH_RATE_LIMIT,
  InboxSearchError,
  parseInboxSearchParams,
  searchInboxMessages,
} from '@/lib/inbox/search';

const t = getT('Api.inboxSearch');

function isStatementTimeout(error: unknown): boolean {
  const e = error as { code?: unknown; meta?: { code?: unknown }; message?: unknown };
  return e?.code === '57014' || e?.meta?.code === '57014'
    || (typeof e?.message === 'string' && e.message.includes('statement timeout'));
}

export async function GET(request: Request) {
  try {
    const ctx = await requireRole('viewer');
    const limit = checkRateLimit(`inbox-search:${ctx.userId}`, INBOX_SEARCH_RATE_LIMIT);
    if (!limit.success) return rateLimitResponse(limit);
    const input = parseInboxSearchParams(new URL(request.url).searchParams, ctx.userId);
    const result = await withTenant(tenantOf(ctx), (tx) =>
      searchInboxMessages(tx, { accountId: ctx.accountId, userId: ctx.userId, role: ctx.role }, input));
    return NextResponse.json(result, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    if (error instanceof InboxSearchError) return NextResponse.json({ error: error.message }, { status: 400 });
    if (isStatementTimeout(error)) return NextResponse.json({ error: t('timeout') }, { status: 503 });
    return toErrorResponse(error);
  }
}
