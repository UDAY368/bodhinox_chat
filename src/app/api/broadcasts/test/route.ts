// POST /api/broadcasts/test { templateId, phones (≤3), variables, headerMediaUrl? }
// — send the campaign's template to up to 3 numbers before launch (agent+, rate limited).

import { NextResponse } from 'next/server';

import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { tenantOf } from '@/lib/audience/http';
import { sendCampaignTest } from '@/lib/broadcasts/test-send';
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit';

export async function POST(request: Request) {
  try {
    const ctx = await requireRole('agent');
    const limit = checkRateLimit(`campaignTest:${ctx.userId}`, RATE_LIMITS.campaignTest);
    if (!limit.success) return rateLimitResponse(limit);
    const results = await sendCampaignTest(tenantOf(ctx), await request.json().catch(() => null));
    return NextResponse.json({ results });
  } catch (error) {
    return toErrorResponse(error);
  }
}
