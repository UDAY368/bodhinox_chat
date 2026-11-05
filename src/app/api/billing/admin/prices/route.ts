// PUT /api/billing/admin/prices — platform admins only (verified email listed in
// PLATFORM_ADMIN_EMAILS, with a verified MFA factor and a recent MFA check:
// requirePlatformAdmin). Every change is recorded in the platform audit trail.
// Body is one price
//   { plan, interval: 'month'|'year', amount_minor, provider_plan_id, active? }
// or { source: 'env' } to load every price from BILLING_PLAN_PRICES.
// Origin/CSRF is checked here as well as in the proxy (a platform-wide write).

import { NextResponse } from 'next/server';

import { parsePlanPrice, PriceInputError, pricesFromEnv, upsertPlanPrices } from '@/lib/billing/prices';
import { getT } from '@/lib/i18n/translate';
import { hashRequestIp } from '@/lib/platform/audit';
import { platformErrorResponse, requirePlatformAdmin } from '@/lib/platform/auth';

const t = getT('Validation.billing');

export async function PUT(request: Request) {
  try {
    // Runs on the worker role (no PLATFORM_DATABASE_URL needed); non-admins keep getting 403.
    const admin = await requirePlatformAdmin(request, { mutation: true, console: false });
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
      // The audit row is written in the same worker transaction as the prices.
      const updated = await upsertPlanPrices(prices, {
        adminEmail: admin.email, action: 'billing.prices_updated', targetRef: (body as { source?: unknown }).source === 'env' ? 'env' : prices[0].plan,
        detail: { prices: prices.map((p) => ({ plan: p.plan, interval: p.interval, amount_minor: p.amountMinor, provider_plan_id: p.providerPlanId, active: p.active })) },
        ipHash: hashRequestIp(request),
      });
      return NextResponse.json({ updated });
    } catch (error) {
      if (error instanceof PriceInputError)
        return NextResponse.json({ error: t(error.message === 'Unknown plan' ? 'unknownPlan' : 'invalidPrice') }, { status: 400 });
      throw error;
    }
  } catch (error) {
    return platformErrorResponse(error);
  }
}
