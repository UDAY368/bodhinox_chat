// GET /api/meta-ads/quality?from&to[&adAccountId] — any member. Chat quality
// per ad from Bodhinox's own records: chats started from the ad, chats
// answered, deals opened after the ad click and deals won, beside the ad's
// stored spend. Reads the caller's workspace only, in their own tenant scope.
// 200 { rows }. 503 meta_ads_not_enabled, 400 invalid_request.

import { NextResponse } from 'next/server';
import { requireSession } from '@/lib/auth/session';
import { metaAdsConfig } from '@/lib/meta-ads/config';
import { chatQuality, parseQualityQuery } from '@/lib/meta-ads/reports';
import { actorOf, metaAdsErrorResponse, metaAdsRouteError, notEnabledResponse, NO_STORE } from '@/lib/meta-ads/http';

export const runtime = 'nodejs';

export async function GET(request: Request) {
  try {
    if (!metaAdsConfig()) return notEnabledResponse();
    const session = await requireSession(request);
    const query = parseQualityQuery(new URL(request.url).searchParams);
    if (!query) return metaAdsErrorResponse('invalid_request');
    return NextResponse.json({ rows: await chatQuality(actorOf(session), query) }, { headers: NO_STORE });
  } catch (error) {
    return metaAdsRouteError(error);
  }
}
