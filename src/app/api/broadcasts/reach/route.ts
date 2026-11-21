// POST /api/broadcasts/reach — how many people a WhatsApp campaign with this audience would reach now (agent+).
//   { audience } with the wizard's audience (CSV rows need only { phone }); counted by the same rules campaign
//   creation applies (consent, a WhatsApp address, excluded tags, "skip people messaged in the last X days"),
//   so the number shown is the number sent. Answers { count, timeZone } (the workspace's, for quiet hours).
//   Counts only; never phone numbers or names.

import { NextResponse } from 'next/server';

import { toErrorResponse } from '@/lib/auth/account';
import { AuthError, ForbiddenError } from '@/lib/auth/errors';
import { hasMinRole } from '@/lib/auth/roles';
import { assertMutation, requireSession } from '@/lib/auth/session';
import { CAMPAIGN_LIMITS, campaignReach } from '@/lib/broadcasts/create-campaign';
import { checkRateLimit, rateLimitResponse } from '@/lib/rate-limit';

export const runtime = 'nodejs';

export async function POST(request: Request) {
  try {
    const session = await requireSession(request);
    if (!hasMinRole(session.role, 'agent')) throw new ForbiddenError('Counting a campaign audience requires an agent role');
    await assertMutation(request, session);
    const limit = await checkRateLimit(`campaignReach:${session.userId}`, { limit: 60, windowMs: 60_000 });
    if (!limit.success) return rateLimitResponse(limit);
    if (Number(request.headers.get('content-length') ?? 0) > CAMPAIGN_LIMITS.bodyBytes) throw new AuthError('Request is too large', 413);
    const text = await request.text();
    if (text.length > CAMPAIGN_LIMITS.bodyBytes) throw new AuthError('Request is too large', 413);
    let body: unknown;
    try { body = JSON.parse(text); } catch { throw new AuthError('Invalid JSON body', 400); }
    const result = await campaignReach({ accountId: session.accountId, userId: session.userId, role: session.role }, body);
    return NextResponse.json(result, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    return toErrorResponse(error);
  }
}
