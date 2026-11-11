// POST /api/instagram/page-login/pages — admin. The Instagram accounts reachable
// through the Facebook Pages the person manages: { accounts: [{ instagramUserId,
// username, pageId, pageName }] }. Reads the sealed cookie the callback set; the
// user token never leaves the server. A POST because it calls Meta with the stored
// token, so it needs the same Origin/CSRF proof as every other external action.

import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { z } from 'zod';
import { pageLoginConfig } from '@/lib/instagram/config';
import { instagramErrorResponse, notEnabledResponse } from '@/lib/instagram/http';
import { listPageAccounts, PAGE_LOGIN_PICK_COOKIE } from '@/lib/instagram/page-login';
import { actorOf, adminMutation, NO_STORE, readJson, routeError } from '../../_lib/route';

export const runtime = 'nodejs';
const PAGES_LIMIT = { limit: 20, windowMs: 60 * 60_000 };
const Body = z.object({}).strict();

export async function POST(request: Request) {
  try {
    if (!pageLoginConfig()) return notEnabledResponse();
    const session = await adminMutation(request, 'page-login-pages', PAGES_LIMIT);
    if (session instanceof NextResponse) return session;
    if (!Body.safeParse(await readJson(request)).success) return instagramErrorResponse('invalid_request');
    const accounts = await listPageAccounts(actorOf(session), (await cookies()).get(PAGE_LOGIN_PICK_COOKIE)?.value ?? null);
    return NextResponse.json({ accounts }, { headers: NO_STORE });
  } catch (error) {
    return routeError(error);
  }
}
