// GET /api/commerce/store-site — the public shop's settings, the setup
// checklist, numbers and approved authentication templates (agents and above).
//   200 { site, checklist, numbers, otpTemplates }
// PUT /api/commerce/store-site — save them (admins), version-checked.
//   200 same shape; 400/403/409 { error, code, field? }

import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth/account';
import { tenantOf } from '@/lib/audience/http';
import { getShopSite, parseShopSiteInput, saveShopSite } from '@/lib/commerce/shop-site';
import { storeErrorResponse } from '@/lib/commerce/store-settings';
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit';

export async function GET() {
  try {
    const ctx = await requireRole('agent');
    return NextResponse.json(await getShopSite(tenantOf(ctx)));
  } catch (error) {
    return storeErrorResponse(error);
  }
}

export async function PUT(request: Request) {
  try {
    const ctx = await requireRole('admin');
    const limit = await checkRateLimit(`commerce:store-site:${ctx.userId}`, RATE_LIMITS.adminAction);
    if (!limit.success) return rateLimitResponse(limit);
    const input = parseShopSiteInput(await request.json().catch(() => null));
    return NextResponse.json(await saveShopSite({ ...tenantOf(ctx), userId: ctx.userId }, input));
  } catch (error) {
    return storeErrorResponse(error);
  }
}
