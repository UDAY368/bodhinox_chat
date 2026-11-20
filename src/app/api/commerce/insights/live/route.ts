// GET /api/commerce/insights/live — visitors on the shop right now and the pages they are on, from the last five minutes of aggregate
//   page-view counters (admins and owners). No visitor data exists to return.

import { NextResponse } from 'next/server';
import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { tenantOf } from '@/lib/audience/http';
import { loadLiveView } from '@/lib/commerce/shop-live';
import { checkRateLimit, rateLimitResponse } from '@/lib/rate-limit';

export async function GET() {
  try {
    const ctx = await requireRole('admin');
    const limit = await checkRateLimit(`commerce:live:${ctx.userId}`, { limit: 30, windowMs: 60_000 });
    if (!limit.success) return rateLimitResponse(limit);
    return NextResponse.json({ live: await loadLiveView(tenantOf(ctx)) }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    return toErrorResponse(error);
  }
}
