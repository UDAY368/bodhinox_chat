// PATCH  /api/conversations/{id}/notes/{noteId} — edit a note's text (its author only, agent and above).
//        { body: string (1..4000), mentions?: uuid[] (≤20) }
//        Members newly mentioned are notified; ones already notified for this note are not.
// DELETE /api/conversations/{id}/notes/{noteId} — soft-delete (its author, or an admin/owner).

import { NextResponse } from 'next/server';

import { requireRole } from '@/lib/auth/account';
import { tenantOf } from '@/lib/audience/http';
import { withTenant } from '@/lib/db/tenant';
import { deleteConversationNote, updateConversationNote } from '@/lib/inbox/notes';
import { invalidNoteRequest, NOTE_WRITE_LIMIT, noteErrorResponse, noteHeaders, readJsonObject } from '@/lib/inbox/notes-http';
import { checkRateLimit, rateLimitResponse } from '@/lib/rate-limit';

type Context = { params: Promise<{ id: string; noteId: string }> };

export async function PATCH(request: Request, context: Context) {
  try {
    const ctx = await requireRole('agent');
    const { id, noteId } = await context.params;
    const limit = checkRateLimit(`conversationNote:${ctx.userId}`, NOTE_WRITE_LIMIT);
    if (!limit.success) return rateLimitResponse(limit);
    const input = await readJsonObject(request);
    if (!input) return invalidNoteRequest();
    const { note } = await withTenant(tenantOf(ctx), (tx) =>
      updateConversationNote(tx, { accountId: ctx.accountId, userId: ctx.userId, role: ctx.role }, id, noteId, {
        body: input.body,
        mentions: input.mentions,
      }));
    return NextResponse.json({ note }, { headers: noteHeaders });
  } catch (error) {
    return noteErrorResponse(error);
  }
}

export async function DELETE(_request: Request, context: Context) {
  try {
    const ctx = await requireRole('agent');
    const { id, noteId } = await context.params;
    await withTenant(tenantOf(ctx), (tx) =>
      deleteConversationNote(tx, { accountId: ctx.accountId, userId: ctx.userId, role: ctx.role }, id, noteId));
    return NextResponse.json({ ok: true }, { headers: noteHeaders });
  } catch (error) {
    return noteErrorResponse(error);
  }
}
