// GET /api/quick-replies/favourites — the caller's favourite quick reply ids (any member).
//   200 { quick_reply_ids: string[] }
// PUT /api/quick-replies/favourites — star or unstar one { quick_reply_id, favourite: boolean } (agents and above).
//   200 { quick_reply_id, favourite }; 400 invalid; 404 no such quick reply in this workspace.
// Favourites are private to each member; setting the same value twice is a no-op.

import { NextResponse } from 'next/server';

import { requireRole } from '@/lib/auth/account';
import { tenantOf } from '@/lib/audience/http';
import {
  inboxPreferenceErrorResponse,
  listQuickReplyFavourites,
  parseFavouriteBody,
  PREFERENCE_WRITE_LIMIT,
  setQuickReplyFavourite,
} from '@/lib/inbox/saved-filters-store';
import { checkRateLimit, rateLimitResponse } from '@/lib/rate-limit';

export async function GET() {
  try {
    const ctx = await requireRole('viewer');
    return NextResponse.json({ quick_reply_ids: await listQuickReplyFavourites(tenantOf(ctx)) });
  } catch (error) {
    return inboxPreferenceErrorResponse(error);
  }
}

export async function PUT(request: Request) {
  try {
    const ctx = await requireRole('agent');
    const limit = checkRateLimit(`quick-replies:favourites:${ctx.userId}`, PREFERENCE_WRITE_LIMIT);
    if (!limit.success) return rateLimitResponse(limit);
    const { quickReplyId, favourite } = parseFavouriteBody(await request.json().catch(() => null));
    await setQuickReplyFavourite(tenantOf(ctx), quickReplyId, favourite);
    return NextResponse.json({ quick_reply_id: quickReplyId, favourite });
  } catch (error) {
    return inboxPreferenceErrorResponse(error);
  }
}
