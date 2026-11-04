// POST /api/integrations/zoom/connect — admin + integrations.meetings. Starts the
// admin-managed Zoom authorization (PKCE S256): returns { url } (Zoom's authorize
// page) and sets the signed, httpOnly state cookie the callback checks. The browser
// then navigates to the URL (a fetch cannot follow a cross-origin 302, so this
// answers JSON as the Shopify install route does). 503 not_configured without the
// deployment's Zoom app; 402 feature_unavailable when the plan lacks online_meetings.

import { NextResponse } from 'next/server';
import { appOrigin } from '@/lib/auth/csrf';
import { zoomConfig } from '@/lib/meetings/config';
import { startZoomConnect, ZOOM_OAUTH_COOKIE, ZOOM_OAUTH_COOKIE_PATH, ZOOM_STATE_TTL_MS } from '@/lib/meetings/connection';
import { actorOf, adminMutation, meetingErrorResponse, NO_STORE, zoomRouteError } from '../_lib/http';

export const runtime = 'nodejs';

export async function POST(request: Request) {
  try {
    if (!zoomConfig()) return meetingErrorResponse('not_configured');
    const session = await adminMutation(request);
    if (session instanceof NextResponse) return session;
    const { authorizeUrl, cookie } = await startZoomConnect(actorOf(session));
    const response = NextResponse.json({ url: authorizeUrl }, { headers: NO_STORE });
    response.cookies.set(ZOOM_OAUTH_COOKIE, cookie, {
      httpOnly: true,
      secure: appOrigin().startsWith('https:'),
      // The callback is a top-level navigation from Zoom, which Lax allows.
      sameSite: 'lax',
      path: ZOOM_OAUTH_COOKIE_PATH,
      maxAge: Math.floor(ZOOM_STATE_TTL_MS / 1000),
    });
    return response;
  } catch (error) {
    return zoomRouteError(error);
  }
}
