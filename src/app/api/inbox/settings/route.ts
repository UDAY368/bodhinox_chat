// GET /api/inbox/settings (any member) — the workspace's inbox settings:
//   200 { settings: { timezone, working_hours, away_message_enabled, away_message,
//   auto_resolve_after_hours, sla_first_response_minutes } } (defaults when never saved).
// PUT /api/inbox/settings (admins and owners) — replaces them with the same shape.
//   200 { settings }; 400 { error, code } with code invalid_timezone | invalid_working_hours |
//   invalid_away_message | invalid_auto_resolve | invalid_sla.

import { NextResponse } from 'next/server';

import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { tenantOf } from '@/lib/audience/http';
import { getT } from '@/lib/i18n/translate';
import {
  InboxSettingsError,
  loadInboxSettings,
  parseInboxSettingsInput,
  saveInboxSettings,
} from '@/lib/inbox/inbox-settings';
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit';

const t = getT('Validation.inboxSettings');
const headers = { 'Cache-Control': 'private, no-store' };

export async function GET() {
  try {
    const ctx = await requireRole('viewer');
    return NextResponse.json({ settings: await loadInboxSettings(tenantOf(ctx)) }, { headers });
  } catch (error) {
    return toErrorResponse(error);
  }
}

export async function PUT(request: Request) {
  try {
    const ctx = await requireRole('admin');
    const limit = checkRateLimit(`inboxSettings:${ctx.userId}`, RATE_LIMITS.send);
    if (!limit.success) return rateLimitResponse(limit);
    const settings = parseInboxSettingsInput(await request.json().catch(() => null));
    return NextResponse.json({ settings: await saveInboxSettings(tenantOf(ctx), settings) }, { headers });
  } catch (error) {
    if (error instanceof InboxSettingsError)
      return NextResponse.json({ error: t(error.code), code: error.code }, { status: 400 });
    return toErrorResponse(error);
  }
}
