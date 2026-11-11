// POST /api/instagram/page-login/start — admin. Starts the optional Facebook Page
// login: answers { url } (the Facebook dialog) and sets the signed, httpOnly,
// SameSite=Lax state cookie the callback checks. 503 instagram_not_enabled until
// INSTAGRAM_PAGE_LOGIN_ENABLED is on and configured; 402 when the plan lacks Instagram.

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { appOrigin } from '@/lib/auth/csrf';
import { pageLoginConfig } from '@/lib/instagram/config';
import { instagramErrorResponse, notEnabledResponse } from '@/lib/instagram/http';
import { PAGE_LOGIN_COOKIE_PATH, PAGE_LOGIN_STATE_COOKIE, PAGE_LOGIN_TTL_MS, startPageLogin } from '@/lib/instagram/page-login';
import { actorOf, adminMutation, NO_STORE, readJson, routeError } from '../../_lib/route';

export const runtime = 'nodejs';
/** Each attempt opens a Facebook consent page; a few per hour per user is plenty. */
const START_LIMIT = { limit: 10, windowMs: 60 * 60_000 };
const Body = z.object({}).strict();

export async function POST(request: Request) {
  try {
    if (!pageLoginConfig()) return notEnabledResponse();
    const session = await adminMutation(request, 'page-login-start', START_LIMIT);
    if (session instanceof NextResponse) return session;
    if (!Body.safeParse(await readJson(request)).success) return instagramErrorResponse('invalid_request');
    const { url, stateCookie } = await startPageLogin(actorOf(session));
    const response = NextResponse.json({ url }, { headers: NO_STORE });
    response.cookies.set(PAGE_LOGIN_STATE_COOKIE, stateCookie, {
      httpOnly: true,
      secure: appOrigin().startsWith('https:'),
      // The callback is a top-level navigation from Facebook, which Lax allows.
      sameSite: 'lax',
      path: PAGE_LOGIN_COOKIE_PATH,
      maxAge: Math.floor(PAGE_LOGIN_TTL_MS / 1000),
    });
    return response;
  } catch (error) {
    return routeError(error);
  }
}
