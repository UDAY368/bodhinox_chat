// /api/meta-ads/audiences — Meta custom audiences built in Bodhinox.
// GET (any member): { audiences } — customer lists (from a segment) and lookalikes.
// POST (admin, CSRF):
//   { action: 'create', kind: 'customer_list', adAccountId, name, segmentId, autoSync? }
//   { action: 'create', kind: 'lookalike', adAccountId, name, originId, country, percent (1-10) }
//   { action: 'create', kind: 'engagement', adAccountId, name, source: 'page' | 'instagram', retentionDays (1-365) }
//   { action: 'create', kind: 'website', adAccountId, name, pixelId, retentionDays (1-365) }
//     — records the audience and queues its creation; 202 { audience }.
//   { action: 'sync', id } — uploads a customer list's segment again; 202 { audience }.
//   { action: 'auto_sync', id, autoSync } — 6-hourly upload on or off; 200 { audience }.
//   { action: 'recheck', id } — an 'unknown' audience: looks it up at Meta again (a read).
//   { action: 'remove', id } — stops tracking it in Bodhinox (it stays in the ad account); 200.
// 503 meta_ads_not_enabled / manage_not_enabled, 400 invalid_request / invalid_choice,
// 403, 404, 409 missing_scope / token_invalid / name_taken / limit_reached, 429, 502.

import { NextResponse } from 'next/server';
import { assertMutation, requireSession } from '@/lib/auth/session';
import { metaAdsConfig } from '@/lib/meta-ads/config';
import {
  listAudiences, parseAudienceCreateInput, recheckAudience, removeAudience, requestAudienceCreate, requestAudienceSync,
  setAudienceAutoSync,
} from '@/lib/meta-ads/audiences';
import { actorOf, metaAdsErrorResponse, metaAdsRouteError, notEnabledResponse, NO_STORE } from '@/lib/meta-ads/http';
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit';

export const runtime = 'nodejs';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(request: Request) {
  try {
    if (!metaAdsConfig()) return notEnabledResponse();
    const session = await requireSession(request);
    return NextResponse.json({ audiences: await listAudiences(actorOf(session)) }, { headers: NO_STORE });
  } catch (error) {
    return metaAdsRouteError(error);
  }
}

export async function POST(request: Request) {
  try {
    if (!metaAdsConfig()) return notEnabledResponse();
    const session = await requireSession(request);
    await assertMutation(request, session);
    const limit = await checkRateLimit(`metaAdsAudiences:${session.userId}`, RATE_LIMITS.adminAction);
    if (!limit.success) return rateLimitResponse(limit);
    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    const actor = actorOf(session);
    if (body?.action === 'create') {
      const input = parseAudienceCreateInput(body);
      if (!input) return metaAdsErrorResponse('invalid_request');
      return NextResponse.json({ audience: await requestAudienceCreate(actor, input) }, { status: 202, headers: NO_STORE });
    }
    if (typeof body?.id !== 'string' || !UUID.test(body.id)) return metaAdsErrorResponse('invalid_request');
    switch (body.action) {
      case 'sync':
        return NextResponse.json({ audience: await requestAudienceSync(actor, body.id) }, { status: 202, headers: NO_STORE });
      case 'auto_sync':
        if (typeof body.autoSync !== 'boolean') return metaAdsErrorResponse('invalid_request');
        return NextResponse.json({ audience: await setAudienceAutoSync(actor, body.id, body.autoSync) }, { headers: NO_STORE });
      case 'recheck':
        return NextResponse.json({ audience: await recheckAudience(actor, body.id) }, { headers: NO_STORE });
      case 'remove':
        await removeAudience(actor, body.id);
        return NextResponse.json({ ok: true }, { headers: NO_STORE });
      default:
        return metaAdsErrorResponse('invalid_request');
    }
  } catch (error) {
    return metaAdsRouteError(error);
  }
}
