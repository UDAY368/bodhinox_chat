// DELETE /api/media/library/<id> — remove a library file (admins, or the agent who uploaded it).
//   200 { outcome: 'deleted' } when nothing uses it: the row is soft-deleted and the stored object removed.
//   200 { outcome: 'hidden', references: MediaReferenceSource[], retained: boolean } when a message sent in the
//   last MEDIA_REFERENCE_DAYS days, a template, flow, automation, quick reply, product or form still points at it,
//   or its retain_until date is in the future: it leaves the library but its object stays so those keep working.
//   403 not allowed; 404 unknown or not in this workspace's library.

import { NextResponse } from 'next/server';

import { ForbiddenError } from '@/lib/auth/errors';
import { hasMinRole } from '@/lib/auth/roles';
import { assertMutation, requireSession } from '@/lib/auth/session';
import { withTenant } from '@/lib/db/tenant';
import { prepareLibraryDelete } from '@/lib/inbox/media-library';
import { mediaLibraryErrorResponse } from '@/lib/inbox/media-library-http';
import { removeMedia } from '@/lib/storage/server';

export const runtime = 'nodejs';

export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const ctx = await requireSession(request);
    await assertMutation(request, ctx);
    if (!hasMinRole(ctx.role, 'agent')) throw new ForbiddenError('Deleting media requires an agent role');
    const { id } = await params;
    const decision = await withTenant(ctx, (tx) => prepareLibraryDelete(tx, ctx.accountId, id, { userId: ctx.userId, role: ctx.role }));
    if (decision.outcome === 'hidden')
      return NextResponse.json({ outcome: 'hidden', references: decision.references, retained: decision.retained }, { headers: { 'Cache-Control': 'no-store' } });
    try {
      await removeMedia(ctx, decision.bucket, decision.objectKey);
    } catch (error) {
      // The row is already soft-deleted and out of the meter; a leftover object is a storage nit, not a user error.
      console.error('Media library object removal failed', error instanceof Error ? error.name : 'unknown');
    }
    return NextResponse.json({ outcome: 'deleted' }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    return mediaLibraryErrorResponse(error);
  }
}
