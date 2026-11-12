// POST /api/meta-ads/manage/changes { objectId, field, value } — admin.
//   field: status (ACTIVE | PAUSED), daily_budget / lifetime_budget (minor units
//   of the ad account currency), end_time (ISO, ad sets only) or name.
// Records the change and queues its meta.ad_change job in one transaction;
// 202 { change } follows the commit, and the worker applies it at Meta.
// 503 meta_ads_not_enabled / manage_not_enabled, 400 invalid_request,
// 404 not_connected / not_found, 409 change_pending / missing_scope /
// token_invalid, 422 over_budget_cap (the workspace's daily budget cap).

import { NextResponse } from 'next/server';
import { hasMinRole } from '@/lib/auth/roles';
import { assertMutation, requireSession } from '@/lib/auth/session';
import { metaAdsConfig, metaAdsManageEnabled } from '@/lib/meta-ads/config';
import { actorOf, metaAdsErrorResponse, metaAdsRouteError, notEnabledResponse, NO_STORE } from '@/lib/meta-ads/http';
import { parseAdChangeInput, requestAdChange } from '@/lib/meta-ads/manage';
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit';

export const runtime = 'nodejs';

export async function POST(request: Request) {
  try {
    if (!metaAdsConfig()) return notEnabledResponse();
    if (!metaAdsManageEnabled()) return metaAdsErrorResponse('manage_not_enabled');
    const session = await requireSession(request);
    await assertMutation(request, session);
    if (!hasMinRole(session.role, 'admin')) return metaAdsErrorResponse('forbidden');
    const limit = checkRateLimit(`metaAdsChange:${session.userId}`, RATE_LIMITS.adminAction);
    if (!limit.success) return rateLimitResponse(limit);
    const input = parseAdChangeInput(await request.json().catch(() => null));
    if (!input) return metaAdsErrorResponse('invalid_request');
    const change = await requestAdChange(actorOf(session), input);
    return NextResponse.json({ change }, { status: 202, headers: NO_STORE });
  } catch (error) {
    return metaAdsRouteError(error);
  }
}
