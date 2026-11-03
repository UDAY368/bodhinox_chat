// GET  /api/commerce/coupons — coupons with their live redemption counts (agents and above).
// POST /api/commerce/coupons — create one (admins). 201 { coupon }; 409 coupon_code_taken.
// A coupon's code, kind and value never change once created.

import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth/account';
import { tenantOf } from '@/lib/audience/http';
import { createCoupon, listCoupons, parseCouponCreate } from '@/lib/commerce/coupons';
import { storeErrorResponse } from '@/lib/commerce/store-settings';
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit';

export async function GET() {
  try {
    const ctx = await requireRole('agent');
    return NextResponse.json({ coupons: await listCoupons(tenantOf(ctx)) });
  } catch (error) {
    return storeErrorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    const ctx = await requireRole('admin');
    const limit = checkRateLimit(`commerce:coupons:${ctx.userId}`, RATE_LIMITS.adminAction);
    if (!limit.success) return rateLimitResponse(limit);
    const input = parseCouponCreate(await request.json().catch(() => null));
    return NextResponse.json({ coupon: await createCoupon({ ...tenantOf(ctx), userId: ctx.userId }, input) }, { status: 201 });
  } catch (error) {
    return storeErrorResponse(error);
  }
}
