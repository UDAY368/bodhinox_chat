// GET /api/commerce/delivery-options — store pickup and local delivery settings (agents and above). 200 { options }.
// PUT /api/commerce/delivery-options — replace them (admins). 200 { options }; 400/409 { error, code }.
//   Pickup needs an address; local delivery needs at least one postal prefix, and a tax rate when it has a fee.

import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth/account';
import { tenantOf } from '@/lib/audience/http';
import { getDeliveryOptions, parseDeliveryOptions, saveDeliveryOptions } from '@/lib/commerce/delivery-options';
import { storeErrorResponse } from '@/lib/commerce/store-settings';
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit';

export async function GET() {
  try {
    const ctx = await requireRole('agent');
    return NextResponse.json({ options: await getDeliveryOptions(tenantOf(ctx)) });
  } catch (error) {
    return storeErrorResponse(error);
  }
}

export async function PUT(request: Request) {
  try {
    const ctx = await requireRole('admin');
    const limit = checkRateLimit(`commerce:delivery:${ctx.userId}`, RATE_LIMITS.adminAction);
    if (!limit.success) return rateLimitResponse(limit);
    const input = parseDeliveryOptions(await request.json().catch(() => null));
    return NextResponse.json({ options: await saveDeliveryOptions({ ...tenantOf(ctx), userId: ctx.userId }, input) });
  } catch (error) {
    return storeErrorResponse(error);
  }
}
