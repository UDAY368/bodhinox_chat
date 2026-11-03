// GET  /api/commerce/shipping-rates — every shipping rate (agents and above).
// POST /api/commerce/shipping-rates — add one (admins). 201 { rate }.

import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth/account';
import { tenantOf } from '@/lib/audience/http';
import { createShippingRate, listShippingRates, parseShippingRate, storeErrorResponse } from '@/lib/commerce/store-settings';
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit';

export async function GET() {
  try {
    const ctx = await requireRole('agent');
    return NextResponse.json({ rates: await listShippingRates(tenantOf(ctx)) });
  } catch (error) {
    return storeErrorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    const ctx = await requireRole('admin');
    const limit = checkRateLimit(`commerce:shipping:${ctx.userId}`, RATE_LIMITS.adminAction);
    if (!limit.success) return rateLimitResponse(limit);
    const input = parseShippingRate(await request.json().catch(() => null));
    return NextResponse.json({ rate: await createShippingRate({ ...tenantOf(ctx), userId: ctx.userId }, input) }, { status: 201 });
  } catch (error) {
    return storeErrorResponse(error);
  }
}
