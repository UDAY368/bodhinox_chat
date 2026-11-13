// GET /api/meta-ads/ads/daily?level=campaign|ad&id=<Meta object id> — any member.
// The last 14 days of one campaign's or ad's stored insights, for its detail
// drawer: { currency, points: [{ day, spend, impressions, clicks, conversations }] }.
// Reads stored rows of the caller's workspace only. 503 meta_ads_not_enabled, 400 invalid_request.

import { NextResponse } from 'next/server';
import { requireSession } from '@/lib/auth/session';
import { metaAdsConfig } from '@/lib/meta-ads/config';
import { actorOf, metaAdsErrorResponse, metaAdsRouteError, notEnabledResponse, NO_STORE } from '@/lib/meta-ads/http';
import { adDailySeries, parseDailyQuery } from '@/lib/meta-ads/daily';

export const runtime = 'nodejs';

export async function GET(request: Request) {
  try {
    if (!metaAdsConfig()) return notEnabledResponse();
    const session = await requireSession(request);
    const query = parseDailyQuery(new URL(request.url).searchParams);
    if (!query) return metaAdsErrorResponse('invalid_request');
    return NextResponse.json(await adDailySeries(actorOf(session), query.level, query.id), { headers: NO_STORE });
  } catch (error) {
    return metaAdsRouteError(error);
  }
}
