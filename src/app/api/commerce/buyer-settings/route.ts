// GET /api/commerce/buyer-settings — buyer self-service settings (agents and above): buyer return requests, price-drop nudges
//   and the checkout extras (note, gift message, delivery date and slots, custom fields). 200 { settings }.
// PUT /api/commerce/buyer-settings — replace them (admins). Same shape back; 400 { code: 'extras_invalid', field } for a body
//   outside the fixed caps (6 slots, 5 custom fields, short labels).

import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth/account';
import { tenantOf } from '@/lib/audience/http';
import { getBuyerSettings, parseBuyerSettings, saveBuyerSettings } from '@/lib/commerce/buyer-settings';
import { storeErrorResponse } from '@/lib/commerce/store-settings';
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit';

export async function GET() {
  try {
    const ctx = await requireRole('agent');
    return NextResponse.json({ settings: await getBuyerSettings(tenantOf(ctx)) });
  } catch (error) {
    return storeErrorResponse(error);
  }
}

export async function PUT(request: Request) {
  try {
    const ctx = await requireRole('admin');
    const limit = checkRateLimit(`commerce:buyer-settings:${ctx.userId}`, RATE_LIMITS.adminAction);
    if (!limit.success) return rateLimitResponse(limit);
    const input = parseBuyerSettings(await request.json().catch(() => null));
    return NextResponse.json({ settings: await saveBuyerSettings({ ...tenantOf(ctx), userId: ctx.userId }, input) });
  } catch (error) {
    return storeErrorResponse(error);
  }
}
