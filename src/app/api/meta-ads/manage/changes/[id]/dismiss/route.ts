// POST /api/meta-ads/manage/changes/{id}/dismiss — admin. Closes a change whose
// outcome is unknown after the admin checked Ads Manager; a new change to the
// same field can then be asked for. Never calls Meta. Audit
// meta_ads.change_dismiss. 200 { change }; 404 not_found; 400 invalid_request
// when the change is not unknown.

import { NextResponse } from 'next/server';
import { hasMinRole } from '@/lib/auth/roles';
import { assertMutation, requireSession } from '@/lib/auth/session';
import { metaAdsConfig } from '@/lib/meta-ads/config';
import { actorOf, metaAdsErrorResponse, metaAdsRouteError, notEnabledResponse, NO_STORE } from '@/lib/meta-ads/http';
import { dismissAdChange } from '@/lib/meta-ads/manage';
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
    const limit = checkRateLimit(`metaAdsDismiss:${session.userId}`, RATE_LIMITS.adminAction);
    if (!limit.success) return rateLimitResponse(limit);
    return NextResponse.json({ change: await dismissAdChange(actorOf(session), id) }, { headers: NO_STORE });
  } catch (error) {
    return metaAdsRouteError(error);
  }
}
