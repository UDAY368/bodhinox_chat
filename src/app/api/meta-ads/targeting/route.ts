// GET /api/meta-ads/targeting?type=interest|place|locale&q=... — admin.
// Meta's targeting search for the Create ad dialog: interests, cities and
// regions, or languages. 200 { options }. 503 meta_ads_not_enabled /
// manage_not_enabled, 400 invalid_request, 403, 404 not_connected, 409 token_invalid, 429, 502.

import { NextResponse } from 'next/server';
import { requireSession } from '@/lib/auth/session';
import { metaAdsConfig } from '@/lib/meta-ads/config';
import { searchAdTargeting } from '@/lib/meta-ads/create';
import { TARGETING_SEARCH_TYPES, type TargetingSearchType } from '@/lib/meta-ads/graph';
import { actorOf, metaAdsErrorResponse, metaAdsRouteError, notEnabledResponse, NO_STORE } from '@/lib/meta-ads/http';
import { checkRateLimit, rateLimitResponse } from '@/lib/rate-limit';

export const runtime = 'nodejs';
/** Typing in a search box: a generous but bounded rate per user. */
const SEARCH_LIMIT = { limit: 120, windowMs: 60_000 };

export async function GET(request: Request) {
  try {
    if (!metaAdsConfig()) return notEnabledResponse();
    const session = await requireSession(request);
    const limit = await checkRateLimit(`metaAdsTargeting:${session.userId}`, SEARCH_LIMIT);
    if (!limit.success) return rateLimitResponse(limit);
    const params = new URL(request.url).searchParams;
    const type = params.get('type') as TargetingSearchType;
    const q = params.get('q') ?? '';
    if (!TARGETING_SEARCH_TYPES.includes(type) || q.length > 100) return metaAdsErrorResponse('invalid_request');
    return NextResponse.json({ options: await searchAdTargeting(actorOf(session), type, q) }, { headers: NO_STORE });
  } catch (error) {
    return metaAdsRouteError(error);
  }
}
