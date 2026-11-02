// PUT /api/billing/admin/prices — platform admins only (verified email listed in
// PLATFORM_ADMIN_EMAILS). Body is one price
//   { plan, interval: 'month'|'year', amount_minor, provider_plan_id, active? }
// or { source: 'env' } to load every price from BILLING_PLAN_PRICES.
// Origin/CSRF is checked here as well as in the proxy (a platform-wide write).

import { NextResponse } from 'next/server';

import { ForbiddenError, toErrorResponse } from '@/lib/auth/account';
import { assertMutation, requireSession } from '@/lib/auth/session';
import { isPlatformAdmin, parsePlanPrice, PriceInputError, pricesFromEnv, upsertPlanPrices } from '@/lib/billing/prices';
import { getT } from '@/lib/i18n/translate';
import { checkRateLimit, rateLimitResponse } from '@/lib/rate-limit';

const t = getT('Validation.billing');

export async function PUT(request: Request) {
  try {
    const session = await requireSession(request);
    await assertMutation(request, session);
    if (!isPlatformAdmin(session.user.email)) throw new ForbiddenError();
    const limit = checkRateLimit(`billingPrices:${session.userId}`, { limit: 30, windowMs: 60_000 });
    if (!limit.success) return rateLimitResponse(limit);
    const body = await request.json().catch(() => null);
    if (!body || typeof body !== 'object') return NextResponse.json({ error: t('invalidPrice') }, { status: 400 });
    let prices;
    try {
      prices = (body as { source?: unknown }).source === 'env' ? pricesFromEnv() : [parsePlanPrice(body)];
    } catch (error) {
      if (error instanceof PriceInputError) return NextResponse.json({ error: t('invalidPrice') }, { status: 400 });
      throw error;
    }
    if (!prices.length) return NextResponse.json({ error: t('noEnvPrices') }, { status: 400 });
    try {
      return NextResponse.json({ updated: await upsertPlanPrices(prices) });
    } catch (error) {
      if (error instanceof PriceInputError)
        return NextResponse.json({ error: t(error.message === 'Unknown plan' ? 'unknownPlan' : 'invalidPrice') }, { status: 400 });
      throw error;
    }
  } catch (error) {
    return toErrorResponse(error);
  }
}
