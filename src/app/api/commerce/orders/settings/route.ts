// GET /api/commerce/orders/settings — the order confirmation setting (agents and above).
//   200 { settings: { confirmation_mode, confirmation_text, template_name, template_language, variable_map } }
// PUT /api/commerce/orders/settings — replace it (admins). 200 { settings }; 400 { error }.

import { NextResponse } from 'next/server';

import { requireRole } from '@/lib/auth/account';
import { tenantOf } from '@/lib/audience/http';
import { getOrderSettings, orderErrorResponse, parseOrderSettings, saveOrderSettings } from '@/lib/commerce/orders';
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit';

export async function GET() {
  try {
    const ctx = await requireRole('agent');
    return NextResponse.json({ settings: await getOrderSettings(tenantOf(ctx)) });
  } catch (error) {
    return orderErrorResponse(error);
  }
}

export async function PUT(request: Request) {
  try {
    const ctx = await requireRole('admin');
    const limit = checkRateLimit(`orders:settings:${ctx.userId}`, RATE_LIMITS.adminAction);
    if (!limit.success) return rateLimitResponse(limit);
    const settings = parseOrderSettings(await request.json().catch(() => null));
    return NextResponse.json({ settings: await saveOrderSettings(tenantOf(ctx), settings) });
  } catch (error) {
    return orderErrorResponse(error);
  }
}
