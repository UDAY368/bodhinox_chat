// POST /api/meta-ads/images multipart { file, adAccountId } — admin, CSRF.
// Uploads a JPEG or PNG (up to 8 MB) to a linked ad account's image library
// for a new ad. Meta stores images by content hash, so a repeat upload is
// harmless. 200 { hash, url }. 503 meta_ads_not_enabled / manage_not_enabled,
// 400 invalid_request / invalid_choice, 403, 409 token_invalid, 429, 502.

import { NextResponse } from 'next/server';
import { readBoundedBody } from '@/lib/api/bounded-body';
import { assertMutation, requireSession } from '@/lib/auth/session';
import { metaAdsConfig } from '@/lib/meta-ads/config';
import { isAdImage, MAX_IMAGE_BYTES, uploadImageForAd } from '@/lib/meta-ads/create';
import { actorOf, metaAdsErrorResponse, metaAdsRouteError, notEnabledResponse, NO_STORE } from '@/lib/meta-ads/http';
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit';

export const runtime = 'nodejs';
const BODY_LIMIT = MAX_IMAGE_BYTES + 256 * 1024;

export async function POST(request: Request) {
  try {
    if (!metaAdsConfig()) return notEnabledResponse();
    const session = await requireSession(request);
    await assertMutation(request, session);
    const limit = checkRateLimit(`metaAdsImage:${session.userId}`, RATE_LIMITS.adminAction);
    if (!limit.success) return rateLimitResponse(limit);
    const body = await readBoundedBody(request, BODY_LIMIT);
    const form = await new Response(body, { headers: { 'Content-Type': request.headers.get('Content-Type') || '' } })
      .formData().catch(() => null);
    const file = form?.get('file');
    const adAccountId = form?.get('adAccountId');
    if (!(file instanceof File) || file.size <= 0 || file.size > MAX_IMAGE_BYTES || typeof adAccountId !== 'string') {
      return metaAdsErrorResponse('invalid_request');
    }
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (!isAdImage(bytes)) return metaAdsErrorResponse('invalid_request');
    const result = await uploadImageForAd(actorOf(session), adAccountId, Buffer.from(bytes), file.name || 'image');
    return NextResponse.json(result, { headers: NO_STORE });
  } catch (error) {
    return metaAdsRouteError(error);
  }
}
