// GET /api/integrations/google-sheets/callback — Google's OAuth redirect (Stage 5, 5G). Checks
// that the admin who started the authorization is still signed in to the same workspace with the
// admin role, verifies the state against the signed cookie, exchanges the code (PKCE) and stores
// the encrypted refresh token. Always redirects back to Settings with ?google_sheets=<outcome> and
// clears the state cookie. Nothing from Google's answer is logged.

import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { appOrigin } from '@/lib/auth/csrf';
import { hasMinRole } from '@/lib/auth/roles';
import { requireSession } from '@/lib/auth/session';
import { googleSheetsConfig } from '@/lib/integrations/google-sheets/config';
import {
  finishSheetsConnect, SHEETS_OAUTH_COOKIE, SHEETS_OAUTH_COOKIE_PATH, SHEETS_SETTINGS_PATH, SheetsConnectionError,
} from '@/lib/integrations/google-sheets/connection';
import { sheetsActorOf } from '@/lib/integrations/google-sheets/http';

export const runtime = 'nodejs';

function back(outcome: string): NextResponse {
  const target = new URL(SHEETS_SETTINGS_PATH, appOrigin());
  target.searchParams.set('google_sheets', outcome);
  const response = NextResponse.redirect(target, { status: 303 });
  response.cookies.set(SHEETS_OAUTH_COOKIE, '', { path: SHEETS_OAUTH_COOKIE_PATH, maxAge: 0, httpOnly: true, sameSite: 'lax' });
  response.headers.set('Cache-Control', 'private, no-store');
  return response;
}

export async function GET(request: Request) {
  if (!googleSheetsConfig()) return back('not_enabled');
  let session;
  try {
    session = await requireSession(request);
  } catch {
    return back('signed_out');
  }
  if (!hasMinRole(session.role, 'admin')) return back('forbidden');
  const params = new URL(request.url).searchParams;
  // The admin declined on Google's consent page.
  if (params.get('error')) return back('denied');
  try {
    await finishSheetsConnect(sheetsActorOf(session), {
      code: params.get('code') ?? '',
      state: params.get('state') ?? '',
      cookie: (await cookies()).get(SHEETS_OAUTH_COOKIE)?.value ?? null,
    });
    return back('connected');
  } catch (error) {
    if (error instanceof SheetsConnectionError) return back(error.code);
    console.error('[google sheets] connection could not be saved', { error: error instanceof Error ? error.name : 'unknown' });
    return back('save_failed');
  }
}
