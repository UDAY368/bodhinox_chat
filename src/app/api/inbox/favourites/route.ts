// GET /api/inbox/favourites (any member) — the caller's favourite conversations they may
//   still see: 200 { conversation_ids: string[] }.
// PUT /api/inbox/favourites (any member) — { conversation_id, favourite: boolean }:
//   200 { ok: true } (idempotent); 400 invalid_body; 404 when the conversation is not in
//   this workspace or hidden from the caller by agent visibility.
// Favourites are personal: nobody else reads or changes them. CSRF/mutation origin is
// enforced by src/proxy.ts.
import { NextResponse } from 'next/server';

import { requireRole } from '@/lib/auth/account';
import { tenantOf } from '@/lib/audience/http';
import { listFavourites, parseFavouriteInput, setFavourite } from '@/lib/inbox/favourites';
import { LABEL_WRITE_LIMIT, labelErrorResponse } from '@/lib/inbox/labels';
import { checkRateLimit, rateLimitResponse } from '@/lib/rate-limit';

const headers = { 'Cache-Control': 'private, no-store' };

export async function GET() {
  try {
    const ctx = await requireRole('viewer');
    return NextResponse.json({ conversation_ids: await listFavourites(tenantOf(ctx)) }, { headers });
  } catch (error) {
    return labelErrorResponse(error);
  }
}

export async function PUT(request: Request) {
  try {
    const ctx = await requireRole('viewer');
    const limit = checkRateLimit(`inbox:favourites:${ctx.userId}`, LABEL_WRITE_LIMIT);
    if (!limit.success) return rateLimitResponse(limit);
    const input = parseFavouriteInput(await request.json().catch(() => null));
    await setFavourite(tenantOf(ctx), input.conversationId, input.favourite);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return labelErrorResponse(error);
  }
}
