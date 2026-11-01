// GET /api/contacts/export[?segmentId=] — download contacts as CSV.
// Admin+ only (bulk personal data), rate limited and audit-logged.

import { NextResponse } from 'next/server';

import { requireRole } from '@/lib/auth/account';
import { exportContactsCsv } from '@/lib/audience/export';
import { audienceError, tenantOf } from '@/lib/audience/http';
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function GET(request: Request) {
  try {
    const ctx = await requireRole('admin');
    const limit = checkRateLimit(`admin:contactsExport:${ctx.userId}`, RATE_LIMITS.adminAction);
    if (!limit.success) return rateLimitResponse(limit);
    const segmentId = new URL(request.url).searchParams.get('segmentId');
    if (segmentId && !UUID.test(segmentId)) return NextResponse.json({ error: 'Segment not found' }, { status: 404 });
    const { csv } = await exportContactsCsv(tenantOf(ctx), segmentId || null);
    return new NextResponse(csv, {
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="contacts-${new Date().toISOString().slice(0, 10)}.csv"`,
        'Cache-Control': 'no-store',
      },
    });
  } catch (err) {
    return audienceError(err);
  }
}
