// POST /api/instagram/accounts/{id}/health — admin ("Check now"). Calls
// Instagram's /me with the account's token and records active,
// token_invalid or permission_missing (a change notifies admins).
// 200 { account }; 404 not_found; 429 rate limited (ours or Instagram's);
// 502 meta_error; 503 while off.

import { NextResponse } from 'next/server';
import { instagramConfig } from '@/lib/instagram/config';
import { getInstagramAccountView } from '@/lib/instagram/connection';
import { checkHealth } from '@/lib/instagram/health';
import { instagramErrorResponse, notEnabledResponse } from '@/lib/instagram/http';
import { actorOf, adminMutation, isUuid, NO_STORE, routeError } from '../../../_lib/route';

export const runtime = 'nodejs';
type Context = { params: Promise<{ id: string }> };
/** Each check is one Instagram call; a handful per minute per admin is plenty. */
const HEALTH_LIMIT = { limit: 6, windowMs: 60_000 };

export async function POST(request: Request, context: Context) {
  try {
    if (!instagramConfig()) return notEnabledResponse();
    const session = await adminMutation(request, 'health', HEALTH_LIMIT);
    if (session instanceof NextResponse) return session;
    const { id } = await context.params;
    if (!isUuid(id)) return instagramErrorResponse('not_found');
    const actor = actorOf(session);
    // The view is read as the member first, so another workspace's id is a 404 before any Instagram call.
    await getInstagramAccountView(actor, id);
    await checkHealth(actor.accountId, id);
    return NextResponse.json({ account: await getInstagramAccountView(actor, id) }, { headers: NO_STORE });
  } catch (error) {
    return routeError(error);
  }
}
