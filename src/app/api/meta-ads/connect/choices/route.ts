// GET /api/meta-ads/connect/choices — admin. The ad accounts and Pages the
// pending connection's Facebook user can pick from: { adAccounts, pages }
// (ids and names only; Page tokens stay on the server).
// 503 meta_ads_not_enabled, 404 not_connected (no pending connection),
// 409 token_invalid, 502 meta_error.

import { NextResponse } from 'next/server';
import { ForbiddenError } from '@/lib/auth/account';
import { hasMinRole } from '@/lib/auth/roles';
import { requireSession } from '@/lib/auth/session';
import { metaAdsConfig } from '@/lib/meta-ads/config';
import { listChoices } from '@/lib/meta-ads/connection';
import { actorOf, metaAdsRouteError, notEnabledResponse, NO_STORE } from '@/lib/meta-ads/http';
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit';

export const runtime = 'nodejs';

export async function GET(request: Request) {
  try {
    if (!metaAdsConfig()) return notEnabledResponse();
    const session = await requireSession(request);
    if (!hasMinRole(session.role, 'admin')) throw new ForbiddenError();
    const limit = checkRateLimit(`metaAdsChoices:${session.userId}`, RATE_LIMITS.adminAction);
    if (!limit.success) return rateLimitResponse(limit);
    return NextResponse.json(await listChoices(actorOf(session)), { headers: NO_STORE });
  } catch (error) {
    return metaAdsRouteError(error);
  }
}
