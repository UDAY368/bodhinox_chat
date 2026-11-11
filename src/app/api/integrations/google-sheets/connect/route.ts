// POST /api/integrations/google-sheets/connect — admin (Stage 5, 5G). Starts the Google
// authorization (PKCE S256): returns { url } (Google's consent page) and sets the signed, httpOnly
// state cookie the callback checks. The browser then navigates to the URL. 503 not_enabled while
// GOOGLE_SHEETS_ENABLED or the OAuth client is missing. Origin + CSRF proof required.

import { NextResponse } from 'next/server';
import { appOrigin } from '@/lib/auth/csrf';
import { SHEETS_OAUTH_COOKIE, SHEETS_OAUTH_COOKIE_PATH, SHEETS_STATE_TTL_MS, startSheetsConnect } from '@/lib/integrations/google-sheets/connection';
import { NO_STORE, sheetsActorOf, sheetsAdminMutation, sheetsErrorResponse } from '@/lib/integrations/google-sheets/http';

export const runtime = 'nodejs';

export async function POST(request: Request) {
  try {
    const session = await sheetsAdminMutation(request);
    if (session instanceof NextResponse) return session;
    const { authorizeUrl, cookie } = startSheetsConnect(sheetsActorOf(session));
    const response = NextResponse.json({ url: authorizeUrl }, { headers: NO_STORE });
    response.cookies.set(SHEETS_OAUTH_COOKIE, cookie, {
      httpOnly: true,
      secure: appOrigin().startsWith('https:'),
      // The callback is a top-level navigation from Google, which Lax allows.
      sameSite: 'lax',
      path: SHEETS_OAUTH_COOKIE_PATH,
      maxAge: Math.floor(SHEETS_STATE_TTL_MS / 1000),
    });
    return response;
  } catch (error) {
    return sheetsErrorResponse(error);
  }
}
