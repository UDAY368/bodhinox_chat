// /api/meta-ads/drafts — ads created from Bodhinox.
// GET (any member): { drafts } — the latest 20, with their progress.
// POST (admin, CSRF):
//   { action: 'create', ...input } — records the ad and queues its creation;
//     202 { draft }. The worker makes the campaign, ad set, creative and ad.
//   { action: 'recheck', id } — an 'unknown' draft: looks the unclear step up
//     at Meta again (a read); 200 { draft }.
//   { action: 'discard', id } — gives up on a failed or unknown draft; 200 { draft }.
//   { action: 'duplicate', id } — a paused copy as a new campaign; 202 { draft }.
//   { action: 'variant', sourceId, primaryText, headline?, description?, imageHash, imageUrl?, name? } —
//     an A/B variant: a second ad in the source ad's ad set; 202 { draft }. With replace: true
//     it is an edit of a running ad: the source ad is paused once the new one exists.
// 503 meta_ads_not_enabled / manage_not_enabled, 400 invalid_request /
// invalid_choice, 403, 404, 409 missing_scope / token_invalid, 422
// over_budget_cap, 429, 502 meta_error.

import { NextResponse } from 'next/server';
import { assertMutation, requireSession } from '@/lib/auth/session';
import { metaAdsConfig } from '@/lib/meta-ads/config';
import {
  discardAdDraft, duplicateAdDraft, listAdDrafts, parseAdCreateInput, parseAdVariantInput, recheckAdDraft, requestAdCreate, requestAdVariant,
} from '@/lib/meta-ads/create';
import { actorOf, metaAdsErrorResponse, metaAdsRouteError, notEnabledResponse, NO_STORE } from '@/lib/meta-ads/http';
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit';

export const runtime = 'nodejs';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Ads cost money: a few creations per hour per workspace is plenty. */
const CREATE_LIMIT = { limit: 20, windowMs: 60 * 60_000 };

export async function GET(request: Request) {
  try {
    if (!metaAdsConfig()) return notEnabledResponse();
    const session = await requireSession(request);
    return NextResponse.json({ drafts: await listAdDrafts(actorOf(session)) }, { headers: NO_STORE });
  } catch (error) {
    return metaAdsRouteError(error);
  }
}

export async function POST(request: Request) {
  try {
    if (!metaAdsConfig()) return notEnabledResponse();
    const session = await requireSession(request);
    await assertMutation(request, session);
    const limit = await checkRateLimit(`metaAdsDrafts:${session.userId}`, RATE_LIMITS.adminAction);
    if (!limit.success) return rateLimitResponse(limit);
    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    const actor = actorOf(session);
    switch (body?.action) {
      case 'create': {
        const accountLimit = await checkRateLimit(`metaAdsCreate:${session.accountId}`, CREATE_LIMIT);
        if (!accountLimit.success) return rateLimitResponse(accountLimit);
        const input = parseAdCreateInput(body);
        if (!input) return metaAdsErrorResponse('invalid_request');
        return NextResponse.json({ draft: await requestAdCreate(actor, input) }, { status: 202, headers: NO_STORE });
      }
      case 'duplicate':
      case 'variant': {
        const accountLimit = await checkRateLimit(`metaAdsCreate:${session.accountId}`, CREATE_LIMIT);
        if (!accountLimit.success) return rateLimitResponse(accountLimit);
        if (body.action === 'duplicate') {
          if (typeof body.id !== 'string' || !UUID.test(body.id)) return metaAdsErrorResponse('invalid_request');
          return NextResponse.json({ draft: await duplicateAdDraft(actor, body.id) }, { status: 202, headers: NO_STORE });
        }
        const variant = parseAdVariantInput(body);
        if (!variant) return metaAdsErrorResponse('invalid_request');
        return NextResponse.json({ draft: await requestAdVariant(actor, variant) }, { status: 202, headers: NO_STORE });
      }
      case 'recheck':
      case 'discard': {
        if (typeof body.id !== 'string' || !UUID.test(body.id)) return metaAdsErrorResponse('invalid_request');
        const draft = body.action === 'recheck' ? await recheckAdDraft(actor, body.id) : await discardAdDraft(actor, body.id);
        return NextResponse.json({ draft }, { headers: NO_STORE });
      }
      default:
        return metaAdsErrorResponse('invalid_request');
    }
  } catch (error) {
    return metaAdsRouteError(error);
  }
}
