// POST /api/meta-ads/ai — admin, CSRF. AI help for the Create ad dialog.
//   { action: 'copy', kind, brief, language? } -> 200 { variants: [{ primaryText, headline, description }] }
//   { action: 'image', adAccountId, prompt } -> 200 { hash, url, preview } — the image is made by the
//     workspace's AI provider (Gemini or OpenAI) and uploaded to the ad account's image library.
// Suggestions only: nothing is created until the admin submits the ad. Each request is billed as one AI
// message. 503 meta_ads_not_enabled / manage_not_enabled, 400 invalid_request / ai_not_configured /
// image_not_supported, 403, 422 image_refused, 429, 502. The brief, prompt and output are never logged.

import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth/account';
import { assertMutation, requireSession } from '@/lib/auth/session';
import { loadAiConfig } from '@/lib/ai/config';
import { requestMeter, ROUTE_GENERATION_TOKENS } from '@/lib/ai/budget';
import { AD_BRIEF_MAX, AD_IMAGE_PROMPT_MAX, canGenerateImages, generateAdImage, suggestAdCopy, type AdCopyKind } from '@/lib/ai/ad-creative';
import { AiError } from '@/lib/ai/types';
import { metaAdsConfig, metaAdsManageEnabled } from '@/lib/meta-ads/config';
import { isAdImage, uploadImageForAd } from '@/lib/meta-ads/create';
import { actorOf, metaAdsErrorResponse, metaAdsRouteError, notEnabledResponse, NO_STORE } from '@/lib/meta-ads/http';
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit';

export const runtime = 'nodejs';
const KINDS: readonly AdCopyKind[] = ['whatsapp', 'instagram_direct', 'lead_form', 'website'];
/** An image generation is a large token spend; reserve generously, settle the estimate. */
const IMAGE_TOKENS = 4_000;

export async function POST(request: Request) {
  try {
    if (!metaAdsConfig()) return notEnabledResponse();
    if (!metaAdsManageEnabled()) return metaAdsErrorResponse('manage_not_enabled');
    const session = await requireSession(request);
    await assertMutation(request, session);
    const { db, accountId, userId } = await requireRole('admin');
    const userLimit = checkRateLimit(`ai-ads:${userId}`, RATE_LIMITS.aiDraft);
    if (!userLimit.success) return rateLimitResponse(userLimit);
    const accountLimit = checkRateLimit(`ai-draft-acct:${accountId}`, RATE_LIMITS.aiDraftAccount);
    if (!accountLimit.success) return rateLimitResponse(accountLimit);

    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    const action = body?.action;
    if (action !== 'copy' && action !== 'image') return metaAdsErrorResponse('invalid_request');
    const config = await loadAiConfig(db, accountId, { requireActive: false }).catch(() => null);
    if (!config) return NextResponse.json({ error: 'ai_not_configured' }, { status: 400, headers: NO_STORE });

    if (action === 'copy') {
      const kind = body?.kind as AdCopyKind;
      const brief = typeof body?.brief === 'string' ? body.brief.trim() : '';
      const language = typeof body?.language === 'string' && /^[A-Za-z ()-]{2,40}$/.test(body.language) ? body.language : null;
      if (!KINDS.includes(kind) || !brief || brief.length > AD_BRIEF_MAX) return metaAdsErrorResponse('invalid_request');
      const meter = requestMeter(accountId, ROUTE_GENERATION_TOKENS, { conversationId: null, mode: 'draft', provider: config.provider, model: config.model });
      const variants = await suggestAdCopy({ config, kind, brief, language, hooks: meter.hooks }).catch(async (error: unknown) => {
        await meter.finish(error);
        throw error;
      });
      await meter.finish();
      return NextResponse.json({ variants }, { headers: NO_STORE });
    }

    const adAccountId = typeof body?.adAccountId === 'string' ? body.adAccountId : '';
    const prompt = typeof body?.prompt === 'string' ? body.prompt.trim() : '';
    if (!/^\d{1,32}$/.test(adAccountId) || !prompt || prompt.length > AD_IMAGE_PROMPT_MAX) return metaAdsErrorResponse('invalid_request');
    if (!canGenerateImages(config)) return NextResponse.json({ error: 'image_not_supported' }, { status: 400, headers: NO_STORE });
    const meter = requestMeter(accountId, IMAGE_TOKENS, { conversationId: null, mode: 'draft', provider: config.provider, model: config.model });
    let bytes: Uint8Array;
    try {
      await meter.hooks.beforeAttempt();
      bytes = await generateAdImage(config, prompt);
      meter.hooks.afterAttempt(null, { promptChars: prompt.length, outputChars: IMAGE_TOKENS * 4 });
      await meter.finish();
    } catch (error) {
      await meter.finish(error);
      throw error;
    }
    if (!isAdImage(bytes)) return NextResponse.json({ error: 'image_failed' }, { status: 502, headers: NO_STORE });
    const uploaded = await uploadImageForAd(actorOf(session), adAccountId, Buffer.from(bytes), 'ai-image.png');
    const mime = bytes[0] === 0xff ? 'image/jpeg' : 'image/png';
    return NextResponse.json({ ...uploaded, preview: `data:${mime};base64,${Buffer.from(bytes).toString('base64')}` }, { headers: NO_STORE });
  } catch (error) {
    if (error instanceof AiError) return NextResponse.json({ error: error.code }, { status: error.status, headers: NO_STORE });
    return metaAdsRouteError(error);
  }
}
