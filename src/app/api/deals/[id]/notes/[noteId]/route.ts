// DELETE /api/deals/{id}/notes/{noteId} — delete a team note: its author, or an admin. 200 { ok }.
//   403 forbidden (someone else's note), 404 not_found.

import { NextResponse } from 'next/server';

import { requireRole } from '@/lib/auth/account';
import { tenantOf } from '@/lib/audience/http';
import { dealNoteErrorResponse, deleteDealNote } from '@/lib/pipelines/deal-notes';
import { checkRateLimit, rateLimitResponse } from '@/lib/rate-limit';

type Context = { params: Promise<{ id: string; noteId: string }> };

export async function DELETE(_request: Request, context: Context) {
  try {
    const ctx = await requireRole('agent');
    const { id, noteId } = await context.params;
    const limit = checkRateLimit(`dealNotes:${ctx.userId}`, { limit: 60, windowMs: 60_000 });
    if (!limit.success) return rateLimitResponse(limit);
    await deleteDealNote({ ...tenantOf(ctx), userId: ctx.userId }, id, noteId);
    return NextResponse.json({ ok: true }, { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (error) {
    return dealNoteErrorResponse(error);
  }
}
