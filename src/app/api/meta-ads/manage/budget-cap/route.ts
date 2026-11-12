// PUT /api/meta-ads/manage/budget-cap { maxDailyBudget: minor units | null } — admin.
// Sets or clears the workspace's maximum daily budget: Bodhinox refuses any
// budget change, or resume, that would spend more per day. It does not change
// anything at Meta. Audit meta_ads.budget_cap. 200 { maxDailyBudget };
// 400 invalid_request; 404 not_connected.

import { NextResponse } from 'next/server';
import { hasMinRole } from '@/lib/auth/roles';
import { assertMutation, requireSession } from '@/lib/auth/session';
import { metaAdsConfig } from '@/lib/meta-ads/config';
import { actorOf, metaAdsErrorResponse, metaAdsRouteError, notEnabledResponse, NO_STORE } from '@/lib/meta-ads/http';
import { parseBudgetCap, setBudgetCap } from '@/lib/meta-ads/manage';
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit';

export const runtime = 'nodejs';

export async function PUT(request: Request) {
  try {
    if (!metaAdsConfig()) return notEnabledResponse();
    const session = await requireSession(request);
    await assertMutation(request, session);
    if (!hasMinRole(session.role, 'admin')) return metaAdsErrorResponse('forbidden');
    const limit = checkRateLimit(`metaAdsBudgetCap:${session.userId}`, RATE_LIMITS.adminAction);
    if (!limit.success) return rateLimitResponse(limit);
    const cap = parseBudgetCap(await request.json().catch(() => null));
    if (cap === undefined) return metaAdsErrorResponse('invalid_request');
    return NextResponse.json({ maxDailyBudget: await setBudgetCap(actorOf(session), cap) }, { headers: NO_STORE });
  } catch (error) {
    return metaAdsRouteError(error);
  }
}
