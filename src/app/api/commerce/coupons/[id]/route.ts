// PATCH /api/commerce/coupons/<id> — change a coupon's limits, dates or active flag (admins).
//   200 { coupon }; 404 not_found.

import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth/account';
import { tenantOf } from '@/lib/audience/http';
import { parseCouponUpdate, updateCoupon } from '@/lib/commerce/coupons';
import { storeErrorResponse } from '@/lib/commerce/store-settings';
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit';

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const ctx = await requireRole('admin');
    const limit = checkRateLimit(`commerce:coupons:${ctx.userId}`, RATE_LIMITS.adminAction);
    if (!limit.success) return rateLimitResponse(limit);
    const { id } = await params;
    const input = parseCouponUpdate(await request.json().catch(() => null));
    return NextResponse.json({ coupon: await updateCoupon({ ...tenantOf(ctx), userId: ctx.userId }, id, input) });
  } catch (error) {
    return storeErrorResponse(error);
  }
}
