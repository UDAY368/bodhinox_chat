// GET /api/audit-log (admins and owners) — the workspace's audit trail, newest first.
//   Query: actor (user id), action (exact, or a prefix ending in '.'), from/to (ISO),
//   cursor (from next_cursor), limit (1-100, default 50).
//   200 { entries: [{ id, action, actor: { user_id, name } | null, resource_id, metadata, created_at }],
//         next_cursor, actions? (first page only) }; 400 invalid query.
//   metadata carries identifiers and counts only; never secrets or message content.

import { NextResponse } from 'next/server';

import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { tenantOf } from '@/lib/audience/http';
import { AuditQueryError, listAuditLog, parseAuditQuery } from '@/lib/audit/audit-log';
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit';

export async function GET(request: Request) {
  try {
    const ctx = await requireRole('admin');
    const limit = checkRateLimit(`auditLog:${ctx.userId}`, RATE_LIMITS.send);
    if (!limit.success) return rateLimitResponse(limit);
    const query = parseAuditQuery(new URL(request.url).searchParams);
    return NextResponse.json(await listAuditLog(tenantOf(ctx), query), { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (error) {
    if (error instanceof AuditQueryError) return NextResponse.json({ error: 'Invalid audit log query', code: 'invalid_query' }, { status: 400 });
    return toErrorResponse(error);
  }
}
