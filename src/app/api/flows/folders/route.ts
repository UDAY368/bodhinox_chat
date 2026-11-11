// GET  /api/flows/folders?channel=whatsapp|instagram — every member: the
//      section's folders with their flow counts.
// POST /api/flows/folders — agents and above (Origin + CSRF):
//      { channel, name } creates a folder. 409 name_taken, 422 invalid_name.
// Stage 5 (5F); see src/lib/flows/folders.ts.

import { NextResponse } from 'next/server';
import { ForbiddenError, toErrorResponse } from '@/lib/auth/account';
import { hasMinRole } from '@/lib/auth/roles';
import { assertMutation, requireSession } from '@/lib/auth/session';
import { isChannel } from '@/lib/channels/capabilities';
import { createFolder, folderErrorResponse, listFolders } from '@/lib/flows/folders';
import { getT } from '@/lib/i18n/translate';

export const runtime = 'nodejs';
const NO_STORE = { 'Cache-Control': 'no-store' };
const badChannel = () => NextResponse.json({ error: getT('Flows.channelSection')('channelInvalid') }, { status: 400, headers: NO_STORE });

export async function GET(request: Request) {
  try {
    const session = await requireSession(request);
    const channel = new URL(request.url).searchParams.get('channel');
    if (!channel || !isChannel(channel)) return badChannel();
    const folders = await listFolders({ accountId: session.accountId, userId: session.userId, role: session.role }, channel);
    return NextResponse.json({ folders }, { headers: NO_STORE });
  } catch (error) {
    return toErrorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    const session = await requireSession(request);
    await assertMutation(request, session);
    if (!hasMinRole(session.role, 'agent')) throw new ForbiddenError('Insufficient workspace role');
    const body = (await request.json().catch(() => null)) as { channel?: unknown; name?: unknown } | null;
    if (!body || typeof body.channel !== 'string' || !isChannel(body.channel)) return badChannel();
    const folder = await createFolder({ accountId: session.accountId, userId: session.userId, role: session.role }, body.channel, body.name);
    return NextResponse.json({ folder }, { status: 201, headers: NO_STORE });
  } catch (error) {
    return folderErrorResponse(error) ?? toErrorResponse(error);
  }
}
