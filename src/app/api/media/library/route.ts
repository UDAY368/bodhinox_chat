// GET  /api/media/library?kind=image|video|audio|document&q=&cursor=&limit= — library items, newest first (any member).
//   200 { items: MediaLibraryItem[], next_cursor: string | null, can_upload: boolean, usage?: MediaStorageUsage }
//   `usage` (workspace storage meter) is included on the first page only. 400 bad kind, cursor or limit.
// POST /api/media/library multipart { file } — store one file in chat-media under account-<id>/library/ and add it
//   to the library (agent+, rate limited). 201 { item }; 400 unsupported type; 413 too large; 503 storage not configured.
// Items carry the private /api/media/object proxy URL, never a storage credential or signed link.

import { NextResponse } from 'next/server';

import { readBoundedBody } from '@/lib/api/bounded-body';
import { ForbiddenError } from '@/lib/auth/errors';
import { hasMinRole } from '@/lib/auth/roles';
import { assertMutation, requireSession } from '@/lib/auth/session';
import { withTenant } from '@/lib/db/tenant';
import { mediaLibraryErrorResponse } from '@/lib/inbox/media-library-http';
import {
  addToLibrary,
  getStorageUsage,
  listLibraryMedia,
  MediaLibraryError,
  MEDIA_LIBRARY_BUCKET,
  MEDIA_LIBRARY_SUBFOLDER,
  parseListQuery,
} from '@/lib/inbox/media-library';
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit';
import { putMedia } from '@/lib/storage/server';
import { buildMediaPath, MEDIA_MAX_BYTES } from '@/lib/storage/upload-media';

export const runtime = 'nodejs';

const BODY_LIMIT = MEDIA_MAX_BYTES + 1024 * 1024;
const noStore = { 'Cache-Control': 'no-store' };

export async function GET(request: Request) {
  try {
    const ctx = await requireSession(request);
    const query = parseListQuery(new URL(request.url).searchParams);
    const viewer = { userId: ctx.userId, role: ctx.role };
    const result = await withTenant(ctx, async (tx) => ({
      ...(await listLibraryMedia(tx, ctx.accountId, query, viewer)),
      ...(query.cursor ? {} : { usage: await getStorageUsage(tx, ctx.accountId) }),
    }));
    return NextResponse.json({ ...result, can_upload: hasMinRole(ctx.role, 'agent') }, { headers: noStore });
  } catch (error) {
    return mediaLibraryErrorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    const ctx = await requireSession(request);
    await assertMutation(request, ctx);
    if (!hasMinRole(ctx.role, 'agent')) throw new ForbiddenError('Uploads require an agent role');
    const limit = checkRateLimit(`media-library:upload:${ctx.userId}`, RATE_LIMITS.send);
    if (!limit.success) return rateLimitResponse(limit);
    const bytes = await readBoundedBody(request, BODY_LIMIT);
    const form = await new Response(bytes, { headers: { 'Content-Type': request.headers.get('Content-Type') || '' } })
      .formData()
      .catch(() => null);
    const file = form?.get('file');
    if (!(file instanceof File) || file.size <= 0 || file.size > MEDIA_MAX_BYTES) throw new MediaLibraryError('Choose a file up to 16 MB', 'invalid_upload');
    const path = buildMediaPath(ctx.accountId, file.name, Date.now(), MEDIA_LIBRARY_SUBFOLDER);
    await putMedia(ctx, MEDIA_LIBRARY_BUCKET, path, new Uint8Array(await file.arrayBuffer()), file.type);
    const item = await withTenant(ctx, (tx) => addToLibrary(tx, ctx.accountId, path, file.name, { userId: ctx.userId, role: ctx.role }));
    return NextResponse.json({ item }, { status: 201, headers: noStore });
  } catch (error) {
    return mediaLibraryErrorResponse(error);
  }
}
