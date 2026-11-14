// GET /api/meta-ads/preview?adId=<id>&format=MOBILE_FEED_STANDARD|INSTAGRAM_STANDARD|INSTAGRAM_STORY|FACEBOOK_STORY_MOBILE
// — any member. Meta's own preview of an ad stored for this workspace:
// 200 { src } with the address of Meta's preview page on www.facebook.com
// (null when Meta has none for that format). 503 meta_ads_not_enabled,
// 400 invalid_request, 404 not_connected / not_found, 409 token_invalid, 429, 502.

import { NextResponse } from 'next/server';
import { requireSession } from '@/lib/auth/session';
import { metaAdsConfig } from '@/lib/meta-ads/config';
import { getStoredAdPreview, parsePreviewQuery } from '@/lib/meta-ads/reports';
import { actorOf, metaAdsErrorResponse, metaAdsRouteError, notEnabledResponse, NO_STORE } from '@/lib/meta-ads/http';
import { checkRateLimit, rateLimitResponse } from '@/lib/rate-limit';

export const runtime = 'nodejs';
const LIMIT = { limit: 30, windowMs: 60_000 };

export async function GET(request: Request) {
  try {
    if (!metaAdsConfig()) return notEnabledResponse();
    const session = await requireSession(request);
    const query = parsePreviewQuery(new URL(request.url).searchParams);
    if (!query) return metaAdsErrorResponse('invalid_request');
    const limit = checkRateLimit(`metaAdsPreview:${session.userId}`, LIMIT);
    if (!limit.success) return rateLimitResponse(limit);
    return NextResponse.json(await getStoredAdPreview(actorOf(session), query.adId, query.format), { headers: NO_STORE });
  } catch (error) {
    return metaAdsRouteError(error);
  }
}
