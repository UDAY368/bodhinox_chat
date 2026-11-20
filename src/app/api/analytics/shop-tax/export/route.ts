// GET /api/analytics/shop-tax/export?preset=&from=&to= — the GST report as a CSV download (admins and owners). Every cell goes
//   through the same formula guard as the orders export. Same range rules as the report (at most 366 days).

import { NextResponse } from 'next/server';
import { ForbiddenError, toErrorResponse } from '@/lib/auth/account';
import { hasMinRole } from '@/lib/auth/roles';
import { requireSession } from '@/lib/auth/session';
import { ANALYTICS_RATE_LIMIT } from '@/lib/analytics/http';
import { runAnalytics } from '@/lib/analytics/queries';
import { AnalyticsRangeError, parseRange, rangeInputFromSearchParams } from '@/lib/analytics/range';
import { taxReport, taxReportCsv } from '@/lib/commerce/shop-reports';
import { checkRateLimit, rateLimitResponse } from '@/lib/rate-limit';

export async function GET(request: Request) {
  try {
    const session = await requireSession(request);
    if (!hasMinRole(session.role, 'admin')) throw new ForbiddenError('Insufficient workspace role');
    const limit = await checkRateLimit(`analytics:${session.userId}`, ANALYTICS_RATE_LIMIT);
    if (!limit.success) return rateLimitResponse(limit);
    const params = new URL(request.url).searchParams;
    const { csv, startDay, endDay } = await runAnalytics({ accountId: session.accountId, userId: session.userId, role: session.role }, async (tx, timezone) => {
      const range = parseRange(rangeInputFromSearchParams(params), timezone);
      return { csv: taxReportCsv(await taxReport(tx, session.accountId, range)), startDay: range.startDay, endDay: range.endDay };
    });
    return new NextResponse(csv, {
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="gst-${startDay}-to-${endDay}.csv"`,
        'Cache-Control': 'private, no-store',
      },
    });
  } catch (error) {
    if (error instanceof AnalyticsRangeError) return NextResponse.json({ error: 'Invalid range' }, { status: 400 });
    return toErrorResponse(error);
  }
}
