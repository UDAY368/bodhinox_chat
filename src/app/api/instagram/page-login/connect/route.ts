// POST /api/instagram/page-login/connect { instagramUserId } — admin. Connects the
// chosen Instagram account through its Facebook Page: the Page and its token come
// from Meta's own list for the sealed user token, never from the client. Answers
// { instagramAccountId } and clears the sealed cookie. 503 instagram_not_enabled
// while the flag is off; 400 state_mismatch when the sealed cookie is missing or
// expired; 404 not_found for an account the person's Pages do not link; 409
// account_in_use; 402 limit_reached. No token in the response.

import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { z } from 'zod';
import { appOrigin } from '@/lib/auth/csrf';
import { pageLoginConfig } from '@/lib/instagram/config';
import { instagramErrorResponse, notEnabledResponse } from '@/lib/instagram/http';
import { connectPageAccount, PAGE_LOGIN_COOKIE_PATH, PAGE_LOGIN_PICK_COOKIE } from '@/lib/instagram/page-login';
import { actorOf, adminMutation, NO_STORE, readJson, routeError } from '../../_lib/route';

export const runtime = 'nodejs';
const CONNECT_LIMIT = { limit: 10, windowMs: 60 * 60_000 };
const Body = z.object({ instagramUserId: z.string().regex(/^\d{1,32}$/) }).strict();

export async function POST(request: Request) {
  try {
    if (!pageLoginConfig()) return notEnabledResponse();
    const session = await adminMutation(request, 'page-login-connect', CONNECT_LIMIT);
    if (session instanceof NextResponse) return session;
    const parsed = Body.safeParse(await readJson(request));
    if (!parsed.success) return instagramErrorResponse('invalid_request');
    const result = await connectPageAccount(actorOf(session), {
      pickCookie: (await cookies()).get(PAGE_LOGIN_PICK_COOKIE)?.value ?? null,
      instagramUserId: parsed.data.instagramUserId,
    });
    const response = NextResponse.json(result, { headers: NO_STORE });
    response.cookies.set(PAGE_LOGIN_PICK_COOKIE, '', {
      path: PAGE_LOGIN_COOKIE_PATH, maxAge: 0, httpOnly: true, sameSite: 'lax', secure: appOrigin().startsWith('https:'),
    });
    return response;
  } catch (error) {
    return routeError(error);
  }
}
