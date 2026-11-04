// GET /api/analytics/reports/[id]/download — streams one ready report (CSV or PDF).
// Signed-in admins and owners of the report's workspace only (the link in the
// "report ready" email lands here and needs a session). Every download is
// audit-logged before the file is sent; files are private, never cached and
// never served from a public URL. 404 unknown or another workspace's report,
// 409 not ready, failed or expired.

import { NextResponse } from 'next/server';

import { ForbiddenError, toErrorResponse } from '@/lib/auth/account';
import { hasMinRole } from '@/lib/auth/roles';
import { requireSession } from '@/lib/auth/session';
import { openReportDownload, ReportError } from '@/lib/analytics/reports';
import { getReportFile, reportContentType } from '@/lib/analytics/report-storage';
import { getT } from '@/lib/i18n/translate';
import { checkRateLimit, rateLimitResponse } from '@/lib/rate-limit';

const t = getT('Validation.analytics');

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const session = await requireSession(request);
    if (!hasMinRole(session.role, 'admin')) throw new ForbiddenError();
    const limit = checkRateLimit(`analyticsReportDownload:${session.userId}`, { limit: 30, windowMs: 60_000 });
    if (!limit.success) return rateLimitResponse(limit);
    const { id } = await params;
    let opened;
    try {
      opened = await openReportDownload(session, id);
    } catch (error) {
      if (error instanceof ReportError && error.code === 'not_found')
        return NextResponse.json({ error: t('reportNotFound') }, { status: 404 });
      if (error instanceof ReportError && error.code === 'not_ready')
        return NextResponse.json({ error: t('reportNotReady') }, { status: 409 });
      throw error;
    }
    const body = await getReportFile(session.accountId, opened.objectKey);
    return new Response(body, {
      headers: {
        'Content-Type': reportContentType(opened.format),
        'Content-Disposition': `attachment; filename="${opened.filename}"`,
        'Cache-Control': 'private, no-store',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  } catch (error) {
    return toErrorResponse(error);
  }
}
