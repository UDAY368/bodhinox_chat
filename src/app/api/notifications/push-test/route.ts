// POST /api/notifications/push-test — sends one payload-free test push to the signed-in member's own
//   registered browsers. Any member. 200 { devices, sent }; 503 push not configured; 429 rate limited.
//   Only the member's own devices are reachable (RLS); no content leaves with the push.

import { NextResponse } from 'next/server';

import { getCurrentAccount, toErrorResponse } from '@/lib/auth/account';
import { sendTestPush } from '@/lib/notifications/push-delivery';
import { webPushAvailable } from '@/lib/notifications/web-push';
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit';

export async function POST() {
  try {
    const ctx = await getCurrentAccount();
    const limit = checkRateLimit(`push:test:${ctx.userId}`, RATE_LIMITS.adminAction);
    if (!limit.success) return rateLimitResponse(limit);
    if (!webPushAvailable()) return NextResponse.json({ error: 'push_unavailable', code: 'push_unavailable' }, { status: 503 });
    const result = await sendTestPush({ accountId: ctx.accountId, userId: ctx.userId, role: ctx.role });
    return NextResponse.json(result, { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (error) {
    return toErrorResponse(error);
  }
}
