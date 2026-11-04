// GET /api/instagram/callback — Instagram Login's redirect. Checks that the
// admin who started the authorization is still signed in to the same
// workspace, verifies the state against the signed cookie (before any
// Instagram call), then finishes the connection (code exchange, long-lived
// token, /me, webhook subscription, plan room, upsert, audit). Always
// redirects to Settings -> Instagram with ?instagram=connected or
// ?instagram=error&code=<fixed code>, and clears the state cookie. No token
// or Meta text ever reaches the URL.

import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { appOrigin } from '@/lib/auth/csrf';
import { hasMinRole } from '@/lib/auth/roles';
import { requireSession } from '@/lib/auth/session';
import { PlanLimitError } from '@/lib/billing/entitlements';
import { instagramConfig } from '@/lib/instagram/config';
import {
  finishConnect, INSTAGRAM_OAUTH_COOKIE, INSTAGRAM_OAUTH_COOKIE_PATH, INSTAGRAM_SETTINGS_PATH,
} from '@/lib/instagram/connection';
import { InstagramError } from '@/lib/instagram/errors';
import { actorOf, CALLBACK_ERROR_CODES, type CallbackErrorCode } from '../_lib/route';

export const runtime = 'nodejs';

function back(outcome: { connected: true } | { code: CallbackErrorCode }): NextResponse {
  const target = new URL(INSTAGRAM_SETTINGS_PATH, appOrigin());
  if ('connected' in outcome) target.searchParams.set('instagram', 'connected');
  else {
    target.searchParams.set('instagram', 'error');
    target.searchParams.set('code', outcome.code);
  }
  const response = NextResponse.redirect(target, { status: 303 });
  response.cookies.set(INSTAGRAM_OAUTH_COOKIE, '', {
    path: INSTAGRAM_OAUTH_COOKIE_PATH, maxAge: 0, httpOnly: true, sameSite: 'lax',
    secure: appOrigin().startsWith('https:'),
  });
  response.headers.set('Cache-Control', 'private, no-store');
  response.headers.set('Referrer-Policy', 'no-referrer');
  return response;
}

function codeOf(error: unknown): CallbackErrorCode {
  if (error instanceof PlanLimitError) return 'feature_unavailable';
  if (error instanceof InstagramError && (CALLBACK_ERROR_CODES as readonly string[]).includes(error.code))
    return error.code as CallbackErrorCode;
  return 'save_failed';
}

export async function GET(request: Request) {
  if (!instagramConfig()) return back({ code: 'instagram_not_enabled' });
  let session;
  try {
    session = await requireSession(request);
  } catch {
    return back({ code: 'signed_out' });
  }
  if (!hasMinRole(session.role, 'admin')) return back({ code: 'forbidden' });
  const params = new URL(request.url).searchParams;
  // The admin declined on Instagram's consent page.
  if (params.get('error')) return back({ code: 'denied' });
  try {
    await finishConnect(actorOf(session), {
      state: params.get('state'),
      cookieState: (await cookies()).get(INSTAGRAM_OAUTH_COOKIE)?.value ?? null,
      code: params.get('code'),
    });
    return back({ connected: true });
  } catch (error) {
    const code = codeOf(error);
    if (code === 'save_failed') console.error('[instagram] connection could not be saved', error instanceof Error ? error.name : 'unknown');
    return back({ code });
  }
}
