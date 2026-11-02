// GET  /api/conversations/{id}/notes — the conversation's internal notes, oldest first
//      (latest 200; every member, viewers included).
// POST /api/conversations/{id}/notes — add a note (agent and above).
//      { body: string (1..4000), mentions?: uuid[] (≤20) }
//      Mentions keep only current members of this workspace; each gets one
//      'mention' notification. Notes are internal and never sent to the contact.

import { NextResponse } from 'next/server';

import { requireRole } from '@/lib/auth/account';
import { tenantOf } from '@/lib/audience/http';
import { withTenant } from '@/lib/db/tenant';
import { createConversationNote, listConversationNotes } from '@/lib/inbox/notes';
import { invalidNoteRequest, NOTE_WRITE_LIMIT, noteErrorResponse, noteHeaders, readJsonObject } from '@/lib/inbox/notes-http';
import { checkRateLimit, rateLimitResponse } from '@/lib/rate-limit';

type Context = { params: Promise<{ id: string }> };

export async function GET(_request: Request, context: Context) {
  try {
    const ctx = await requireRole('viewer');
    const { id } = await context.params;
    const notes = await withTenant(tenantOf(ctx), (tx) => listConversationNotes(tx, ctx.accountId, id));
    return NextResponse.json({ notes }, { headers: noteHeaders });
  } catch (error) {
    return noteErrorResponse(error);
  }
}

export async function POST(request: Request, context: Context) {
  try {
    const ctx = await requireRole('agent');
    const { id } = await context.params;
    const limit = checkRateLimit(`conversationNote:${ctx.userId}`, NOTE_WRITE_LIMIT);
    if (!limit.success) return rateLimitResponse(limit);
    const input = await readJsonObject(request);
    if (!input) return invalidNoteRequest();
    const { note } = await withTenant(tenantOf(ctx), (tx) =>
      createConversationNote(tx, { accountId: ctx.accountId, userId: ctx.userId, role: ctx.role }, id, {
        body: input.body,
        mentions: input.mentions,
      }));
    return NextResponse.json({ note }, { status: 201, headers: noteHeaders });
  } catch (error) {
    return noteErrorResponse(error);
  }
}
