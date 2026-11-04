// GET /api/reports/shared/[shareId] — opens a shared report.
//
// No token: the caller needs a live session in the share's workspace whose
// live role meets the share's minimum role, and the share and its report must
// be unexpired and unrevoked. crm_open_report_share checks all of that in SQL
// and counts the open; the open is audit-logged. Without a session a
// top-level navigation is sent to sign in and returns to the share page; a
// fetch (the share page's Download button) gets 401, so authFetch refreshes
// the access token and retries instead of following the redirect and saving
// the sign-in page as the report. Every failure,
// including a malformed id or a share of another workspace, is the same 404.
// The file is streamed privately (never cached, no referrer, attachment only).

import { NextResponse } from 'next/server';

import { toErrorResponse } from '@/lib/auth/account';
import { resolveSession } from '@/lib/auth/session';
import { openShare, ShareError } from '@/lib/analytics/report-shares';
import { getReportFile, reportContentType } from '@/lib/analytics/report-storage';
import { getT } from '@/lib/i18n/translate';
import { checkRateLimit, rateLimitResponse } from '@/lib/rate-limit';

const t = getT('Validation.analytics');
const tApi = getT('Api');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PRIVATE = { 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' };

export async function GET(request: Request, { params }: { params: Promise<{ shareId: string }> }) {
  try {
    const { shareId } = await params;
    const session = await resolveSession(request);
    if (!session) {
      if (request.headers.get('sec-fetch-mode') !== 'navigate')
        return NextResponse.json({ error: tApi('common.unauthorized') }, { status: 401, headers: PRIVATE });
      const login = new URL('/login', request.url);
      // Only a well-formed id is echoed into the sign-in return path.
      if (UUID.test(shareId)) login.searchParams.set('next', `/reports/shared/${shareId.toLowerCase()}`);
      return NextResponse.redirect(login, { status: 303, headers: PRIVATE });
    }
    const limit = checkRateLimit(`reportShareOpen:${session.userId}`, { limit: 30, windowMs: 60_000 });
    if (!limit.success) return rateLimitResponse(limit);
    let opened;
    try {
      opened = await openShare(session, shareId);
    } catch (error) {
      if (error instanceof ShareError) return NextResponse.json({ error: t('shareNotFound') }, { status: 404, headers: PRIVATE });
      throw error;
    }
    const body = await getReportFile(session.accountId, opened.objectKey);
    return new Response(body, {
      headers: {
        ...PRIVATE,
        'Content-Type': reportContentType(opened.format),
        'Content-Disposition': `attachment; filename="${opened.filename}"`,
      },
    });
  } catch (error) {
    return toErrorResponse(error);
  }
}
