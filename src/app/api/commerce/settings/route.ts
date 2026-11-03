// GET /api/commerce/settings — store settings (agents and above).
//   200 { settings }
// PUT /api/commerce/settings — replace them (admins). 200 { settings }; 400/409 { error, code }.
// The currency cannot change once any variant has a price.

import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth/account';
import { tenantOf } from '@/lib/audience/http';
import { getStoreSettings, parseStoreSettings, saveStoreSettings, storeErrorResponse } from '@/lib/commerce/store-settings';
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit';

export async function GET() {
  try {
    const ctx = await requireRole('agent');
    return NextResponse.json({ settings: await getStoreSettings(tenantOf(ctx)) });
  } catch (error) {
    return storeErrorResponse(error);
  }
}

export async function PUT(request: Request) {
  try {
    const ctx = await requireRole('admin');
    const limit = checkRateLimit(`commerce:settings:${ctx.userId}`, RATE_LIMITS.adminAction);
    if (!limit.success) return rateLimitResponse(limit);
    const input = parseStoreSettings(await request.json().catch(() => null));
    return NextResponse.json({ settings: await saveStoreSettings({ ...tenantOf(ctx), userId: ctx.userId }, input) });
  } catch (error) {
    return storeErrorResponse(error);
  }
}
