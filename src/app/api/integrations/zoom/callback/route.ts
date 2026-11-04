// GET /api/integrations/zoom/callback — Zoom's OAuth redirect. Checks that the
// admin who started the authorization is still signed in to the same workspace
// and still holds integrations.meetings, verifies the state against the signed
// cookie, exchanges the code (PKCE), checks the granted scopes, reads the Zoom
// account and stores the encrypted tokens. Always redirects back to Settings →
// Meetings & shipping with ?zoom=<outcome> and clears the state cookie.

import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { appOrigin } from '@/lib/auth/csrf';
import { requirePermission } from '@/lib/auth/permissions';
import { hasMinRole } from '@/lib/auth/roles';
import { requireSession } from '@/lib/auth/session';
import { zoomConfig } from '@/lib/meetings/config';
import { finishZoomConnect, ZOOM_OAUTH_COOKIE, ZOOM_OAUTH_COOKIE_PATH, ZOOM_SETTINGS_PATH } from '@/lib/meetings/connection';
import { MeetingError } from '@/lib/meetings/types';
import { actorOf } from '../_lib/http';

export const runtime = 'nodejs';

function back(outcome: string): NextResponse {
  const target = new URL(ZOOM_SETTINGS_PATH, appOrigin());
  target.searchParams.set('zoom', outcome);
  const response = NextResponse.redirect(target, { status: 303 });
  response.cookies.set(ZOOM_OAUTH_COOKIE, '', { path: ZOOM_OAUTH_COOKIE_PATH, maxAge: 0, httpOnly: true, sameSite: 'lax' });
  response.headers.set('Cache-Control', 'private, no-store');
  return response;
}

export async function GET(request: Request) {
  if (!zoomConfig()) return back('not_configured');
  let session;
  try {
    session = await requireSession(request);
  } catch {
    return back('signed_out');
  }
  if (!hasMinRole(session.role, 'admin')) return back('forbidden');
  try {
    await requirePermission(actorOf(session), 'integrations.meetings');
  } catch {
    return back('forbidden');
  }
  const params = new URL(request.url).searchParams;
  // The admin declined on Zoom's consent page.
  if (params.get('error')) return back('denied');
  try {
    await finishZoomConnect(actorOf(session), {
      code: params.get('code') ?? '',
      state: params.get('state') ?? '',
      cookie: (await cookies()).get(ZOOM_OAUTH_COOKIE)?.value ?? null,
    });
    return back('connected');
  } catch (error) {
    if (error instanceof MeetingError) return back(error.code);
    console.error('Zoom connection could not be saved', error instanceof Error ? error.name : 'unknown');
    return back('save_failed');
  }
}
