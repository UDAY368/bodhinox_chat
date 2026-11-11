// PATCH  /api/flows/folders/[id] — agents and above (Origin + CSRF): { name } renames.
// DELETE /api/flows/folders/[id] — agents and above (Origin + CSRF): deletes the
//        folder; its flows move to the top level, none is deleted.
// Another workspace's folder is 404 (RLS hides it). Stage 5 (5F).

import { NextResponse } from 'next/server';
import { ForbiddenError, toErrorResponse } from '@/lib/auth/account';
import { hasMinRole } from '@/lib/auth/roles';
import { assertMutation, requireSession, type AuthContext } from '@/lib/auth/session';
import { deleteFolder, FolderError, folderErrorResponse, renameFolder } from '@/lib/flows/folders';

export const runtime = 'nodejs';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function editor(request: Request, id: string): Promise<AuthContext> {
  const session = await requireSession(request);
  await assertMutation(request, session);
  if (!hasMinRole(session.role, 'agent')) throw new ForbiddenError('Insufficient workspace role');
  if (!UUID.test(id)) throw new FolderError('not_found');
  return session;
}

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const session = await editor(request, id);
    const body = (await request.json().catch(() => null)) as { name?: unknown } | null;
    await renameFolder({ accountId: session.accountId, userId: session.userId, role: session.role }, id, body?.name);
    return NextResponse.json({ ok: true }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    return folderErrorResponse(error) ?? toErrorResponse(error);
  }
}

export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const session = await editor(request, id);
    await deleteFolder({ accountId: session.accountId, userId: session.userId, role: session.role }, id);
    return NextResponse.json({ ok: true }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    return folderErrorResponse(error) ?? toErrorResponse(error);
  }
}
