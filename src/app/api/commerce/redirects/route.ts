// GET /api/commerce/redirects — the shop's redirect rules (agents and above). 200 { redirects, handle }.
// POST /api/commerce/redirects { from, to, code? } — add one (admins). Both are paths inside the shop ("/old-oil" or the full
//   /s/<handle>/... address); code 301 (default) or 302. 200 { redirect }; 400/409 { error, code } for a bad path, a duplicate, a loop
//   or more than 200 rules.

import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth/account';
import { tenantOf } from '@/lib/audience/http';
import { addRedirect, listRedirects, parseRedirectInput, shopHandle } from '@/lib/commerce/shop-redirects';
import { storeErrorResponse } from '@/lib/commerce/store-settings';
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit';

export async function GET() {
  try {
    const ctx = await requireRole('agent');
    const [redirects, handle] = await Promise.all([listRedirects(tenantOf(ctx)), shopHandle(tenantOf(ctx))]);
    return NextResponse.json({ redirects, handle });
  } catch (error) {
    return storeErrorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    const ctx = await requireRole('admin');
    const limit = checkRateLimit(`commerce:redirects:${ctx.userId}`, RATE_LIMITS.adminAction);
    if (!limit.success) return rateLimitResponse(limit);
    const handle = await shopHandle(tenantOf(ctx));
    const input = parseRedirectInput(await request.json().catch(() => null), handle);
    return NextResponse.json({ redirect: await addRedirect({ ...tenantOf(ctx), userId: ctx.userId }, input) });
  } catch (error) {
    return storeErrorResponse(error);
  }
}
