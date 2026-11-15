// GET  /api/commerce/auto-discounts — the workspace's automatic discount rules (agents and above).
// POST /api/commerce/auto-discounts — create one (admins). 201 { discount }; 409 auto_discount_limit (20 rules).

import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth/account';
import { tenantOf } from '@/lib/audience/http';
import { createAutoDiscount, listAutoDiscounts, parseAutoDiscount } from '@/lib/commerce/auto-discount-rules';
import { storeErrorResponse } from '@/lib/commerce/store-settings';
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit';

export async function GET() {
  try {
    const ctx = await requireRole('agent');
    return NextResponse.json({ discounts: await listAutoDiscounts(tenantOf(ctx)) });
  } catch (error) {
    return storeErrorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    const ctx = await requireRole('admin');
    const limit = checkRateLimit(`commerce:auto-discounts:${ctx.userId}`, RATE_LIMITS.adminAction);
    if (!limit.success) return rateLimitResponse(limit);
    const input = parseAutoDiscount(await request.json().catch(() => null));
    return NextResponse.json({ discount: await createAutoDiscount({ ...tenantOf(ctx), userId: ctx.userId }, input) }, { status: 201 });
  } catch (error) {
    return storeErrorResponse(error);
  }
}
