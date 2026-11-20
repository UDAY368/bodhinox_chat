// GET /api/commerce/shop-access — how the public shop is opened: open, password or coming soon (agents and above).
//   200 { access: { mode, passwordSet, comingSoonMessage, shopSaved } }. The password hash is never returned.
// PUT /api/commerce/shop-access { mode, password?, comingSoonMessage? } — change it (admins). 200 { access };
//   400/409 { error, code }. Password mode needs a password (6 to 72 characters) to be set; leaving `password`
//   out keeps the current one.

import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth/account';
import { tenantOf } from '@/lib/audience/http';
import { getShopAccess, parseShopAccessInput, saveShopAccess } from '@/lib/commerce/shop-access';
import { storeErrorResponse } from '@/lib/commerce/store-settings';
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit';

export async function GET() {
  try {
    const ctx = await requireRole('agent');
    return NextResponse.json({ access: await getShopAccess(tenantOf(ctx)) });
  } catch (error) {
    return storeErrorResponse(error);
  }
}

export async function PUT(request: Request) {
  try {
    const ctx = await requireRole('admin');
    const limit = await checkRateLimit(`commerce:shop-access:${ctx.userId}`, RATE_LIMITS.adminAction);
    if (!limit.success) return rateLimitResponse(limit);
    const input = parseShopAccessInput(await request.json().catch(() => null));
    return NextResponse.json({ access: await saveShopAccess({ ...tenantOf(ctx), userId: ctx.userId }, input) });
  } catch (error) {
    return storeErrorResponse(error);
  }
}
