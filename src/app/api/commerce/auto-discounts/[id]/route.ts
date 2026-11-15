// PATCH  /api/commerce/auto-discounts/<id> — replace a rule (admins). The body carries expected_version:
//   200 { discount }; 404 not_found; 409 conflict when someone else changed it first.
// DELETE /api/commerce/auto-discounts/<id> — remove a rule (admins). 200 { ok: true }; 404 not_found.

import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth/account';
import { tenantOf } from '@/lib/audience/http';
import { deleteAutoDiscount, parseAutoDiscount, updateAutoDiscount } from '@/lib/commerce/auto-discount-rules';
import { storeErrorResponse } from '@/lib/commerce/store-settings';
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit';

type Params = { params: Promise<{ id: string }> };

export async function PATCH(request: Request, { params }: Params) {
  try {
    const ctx = await requireRole('admin');
    const limit = checkRateLimit(`commerce:auto-discounts:${ctx.userId}`, RATE_LIMITS.adminAction);
    if (!limit.success) return rateLimitResponse(limit);
    const { id } = await params;
    const body: unknown = await request.json().catch(() => null);
    const input = parseAutoDiscount(body);
    const discount = await updateAutoDiscount({ ...tenantOf(ctx), userId: ctx.userId }, id, (body as Record<string, unknown>).expected_version, input);
    return NextResponse.json({ discount });
  } catch (error) {
    return storeErrorResponse(error);
  }
}

export async function DELETE(_request: Request, { params }: Params) {
  try {
    const ctx = await requireRole('admin');
    const limit = checkRateLimit(`commerce:auto-discounts:${ctx.userId}`, RATE_LIMITS.adminAction);
    if (!limit.success) return rateLimitResponse(limit);
    const { id } = await params;
    await deleteAutoDiscount({ ...tenantOf(ctx), userId: ctx.userId }, id);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return storeErrorResponse(error);
  }
}
