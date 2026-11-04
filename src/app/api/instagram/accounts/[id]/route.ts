// DELETE /api/instagram/accounts/{id} — admin. Disconnects the Instagram
// account: unsubscribes the webhook (best effort), clears the token and marks
// the row disconnected. Conversations and identities stay (read-only).
// 200 { account }; 404 not_found (also another workspace's id); 503 while off.

import { NextResponse } from 'next/server';
import { instagramConfig } from '@/lib/instagram/config';
import { disconnect } from '@/lib/instagram/connection';
import { instagramErrorResponse, notEnabledResponse } from '@/lib/instagram/http';
import { actorOf, adminMutation, isUuid, NO_STORE, routeError } from '../../_lib/route';

export const runtime = 'nodejs';
type Context = { params: Promise<{ id: string }> };

export async function DELETE(request: Request, context: Context) {
  try {
    if (!instagramConfig()) return notEnabledResponse();
    const session = await adminMutation(request, 'disconnect');
    if (session instanceof NextResponse) return session;
    const { id } = await context.params;
    if (!isUuid(id)) return instagramErrorResponse('not_found');
    const account = await disconnect(actorOf(session), id);
    return NextResponse.json({ account }, { headers: NO_STORE });
  } catch (error) {
    return routeError(error);
  }
}
