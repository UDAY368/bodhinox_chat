// GET /api/meta-ads/pages — admin, ad management on. The Facebook Pages the
// connected login manages, to run a new ad from another Page: { pages: [{ id,
// name, connected }] } (never Page tokens). Click-to-Instagram and lead form ads
// stay on the connected Page. 503 meta_ads_not_enabled / manage_not_enabled,
// 403, 404 not_connected, 409 token_invalid, 429, 502.

import { NextResponse } from 'next/server';
import { requireSession } from '@/lib/auth/session';
import { metaAdsConfig, metaAdsManageEnabled } from '@/lib/meta-ads/config';
import { listAdPages } from '@/lib/meta-ads/create';
import { actorOf, metaAdsErrorResponse, metaAdsRouteError, notEnabledResponse, NO_STORE } from '@/lib/meta-ads/http';
import { checkRateLimit, rateLimitResponse } from '@/lib/rate-limit';

export const runtime = 'nodejs';
const LIMIT = { limit: 30, windowMs: 60_000 };

export async function GET(request: Request) {
  try {
    if (!metaAdsConfig()) return notEnabledResponse();
    if (!metaAdsManageEnabled()) return metaAdsErrorResponse('manage_not_enabled');
    const session = await requireSession(request);
    const limit = checkRateLimit(`metaAdsPages:${session.userId}`, LIMIT);
    if (!limit.success) return rateLimitResponse(limit);
    return NextResponse.json({ pages: await listAdPages(actorOf(session)) }, { headers: NO_STORE });
  } catch (error) {
    return metaAdsRouteError(error);
  }
}
