// POST /api/instagram/connect { comments?: boolean } — admin. Starts Instagram
// Login: answers { url } (Instagram's authorize page) and sets the signed,
// httpOnly, SameSite=Lax state cookie the callback checks. The browser then
// navigates to the URL (a fetch cannot follow a cross-origin redirect).
// 503 instagram_not_enabled before anything else; 402 when the plan lacks
// Instagram; 400 invalid_request; 429 rate limited.

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { appOrigin } from '@/lib/auth/csrf';
import { instagramConfig } from '@/lib/instagram/config';
import {
  INSTAGRAM_OAUTH_COOKIE, INSTAGRAM_OAUTH_COOKIE_PATH, INSTAGRAM_STATE_TTL_MS, startConnect,
} from '@/lib/instagram/connection';
import { instagramErrorResponse, notEnabledResponse } from '@/lib/instagram/http';
import { actorOf, adminMutation, NO_STORE, readJson, routeError } from '../_lib/route';

export const runtime = 'nodejs';
/** Each attempt opens an Instagram consent page; a few per hour per user is plenty. */
const CONNECT_LIMIT = { limit: 10, windowMs: 60 * 60_000 };
const Body = z.object({ comments: z.boolean().optional() }).strict();

export async function POST(request: Request) {
  try {
    if (!instagramConfig()) return notEnabledResponse();
    const session = await adminMutation(request, 'connect', CONNECT_LIMIT);
    if (session instanceof NextResponse) return session;
    const parsed = Body.safeParse(await readJson(request));
    if (!parsed.success) return instagramErrorResponse('invalid_request');
    const { url, stateCookie } = await startConnect(actorOf(session), { comments: parsed.data.comments === true });
    const response = NextResponse.json({ url }, { headers: NO_STORE });
    response.cookies.set(INSTAGRAM_OAUTH_COOKIE, stateCookie, {
      httpOnly: true,
      secure: appOrigin().startsWith('https:'),
      // The callback is a top-level navigation from Instagram, which Lax allows.
      sameSite: 'lax',
      path: INSTAGRAM_OAUTH_COOKIE_PATH,
      maxAge: Math.floor(INSTAGRAM_STATE_TTL_MS / 1000),
    });
    return response;
  } catch (error) {
    return routeError(error);
  }
}
