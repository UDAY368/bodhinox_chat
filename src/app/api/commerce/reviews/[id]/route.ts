// PATCH /api/commerce/reviews/<id> { status: "published" | "hidden" } — publish or hide a review (admins).
//   200 { review }; 400 invalid; 404 not_found (also another workspace's id).

import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth/account';
import { tenantOf } from '@/lib/audience/http';
import { moderateReview } from '@/lib/commerce/review-data';
import { storeErrorResponse } from '@/lib/commerce/store-settings';
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit';
import { revalidateShop } from '@/lib/commerce/shop-cache';

type Params = { params: Promise<{ id: string }> };

export async function PATCH(request: Request, { params }: Params) {
  try {
    const ctx = await requireRole('admin');
    const limit = await checkRateLimit(`commerce:reviews:${ctx.userId}`, RATE_LIMITS.adminAction);
    if (!limit.success) return rateLimitResponse(limit);
    const { id } = await params;
    const body: unknown = await request.json().catch(() => null);
    const status = body && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>).status : undefined;
    const review = await moderateReview({ ...tenantOf(ctx), userId: ctx.userId }, id, status);
    revalidateShop(ctx.accountId);
    return NextResponse.json({ review });
  } catch (error) {
    return storeErrorResponse(error);
  }
}
