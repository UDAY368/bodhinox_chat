// GET /api/instagram/consent-settings (any member) — the workspace's Instagram
//   subscribe / unsubscribe settings: 200 { settings: { opt_out_keywords, opt_in_keywords,
//   opt_out_reply, opt_in_reply, opt_out_flow_id, opt_in_flow_id }, built_in: { opt_out, opt_in } }
//   (defaults when never saved). Read as the member, under RLS.
// PUT (admins and owners) — replaces them with the same shape. Keywords: up to 20 each,
//   1-50 characters, stored trimmed and lowercased; a word cannot be in both lists.
//   Replies: one Instagram message each (up to 1,000 characters). Flows: Instagram or
//   any-channel flows of this workspace; another workspace's flow id is invalid_flow.
//   200 { settings, built_in }; 400 { error, code: invalid_keywords | invalid_reply | invalid_flow }.
//   CSRF/mutation origin is enforced by src/proxy.ts. Behind INSTAGRAM_ENABLED (404 when off).
import { NextResponse } from 'next/server';

import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { tenantOf } from '@/lib/audience/http';
import { BUILT_IN_OPT_IN, BUILT_IN_OPT_OUT } from '@/lib/contacts/consent';
import {
  ConsentSettingsError,
  loadConsentSettings,
  parseConsentSettingsInput,
  saveConsentSettings,
} from '@/lib/contacts/channel-consent';
import { instagramEnabled } from '@/lib/instagram/config';
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit';

const headers = { 'Cache-Control': 'private, no-store' };
const builtIn = { opt_out: BUILT_IN_OPT_OUT, opt_in: BUILT_IN_OPT_IN };
const off = () => NextResponse.json({ error: 'Not found' }, { status: 404, headers });

export async function GET() {
  try {
    if (!instagramEnabled()) return off();
    const ctx = await requireRole('viewer');
    return NextResponse.json({ settings: await loadConsentSettings(tenantOf(ctx)), built_in: builtIn }, { headers });
  } catch (error) {
    return toErrorResponse(error);
  }
}

export async function PUT(request: Request) {
  try {
    if (!instagramEnabled()) return off();
    const ctx = await requireRole('admin');
    const limit = checkRateLimit(`consentSettings:${ctx.userId}`, RATE_LIMITS.send);
    if (!limit.success) return rateLimitResponse(limit);
    const settings = parseConsentSettingsInput(await request.json().catch(() => null));
    return NextResponse.json({ settings: await saveConsentSettings(tenantOf(ctx), settings), built_in: builtIn }, { headers });
  } catch (error) {
    if (error instanceof ConsentSettingsError)
      return NextResponse.json({ error: error.code, code: error.code }, { status: 400, headers });
    return toErrorResponse(error);
  }
}
