// GET /api/meta-ads/ads?level=campaign|ad&from=YYYY-MM-DD&to=YYYY-MM-DD — any
// member. Stored daily insights summed over the range (default: the last 30
// days, at most 92), with conversations Bodhinox saw start from each ad and the
// attributed Purchase events: { rows, insightsSyncedAt }. Reads stored data only.
// 503 meta_ads_not_enabled, 400 invalid_request.

import { NextResponse } from 'next/server';
import { requireSession } from '@/lib/auth/session';
import { metaAdsConfig } from '@/lib/meta-ads/config';
import { actorOf, metaAdsErrorResponse, metaAdsRouteError, notEnabledResponse, NO_STORE } from '@/lib/meta-ads/http';
import { listAdsWithInsights, parseAdsQuery } from '@/lib/meta-ads/insights';

export const runtime = 'nodejs';

export async function GET(request: Request) {
  try {
    if (!metaAdsConfig()) return notEnabledResponse();
    const session = await requireSession(request);
    const query = parseAdsQuery(new URL(request.url).searchParams);
    if (!query) return metaAdsErrorResponse('invalid_request');
    return NextResponse.json(await listAdsWithInsights(actorOf(session), query), { headers: NO_STORE });
  } catch (error) {
    return metaAdsRouteError(error);
  }
}
