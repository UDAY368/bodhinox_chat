// PATCH  /api/commerce/shipping-rates/<id> — replace a rate (admins). 200 { rate }.
// DELETE /api/commerce/shipping-rates/<id> — remove it (admins). 200 { ok: true }.
// Placed orders keep their own shipping snapshot, so removing a rate never changes an order.

import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth/account';
import { tenantOf } from '@/lib/audience/http';
import { deleteShippingRate, parseShippingRate, storeErrorResponse, updateShippingRate } from '@/lib/commerce/store-settings';
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit';

type Params = { params: Promise<{ id: string }> };

export async function PATCH(request: Request, { params }: Params) {
  try {
    const ctx = await requireRole('admin');
    const limit = checkRateLimit(`commerce:shipping:${ctx.userId}`, RATE_LIMITS.adminAction);
    if (!limit.success) return rateLimitResponse(limit);
    const { id } = await params;
    const input = parseShippingRate(await request.json().catch(() => null));
    return NextResponse.json({ rate: await updateShippingRate({ ...tenantOf(ctx), userId: ctx.userId }, id, input) });
  } catch (error) {
    return storeErrorResponse(error);
  }
}

export async function DELETE(_request: Request, { params }: Params) {
  try {
    const ctx = await requireRole('admin');
    const limit = checkRateLimit(`commerce:shipping:${ctx.userId}`, RATE_LIMITS.adminAction);
    if (!limit.success) return rateLimitResponse(limit);
    const { id } = await params;
    await deleteShippingRate({ ...tenantOf(ctx), userId: ctx.userId }, id);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return storeErrorResponse(error);
  }
}
