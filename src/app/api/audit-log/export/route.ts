// GET /api/audit-log/export (admins and owners) — the workspace's audit trail as CSV.
//   Query: q, category, actor, action, from, to (as GET /api/audit-log; cursor and limit are ignored).
//   200 text/csv attachment, newest first, at most AUDIT_EXPORT_MAX rows (X-Truncated: 1 when more matched);
//   400 invalid query. Same fixed projection as the viewer; the export is itself audited.

import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { tenantOf } from '@/lib/audience/http';
import { AuditQueryError, exportAuditLogCsv, parseAuditQuery } from '@/lib/audit/audit-log';
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit';
import { NextResponse } from 'next/server';

export async function GET(request: Request) {
  try {
    const ctx = await requireRole('admin');
    const limit = checkRateLimit(`auditLogExport:${ctx.userId}`, RATE_LIMITS.adminAction);
    if (!limit.success) return rateLimitResponse(limit);
    const params = new URL(request.url).searchParams;
    params.delete('cursor');
    params.delete('limit');
    const { q, category, actor, action, from, to } = parseAuditQuery(params);
    const result = await exportAuditLogCsv(tenantOf(ctx), { q, category, actor, action, from, to });
    const day = new Date().toISOString().slice(0, 10);
    return new Response(result.csv, {
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="audit-log-${day}.csv"`,
        'Cache-Control': 'private, no-store',
        'X-Content-Type-Options': 'nosniff',
        'X-Rows': String(result.rows),
        ...(result.truncated ? { 'X-Truncated': '1' } : {}),
      },
    });
  } catch (error) {
    if (error instanceof AuditQueryError) return NextResponse.json({ error: 'Invalid audit log query', code: 'invalid_query' }, { status: 400 });
    return toErrorResponse(error);
  }
}
