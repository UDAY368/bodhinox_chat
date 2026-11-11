// GET /api/instagram/accounts/{id}/media — agent and up (anyone who may edit
// flows). The account's recent posts for the flow builder's comment-trigger
// picker: { posts: [{ id, caption, mediaType, previewUrl, permalink, timestamp, isReel }], next }.
// ?after=<next> reads the following page (next is null on the last one).
// Read-only: the token stays server-side and nothing is written here or on
// Instagram. 403 below agent; 404 not_found (also another workspace's id);
// 409 token or disconnected; 429 rate limited; 502 meta_error; 503 while off.

import { NextResponse } from 'next/server';
import { hasMinRole } from '@/lib/auth/roles';
import { requireSession } from '@/lib/auth/session';
import { instagramConfig } from '@/lib/instagram/config';
import { instagramErrorResponse, notEnabledResponse } from '@/lib/instagram/http';
import { listPickerMedia } from '@/lib/instagram/media-picker';
import { checkRateLimit, rateLimitResponse } from '@/lib/rate-limit';
import { actorOf, isUuid, NO_STORE, routeError } from '../../../_lib/route';

export const runtime = 'nodejs';
type Context = { params: Promise<{ id: string }> };
/** Each load is one Instagram call; opening the picker a few times a minute is plenty. */
const MEDIA_LIMIT = { limit: 10, windowMs: 60_000 };

export async function GET(request: Request, context: Context) {
  try {
    if (!instagramConfig()) return notEnabledResponse();
    const session = await requireSession(request);
    if (!hasMinRole(session.role, 'agent')) return instagramErrorResponse('forbidden');
    const { id } = await context.params;
    if (!isUuid(id)) return instagramErrorResponse('not_found');
    const limited = checkRateLimit(`instagram:media:${session.userId}`, MEDIA_LIMIT);
    if (!limited.success) return rateLimitResponse(limited);
    const after = new URL(request.url).searchParams.get('after') ?? undefined;
    const page = await listPickerMedia(actorOf(session), id, after);
    return NextResponse.json({ posts: page.media, next: page.next }, { headers: NO_STORE });
  } catch (error) {
    return routeError(error);
  }
}
