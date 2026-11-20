// POST /api/meta-ads/videos multipart { file, adAccountId } — admin, CSRF.
// Uploads an MP4 or MOV (up to 30 MB) to a linked ad account's video library
// for a new video ad; Meta processes it, and the ad's creative step waits until
// it is ready. 200 { id }. 503 meta_ads_not_enabled / manage_not_enabled,
// 400 invalid_request / invalid_choice, 403, 409 token_invalid / missing_scope, 429, 502.

import { NextResponse } from 'next/server';
import { readBoundedBody } from '@/lib/api/bounded-body';
import { assertMutation, requireSession } from '@/lib/auth/session';
import { metaAdsConfig } from '@/lib/meta-ads/config';
import { isAdVideo, MAX_VIDEO_BYTES, uploadVideoForAd } from '@/lib/meta-ads/create';
import { actorOf, metaAdsErrorResponse, metaAdsRouteError, notEnabledResponse, NO_STORE } from '@/lib/meta-ads/http';
import { checkRateLimit, rateLimitResponse } from '@/lib/rate-limit';

export const runtime = 'nodejs';
const BODY_LIMIT = MAX_VIDEO_BYTES + 256 * 1024;
/** Video uploads are large: a handful per hour per workspace. */
const VIDEO_LIMIT = { limit: 20, windowMs: 60 * 60_000 };

export async function POST(request: Request) {
  try {
    if (!metaAdsConfig()) return notEnabledResponse();
    const session = await requireSession(request);
    await assertMutation(request, session);
    const limit = await checkRateLimit(`metaAdsVideo:${session.accountId}`, VIDEO_LIMIT);
    if (!limit.success) return rateLimitResponse(limit);
    const body = await readBoundedBody(request, BODY_LIMIT);
    const form = await new Response(body, { headers: { 'Content-Type': request.headers.get('Content-Type') || '' } })
      .formData().catch(() => null);
    const file = form?.get('file');
    const adAccountId = form?.get('adAccountId');
    if (!(file instanceof File) || file.size <= 0 || file.size > MAX_VIDEO_BYTES || typeof adAccountId !== 'string') {
      return metaAdsErrorResponse('invalid_request');
    }
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (!isAdVideo(bytes)) return metaAdsErrorResponse('invalid_request');
    return NextResponse.json(await uploadVideoForAd(actorOf(session), adAccountId, bytes, file.name || 'video.mp4'), { headers: NO_STORE });
  } catch (error) {
    return metaAdsRouteError(error);
  }
}
