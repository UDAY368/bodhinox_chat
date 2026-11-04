// GET /api/reports/shared/[shareId]/info — what a shared report is and until
// when it opens, for the share page. Same access rule as opening the share
// (live session in the share's workspace at the share's minimum role,
// unexpired, unrevoked), checked by crm_peek_report_share, but it counts no
// open and returns no file or storage key. Every refusal is the same 404.

import { NextResponse } from 'next/server';

import { toErrorResponse } from '@/lib/auth/account';
import { resolveSession } from '@/lib/auth/session';
import { peekShare, ShareError } from '@/lib/analytics/report-shares';
import { getT } from '@/lib/i18n/translate';
import { checkRateLimit, rateLimitResponse } from '@/lib/rate-limit';

const t = getT('Validation.analytics');
const PRIVATE = { 'Cache-Control': 'private, no-store' };

export async function GET(request: Request, { params }: { params: Promise<{ shareId: string }> }) {
  try {
    const { shareId } = await params;
    const session = await resolveSession(request);
    if (!session) return NextResponse.json({ error: t('shareNotFound') }, { status: 401, headers: PRIVATE });
    const limit = checkRateLimit(`reportShareInfo:${session.userId}`, { limit: 60, windowMs: 60_000 });
    if (!limit.success) return rateLimitResponse(limit);
    try {
      const share = await peekShare(session, shareId);
      return NextResponse.json({ share }, { headers: PRIVATE });
    } catch (error) {
      if (error instanceof ShareError) return NextResponse.json({ error: t('shareNotFound') }, { status: 404, headers: PRIVATE });
      throw error;
    }
  } catch (error) {
    return toErrorResponse(error);
  }
}
