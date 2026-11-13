// POST /api/broadcasts/instagram/estimate { audience } — how many of an audience's contacts
// are on Instagram and how many of them are inside their 24-hour window now. Read-only;
// rate-limited like the WhatsApp estimate (each call counts up to the recipient cap).

import { NextResponse } from 'next/server';

import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { tenantOf } from '@/lib/audience/http';
import { countInstagramAudience } from '@/lib/broadcasts/instagram';
import { checkRateLimit, rateLimitResponse } from '@/lib/rate-limit';
import { readBoundedJson } from '@/lib/broadcasts/read-body';

export const runtime = 'nodejs';

export async function POST(request: Request) {
  try {
    const ctx = await requireRole('agent');
    const limit = checkRateLimit(`campaignEstimate:ig:${ctx.userId}`, { limit: 30, windowMs: 60_000 });
    if (!limit.success) return rateLimitResponse(limit);
    const body = await readBoundedJson(request);
    return NextResponse.json(await countInstagramAudience(tenantOf(ctx), body), { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    return toErrorResponse(error);
  }
}
