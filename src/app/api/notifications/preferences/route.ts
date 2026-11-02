// GET /api/notifications/preferences — the signed-in member's own notification preferences.
//   200 { preferences: [{ event, in_app, email }], email_available: boolean }
// PUT /api/notifications/preferences — { preferences: [{ event, in_app, email }] } upserts those events.
//   200 { preferences, email_available }; 400 { error }.
// Any member (viewer and up) manages only their own rows; RLS enforces it.

import { NextResponse } from 'next/server';

import { getCurrentAccount, toErrorResponse } from '@/lib/auth/account';
import { tenantOf } from '@/lib/audience/http';
import {
  emailDigestAvailable,
  getNotificationPreferences,
  NotificationPreferenceError,
  parsePreferenceUpdate,
  saveNotificationPreferences,
} from '@/lib/notifications/preferences';
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit';

const PRIVATE = { 'Cache-Control': 'private, no-store' };

export async function GET() {
  try {
    const ctx = await getCurrentAccount();
    const preferences = await getNotificationPreferences(tenantOf(ctx));
    return NextResponse.json({ preferences, email_available: emailDigestAvailable() }, { headers: PRIVATE });
  } catch (error) {
    return toErrorResponse(error);
  }
}

export async function PUT(request: Request) {
  try {
    const ctx = await getCurrentAccount();
    const limit = checkRateLimit(`notifications:preferences:${ctx.userId}`, RATE_LIMITS.adminAction);
    if (!limit.success) return rateLimitResponse(limit);
    const updates = parsePreferenceUpdate(await request.json().catch(() => null));
    const preferences = await saveNotificationPreferences(tenantOf(ctx), updates);
    return NextResponse.json({ preferences, email_available: emailDigestAvailable() }, { headers: PRIVATE });
  } catch (error) {
    if (error instanceof NotificationPreferenceError) return NextResponse.json({ error: error.message }, { status: 400 });
    return toErrorResponse(error);
  }
}
