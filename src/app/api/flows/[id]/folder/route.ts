// PUT /api/flows/[id]/folder — agents and above (Origin + CSRF):
//   { folder_id: uuid | null } files the flow in a folder of its channel, or
//   moves it to the top level. Another workspace's flow or folder is 404; a
//   folder of the other channel is 422 wrong_channel. Stage 5 (5F).

import { NextResponse } from 'next/server';
import { ForbiddenError, toErrorResponse } from '@/lib/auth/account';
import { hasMinRole } from '@/lib/auth/roles';
import { assertMutation, requireSession } from '@/lib/auth/session';
import { FolderError, folderErrorResponse, moveFlowToFolder } from '@/lib/flows/folders';

export const runtime = 'nodejs';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function PUT(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const session = await requireSession(request);
    await assertMutation(request, session);
    if (!hasMinRole(session.role, 'agent')) throw new ForbiddenError('Insufficient workspace role');
    if (!UUID.test(id)) throw new FolderError('flow_not_found');
    const body = (await request.json().catch(() => null)) as { folder_id?: unknown } | null;
    const folderId = body?.folder_id;
    if (folderId !== null && (typeof folderId !== 'string' || !UUID.test(folderId))) throw new FolderError('not_found');
    await moveFlowToFolder({ accountId: session.accountId, userId: session.userId, role: session.role }, id, folderId);
    return NextResponse.json({ ok: true }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    return folderErrorResponse(error) ?? toErrorResponse(error);
  }
}
