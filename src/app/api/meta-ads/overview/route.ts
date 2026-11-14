// GET /api/meta-ads/overview?from=YYYY-MM-DD&to=YYYY-MM-DD&adAccountId=<id|all> —
// any member. The Ads Overview for the range (default: the last 30 days, at
// most 92): totals, reach for Meta's fixed ranges, the daily trend, the split
// by platform and the top campaigns. Reads stored data only.
// 503 meta_ads_not_enabled, 400 invalid_request.

import { NextResponse } from 'next/server';
import { requireSession } from '@/lib/auth/session';
import { metaAdsConfig } from '@/lib/meta-ads/config';
import { actorOf, metaAdsErrorResponse, metaAdsRouteError, notEnabledResponse, NO_STORE } from '@/lib/meta-ads/http';
import { parseAdsQuery } from '@/lib/meta-ads/insights';
import { getAdsOverview } from '@/lib/meta-ads/overview';

export const runtime = 'nodejs';

export async function GET(request: Request) {
  try {
    if (!metaAdsConfig()) return notEnabledResponse();
    const session = await requireSession(request);
    const query = parseAdsQuery(new URL(request.url).searchParams);
    if (!query) return metaAdsErrorResponse('invalid_request');
    return NextResponse.json(await getAdsOverview(actorOf(session), query), { headers: NO_STORE });
  } catch (error) {
    return metaAdsRouteError(error);
  }
}
