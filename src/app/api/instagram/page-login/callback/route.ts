// GET /api/instagram/page-login/callback — Facebook Login's redirect. Checks that
// the admin who started the login is still signed in to the same workspace and
// verifies the state against the signed cookie (before any Meta call), exchanges
// the code, checks the granted permissions and seals the user token into an
// httpOnly cookie for the account choice. Always redirects to Settings -> Instagram
// with ?instagram_pl=select or ?instagram_pl=error&code=<fixed code>, and clears
// the state cookie. No token or Meta text ever reaches the URL.

import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { appOrigin } from '@/lib/auth/csrf';
import { hasMinRole } from '@/lib/auth/roles';
import { requireSession } from '@/lib/auth/session';
import { PlanLimitError } from '@/lib/billing/entitlements';
import { pageLoginConfig } from '@/lib/instagram/config';
import { InstagramError } from '@/lib/instagram/errors';
import {
  completePageLogin, PAGE_LOGIN_COOKIE_PATH, PAGE_LOGIN_PICK_COOKIE, PAGE_LOGIN_SETTINGS_PATH, PAGE_LOGIN_STATE_COOKIE,
  PAGE_LOGIN_TTL_MS,
} from '@/lib/instagram/page-login';
import { actorOf } from '../../_lib/route';

export const runtime = 'nodejs';

/** The ?code= values the settings card knows (kept in step with PAGE_LOGIN_ERROR_KEYS in the card). */
const CALLBACK_CODES = [
  'instagram_not_enabled', 'signed_out', 'forbidden', 'denied', 'state_mismatch', 'invalid_request',
  'instagram_permission_missing', 'limit_reached', 'feature_unavailable', 'instagram_token_invalid', 'meta_error', 'save_failed',
] as const;
type CallbackCode = (typeof CALLBACK_CODES)[number];

const cookieBase = () => ({ path: PAGE_LOGIN_COOKIE_PATH, httpOnly: true, sameSite: 'lax' as const, secure: appOrigin().startsWith('https:') });

function back(outcome: { pickCookie: string } | { code: CallbackCode }): NextResponse {
  const target = new URL(PAGE_LOGIN_SETTINGS_PATH, appOrigin());
  if ('pickCookie' in outcome) target.searchParams.set('instagram_pl', 'select');
  else {
    target.searchParams.set('instagram_pl', 'error');
    target.searchParams.set('code', outcome.code);
  }
  const response = NextResponse.redirect(target, { status: 303 });
  response.cookies.set(PAGE_LOGIN_STATE_COOKIE, '', { ...cookieBase(), maxAge: 0 });
  if ('pickCookie' in outcome) {
    response.cookies.set(PAGE_LOGIN_PICK_COOKIE, outcome.pickCookie, { ...cookieBase(), maxAge: Math.floor(PAGE_LOGIN_TTL_MS / 1000) });
  }
  response.headers.set('Cache-Control', 'private, no-store');
  response.headers.set('Referrer-Policy', 'no-referrer');
  return response;
}

function codeOf(error: unknown): CallbackCode {
  if (error instanceof PlanLimitError) return 'feature_unavailable';
  if (error instanceof InstagramError && (CALLBACK_CODES as readonly string[]).includes(error.code)) return error.code as CallbackCode;
  return 'save_failed';
}

export async function GET(request: Request) {
  if (!pageLoginConfig()) return back({ code: 'instagram_not_enabled' });
  let session;
  try {
    session = await requireSession(request);
  } catch {
    return back({ code: 'signed_out' });
  }
  if (!hasMinRole(session.role, 'admin')) return back({ code: 'forbidden' });
  const params = new URL(request.url).searchParams;
  // The admin declined on Facebook's consent page.
  if (params.get('error')) return back({ code: 'denied' });
  try {
    const { pickCookie } = await completePageLogin(actorOf(session), {
      state: params.get('state'),
      cookieState: (await cookies()).get(PAGE_LOGIN_STATE_COOKIE)?.value ?? null,
      code: params.get('code'),
    });
    return back({ pickCookie });
  } catch (error) {
    const code = codeOf(error);
    if (code === 'save_failed') console.error('[instagram] page login failed', error instanceof Error ? error.name : 'unknown');
    return back({ code });
  }
}
