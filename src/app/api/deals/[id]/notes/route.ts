// GET  /api/deals/{id}/notes — the deal's team notes, newest first (any member). 200 { notes }.
// POST /api/deals/{id}/notes { body } — add a note as the signed-in member (agents and above). 201 { note }.
//   400 invalid (empty or over 2,000 characters), 404 not_found (no such deal in this workspace).
// CSRF and mutation-origin are enforced by the proxy for every non-GET /api call.

import { NextResponse } from 'next/server';

import { requireRole } from '@/lib/auth/account';
import { tenantOf } from '@/lib/audience/http';
import { addDealNote, dealNoteErrorResponse, listDealNotes } from '@/lib/pipelines/deal-notes';
import { checkRateLimit, rateLimitResponse } from '@/lib/rate-limit';

const NO_STORE = { 'Cache-Control': 'private, no-store' };
const WRITE_LIMIT = { limit: 60, windowMs: 60_000 };

type Context = { params: Promise<{ id: string }> };

export async function GET(_request: Request, context: Context) {
  try {
    const ctx = await requireRole('viewer');
    const { id } = await context.params;
    return NextResponse.json({ notes: await listDealNotes(tenantOf(ctx), id) }, { headers: NO_STORE });
  } catch (error) {
    return dealNoteErrorResponse(error);
  }
}

export async function POST(request: Request, context: Context) {
  try {
    const ctx = await requireRole('agent');
    const { id } = await context.params;
    const limit = checkRateLimit(`dealNotes:${ctx.userId}`, WRITE_LIMIT);
    if (!limit.success) return rateLimitResponse(limit);
    const body = (await request.json().catch(() => null)) as { body?: unknown } | null;
    const note = await addDealNote({ ...tenantOf(ctx), userId: ctx.userId }, id, body?.body);
    return NextResponse.json({ note }, { status: 201, headers: NO_STORE });
  } catch (error) {
    return dealNoteErrorResponse(error);
  }
}
