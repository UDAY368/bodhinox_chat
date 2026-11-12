// POST /api/meta-ads/manage/changes/{id}/recheck — admin. Reads the object of
// a change whose outcome is unknown back from Meta (never sends anything):
// 200 { change } with status 'applied' when Meta shows the new value, still
// 'unknown' otherwise. 404 not_found (also another workspace's id),
// 400 invalid_request when the change is not unknown, 502 meta_error.

import { NextResponse } from 'next/server';
import { hasMinRole } from '@/lib/auth/roles';
import { assertMutation, requireSession } from '@/lib/auth/session';
import { metaAdsConfig } from '@/lib/meta-ads/config';
import { actorOf, metaAdsErrorResponse, metaAdsRouteError, notEnabledResponse, NO_STORE } from '@/lib/meta-ads/http';
import { recheckAdChange } from '@/lib/meta-ads/manage';
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit';

export const runtime = 'nodejs';
type Context = { params: Promise<{ id: string }> };

export async function POST(request: Request, context: Context) {
  try {
    if (!metaAdsConfig()) return notEnabledResponse();
    const { id } = await context.params;
    const session = await requireSession(request);
    await assertMutation(request, session);
    if (!hasMinRole(session.role, 'admin')) return metaAdsErrorResponse('forbidden');
    const limit = checkRateLimit(`metaAdsRecheck:${session.userId}`, RATE_LIMITS.adminAction);
    if (!limit.success) return rateLimitResponse(limit);
    return NextResponse.json({ change: await recheckAdChange(actorOf(session), id) }, { headers: NO_STORE });
  } catch (error) {
    return metaAdsRouteError(error);
  }
}
