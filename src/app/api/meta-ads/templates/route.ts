// /api/meta-ads/templates — saved Create ad setups.
// GET (any member): { templates: [{ id, name, settings, createdAt }] }.
// POST (admin, CSRF): { name, settings } — saves the form's values (an object,
//   at most 16 KB); 201 { template }. 409 name_taken / limit_reached (50).
// DELETE (admin, CSRF): ?id=<uuid>; 200 { ok }. 404 not_found.
// 503 meta_ads_not_enabled, 400 invalid_request, 403.

import { NextResponse } from 'next/server';
import { assertMutation, requireSession } from '@/lib/auth/session';
import { metaAdsConfig } from '@/lib/meta-ads/config';
import { deleteAdTemplate, listAdTemplates, parseTemplateInput, saveAdTemplate } from '@/lib/meta-ads/templates';
import { actorOf, metaAdsErrorResponse, metaAdsRouteError, notEnabledResponse, NO_STORE } from '@/lib/meta-ads/http';
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit';

export const runtime = 'nodejs';
/** A saved setup is small; the route refuses bigger bodies before parsing them. */
const MAX_BODY_BYTES = 20_000;

export async function GET(request: Request) {
  try {
    if (!metaAdsConfig()) return notEnabledResponse();
    const session = await requireSession(request);
    return NextResponse.json({ templates: await listAdTemplates(actorOf(session)) }, { headers: NO_STORE });
  } catch (error) {
    return metaAdsRouteError(error);
  }
}

export async function POST(request: Request) {
  try {
    if (!metaAdsConfig()) return notEnabledResponse();
    const session = await requireSession(request);
    await assertMutation(request, session);
    const limit = await checkRateLimit(`metaAdsTemplates:${session.userId}`, RATE_LIMITS.adminAction);
    if (!limit.success) return rateLimitResponse(limit);
    const text = await request.text();
    if (text.length > MAX_BODY_BYTES) return metaAdsErrorResponse('invalid_request');
    let body: unknown = null;
    try { body = JSON.parse(text); } catch { /* invalid below */ }
    const input = parseTemplateInput(body);
    if (!input) return metaAdsErrorResponse('invalid_request');
    return NextResponse.json({ template: await saveAdTemplate(actorOf(session), input) }, { status: 201, headers: NO_STORE });
  } catch (error) {
    return metaAdsRouteError(error);
  }
}

export async function DELETE(request: Request) {
  try {
    if (!metaAdsConfig()) return notEnabledResponse();
    const session = await requireSession(request);
    await assertMutation(request, session);
    await deleteAdTemplate(actorOf(session), new URL(request.url).searchParams.get('id') ?? '');
    return NextResponse.json({ ok: true }, { headers: NO_STORE });
  } catch (error) {
    return metaAdsRouteError(error);
  }
}
