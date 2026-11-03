// POST /api/meta-ads/ads/sync — admin. Queues a meta.insights_sync job for the
// active connection (at most one per 10 minutes; repeats are absorbed by the
// job's dedupe key). The job row commits before the 202 { queued: true }.
// 503 meta_ads_not_enabled, 404 not_connected.

import { NextResponse } from 'next/server';
import { ForbiddenError } from '@/lib/auth/account';
import { hasMinRole } from '@/lib/auth/roles';
import { assertMutation, requireSession } from '@/lib/auth/session';
import { metaAdsConfig } from '@/lib/meta-ads/config';
import { actorOf, metaAdsErrorResponse, metaAdsRouteError, notEnabledResponse, NO_STORE } from '@/lib/meta-ads/http';
import { queueInsightsSync } from '@/lib/meta-ads/insights';
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit';

export const runtime = 'nodejs';

export async function POST(request: Request) {
  try {
    if (!metaAdsConfig()) return notEnabledResponse();
    const session = await requireSession(request);
    await assertMutation(request, session);
    if (!hasMinRole(session.role, 'admin')) throw new ForbiddenError();
    const limit = checkRateLimit(`metaAdsSync:${session.userId}`, RATE_LIMITS.adminAction);
    if (!limit.success) return rateLimitResponse(limit);
    if (!(await queueInsightsSync(actorOf(session)))) return metaAdsErrorResponse('not_connected');
    return NextResponse.json({ queued: true }, { status: 202, headers: NO_STORE });
  } catch (error) {
    return metaAdsRouteError(error);
  }
}
