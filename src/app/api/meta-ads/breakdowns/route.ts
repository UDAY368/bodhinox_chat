// GET /api/meta-ads/breakdowns?from&to&breakdown=age_gender|region|device|placement[&adAccountId][&objectId]
// — any member. One range's results split by age and gender, region, device
// or placement, read from Meta with the workspace's login for a linked ad
// account (the primary one by default) or a stored campaign, ad set or ad.
// 200 { currency, rows: [{ dims, spend, impressions, clicks, linkClicks,
// conversationsStarted, leads, purchases }] }. 503 meta_ads_not_enabled,
// 400 invalid_request, 404 not_connected / not_found, 409 token_invalid, 429, 502.

import { NextResponse } from 'next/server';
import { requireSession } from '@/lib/auth/session';
import { metaAdsConfig } from '@/lib/meta-ads/config';
import { getBreakdowns, parseBreakdownQuery } from '@/lib/meta-ads/reports';
import { actorOf, metaAdsErrorResponse, metaAdsRouteError, notEnabledResponse, NO_STORE } from '@/lib/meta-ads/http';
import { checkRateLimit, rateLimitResponse } from '@/lib/rate-limit';

export const runtime = 'nodejs';
/** Each view is a live Meta read (cached 15 minutes). */
const LIMIT = { limit: 30, windowMs: 60_000 };

export async function GET(request: Request) {
  try {
    if (!metaAdsConfig()) return notEnabledResponse();
    const session = await requireSession(request);
    const query = parseBreakdownQuery(new URL(request.url).searchParams);
    if (!query) return metaAdsErrorResponse('invalid_request');
    const limit = checkRateLimit(`metaAdsBreakdowns:${session.userId}`, LIMIT);
    if (!limit.success) return rateLimitResponse(limit);
    return NextResponse.json(await getBreakdowns(actorOf(session), query), { headers: NO_STORE });
  } catch (error) {
    return metaAdsRouteError(error);
  }
}
