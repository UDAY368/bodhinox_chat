// POST /api/meta-ads/connect { accessToken } — admin. Checks the Facebook Login
// for Business popup's user token belongs to this app, makes it long-lived and
// stores the workspace's pending connection (the encrypted token is never
// returned). 200 { connection }.
// 503 meta_ads_not_enabled (before anything else), 400 invalid_request,
// 409 already_connected, 409 token_invalid, 429 rate limited, 502 meta_error.

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { ForbiddenError } from '@/lib/auth/account';
import { hasMinRole } from '@/lib/auth/roles';
import { assertMutation, requireSession } from '@/lib/auth/session';
import { metaAdsConfig } from '@/lib/meta-ads/config';
import { startConnection } from '@/lib/meta-ads/connection';
import { actorOf, metaAdsErrorResponse, metaAdsRouteError, notEnabledResponse, NO_STORE } from '@/lib/meta-ads/http';
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit';

export const runtime = 'nodejs';
/** Each attempt is one login; a few per hour per workspace is plenty. */
const ACCOUNT_LIMIT = { limit: 10, windowMs: 60 * 60_000 };
const Body = z.object({ accessToken: z.string().trim().min(1).max(4096) }).strict();

export async function POST(request: Request) {
  try {
    if (!metaAdsConfig()) return notEnabledResponse();
    const session = await requireSession(request);
    await assertMutation(request, session);
    if (!hasMinRole(session.role, 'admin')) throw new ForbiddenError();
    const userLimit = checkRateLimit(`metaAdsConnect:${session.userId}`, RATE_LIMITS.adminAction);
    if (!userLimit.success) return rateLimitResponse(userLimit);
    const accountLimit = checkRateLimit(`metaAdsConnectAccount:${session.accountId}`, ACCOUNT_LIMIT);
    if (!accountLimit.success) return rateLimitResponse(accountLimit);
    const parsed = Body.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return metaAdsErrorResponse('invalid_request');
    const connection = await startConnection(actorOf(session), parsed.data.accessToken);
    return NextResponse.json({ connection }, { headers: NO_STORE });
  } catch (error) {
    return metaAdsRouteError(error);
  }
}
