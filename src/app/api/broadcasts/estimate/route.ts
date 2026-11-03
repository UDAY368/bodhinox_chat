// /api/broadcasts/estimate — campaign cost from the platform rate card (an estimate).
//   POST agents and above: { templateId, audience, currency? } with the wizard's
//        audience (CSV rows need only { phone }); counts recipients by country
//        the way campaign creation would, without creating anything.
//   GET  any member: ?broadcastId=&currency= estimated vs actual (delivered) by country.
// Responses hold counts and prices only, never phone numbers or contact names.

import { NextResponse } from 'next/server';

import { toErrorResponse } from '@/lib/auth/account';
import { AuthError, ForbiddenError } from '@/lib/auth/errors';
import { hasMinRole } from '@/lib/auth/roles';
import { assertMutation, requireSession } from '@/lib/auth/session';
import { campaignCostComparison, estimateAudienceCost } from '@/lib/analytics/campaign-cost';
import { CAMPAIGN_LIMITS } from '@/lib/broadcasts/create-campaign';
import { checkRateLimit, rateLimitResponse } from '@/lib/rate-limit';

export const runtime = 'nodejs';
const NO_STORE = { 'Cache-Control': 'no-store' };

export async function POST(request: Request) {
  try {
    const session = await requireSession(request);
    if (!hasMinRole(session.role, 'agent')) throw new ForbiddenError('Cost estimates require an agent role');
    await assertMutation(request, session);
    const limit = checkRateLimit(`campaignEstimate:${session.userId}`, { limit: 30, windowMs: 60_000 });
    if (!limit.success) return rateLimitResponse(limit);
    if (Number(request.headers.get('content-length') ?? 0) > CAMPAIGN_LIMITS.bodyBytes) throw new AuthError('Request is too large', 413);
    const text = await request.text();
    if (text.length > CAMPAIGN_LIMITS.bodyBytes) throw new AuthError('Request is too large', 413);
    let body: unknown;
    try { body = JSON.parse(text); } catch { throw new AuthError('Invalid JSON body', 400); }
    const estimate = await estimateAudienceCost({ accountId: session.accountId, userId: session.userId, role: session.role }, body);
    return NextResponse.json(estimate, { headers: NO_STORE });
  } catch (error) {
    return toErrorResponse(error);
  }
}

export async function GET(request: Request) {
  try {
    const session = await requireSession(request);
    const params = new URL(request.url).searchParams;
    const result = await campaignCostComparison({ accountId: session.accountId, userId: session.userId, role: session.role },
      params.get('broadcastId') ?? '', params.get('currency'));
    if (!result) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    return NextResponse.json(result, { headers: NO_STORE });
  } catch (error) {
    return toErrorResponse(error);
  }
}
