// GET /api/notifications/preferences — the signed-in member's own notification preferences.
//   200 { preferences: [{ event, in_app, email, push }], email_available, push_available,
//         quiet_hours: { enabled, start: "HH:MM", end: "HH:MM", time_zone, allow_mentions } }
// PUT /api/notifications/preferences — { preferences: [{ event, in_app, email, push? }], quiet_hours? }
//   upserts those events (and the quiet hours) in one transaction.
//   200 same shape as GET; 400 { error }.
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
import { formatClock, parseQuietHours, QuietHoursError, type QuietHours } from '@/lib/notifications/quiet-hours';
import { webPushAvailable } from '@/lib/notifications/web-push';
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit';
import { getMemberPreferences, writeQuietHours } from '@/lib/settings/member-preferences';

const PRIVATE = { 'Cache-Control': 'private, no-store' };

const quietView = (quiet: QuietHours) => ({ ...quiet, start: formatClock(quiet.start), end: formatClock(quiet.end) });

export async function GET() {
  try {
    const ctx = await getCurrentAccount();
    const tenant = tenantOf(ctx);
    const [preferences, member] = await Promise.all([getNotificationPreferences(tenant), getMemberPreferences(tenant)]);
    return NextResponse.json({
      preferences,
      email_available: emailDigestAvailable(),
      push_available: webPushAvailable(),
      quiet_hours: quietView(member.quiet_hours),
    }, { headers: PRIVATE });
  } catch (error) {
    return toErrorResponse(error);
  }
}

export async function PUT(request: Request) {
  try {
    const ctx = await getCurrentAccount();
    const limit = checkRateLimit(`notifications:preferences:${ctx.userId}`, RATE_LIMITS.adminAction);
    if (!limit.success) return rateLimitResponse(limit);
    const body = await request.json().catch(() => null);
    const updates = parsePreferenceUpdate(body);
    const rawQuiet = (body as { quiet_hours?: unknown } | null)?.quiet_hours;
    const quiet = rawQuiet === undefined ? null : parseQuietHours(rawQuiet);
    const tenant = tenantOf(ctx);
    const preferences = await saveNotificationPreferences(tenant, updates,
      quiet ? (tx) => writeQuietHours(tx, ctx.accountId, ctx.userId, quiet) : undefined);
    const member = await getMemberPreferences(tenant);
    return NextResponse.json({
      preferences,
      email_available: emailDigestAvailable(),
      push_available: webPushAvailable(),
      quiet_hours: quietView(member.quiet_hours),
    }, { headers: PRIVATE });
  } catch (error) {
    if (error instanceof NotificationPreferenceError || error instanceof QuietHoursError)
      return NextResponse.json({ error: error.message }, { status: 400 });
    return toErrorResponse(error);
  }
}
