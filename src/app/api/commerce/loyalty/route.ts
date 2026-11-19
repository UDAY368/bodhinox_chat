// GET /api/commerce/loyalty — the loyalty points settings (agents and above).
// PUT /api/commerce/loyalty — save them (admins): { enabled, earn_points, earn_spend_minor, redeem_value_minor, redeem_max_bps }.

import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth/account';
import { tenantOf } from '@/lib/audience/http';
import { getLoyaltySettings, parseLoyaltySettings, saveLoyaltySettings } from '@/lib/commerce/store-credit';
import { storeErrorResponse } from '@/lib/commerce/store-settings';
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit';

export async function GET() {
  try {
    const ctx = await requireRole('agent');
    return NextResponse.json({ loyalty: await getLoyaltySettings(tenantOf(ctx)) }, { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (error) {
    return storeErrorResponse(error);
  }
}

export async function PUT(request: Request) {
  try {
    const ctx = await requireRole('admin');
    const limit = checkRateLimit(`commerce:loyalty:${ctx.userId}`, RATE_LIMITS.adminAction);
    if (!limit.success) return rateLimitResponse(limit);
    const input = parseLoyaltySettings(await request.json().catch(() => null));
    return NextResponse.json({ loyalty: await saveLoyaltySettings({ ...tenantOf(ctx), userId: ctx.userId }, input) });
  } catch (error) {
    return storeErrorResponse(error);
  }
}
