// GET /api/instagram/accounts/{id}/posts — admin. The account's recent posts
// for the comment-rule picker: { posts: [{ id, caption, mediaType, previewUrl,
// permalink, timestamp }] }. Read-only: the token stays server-side and nothing
// is written here or on Instagram. Same guard as the comment rules (plan
// feature, connected account, comments permission). 404 not_found (also another
// workspace's id); 409 token or permission; 429 rate limited; 502 meta_error;
// 503 while off.

import { NextResponse } from 'next/server';
import { hasMinRole } from '@/lib/auth/roles';
import { requireSession } from '@/lib/auth/session';
import { listRecentPosts } from '@/lib/instagram/comment-rules';
import { instagramConfig } from '@/lib/instagram/config';
import { instagramErrorResponse, notEnabledResponse } from '@/lib/instagram/http';
import { checkRateLimit, rateLimitResponse } from '@/lib/rate-limit';
import { actorOf, isUuid, NO_STORE, routeError } from '../../../_lib/route';

export const runtime = 'nodejs';
type Context = { params: Promise<{ id: string }> };
/** Each load is one Instagram call; opening the picker a few times a minute is plenty. */
const POSTS_LIMIT = { limit: 10, windowMs: 60_000 };

export async function GET(request: Request, context: Context) {
  try {
    if (!instagramConfig()) return notEnabledResponse();
    const session = await requireSession(request);
    if (!hasMinRole(session.role, 'admin')) return instagramErrorResponse('forbidden');
    const { id } = await context.params;
    if (!isUuid(id)) return instagramErrorResponse('not_found');
    const limited = checkRateLimit(`instagram:posts:${session.userId}`, POSTS_LIMIT);
    if (!limited.success) return rateLimitResponse(limited);
    return NextResponse.json({ posts: await listRecentPosts(actorOf(session), id) }, { headers: NO_STORE });
  } catch (error) {
    return routeError(error);
  }
}
