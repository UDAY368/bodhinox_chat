// POST /api/meta-ads/leadforms — admin, CSRF, ad management on. Makes a Meta
// instant form on the connected Page: { name, questions: [FULL_NAME | EMAIL |
// PHONE | CITY | COMPANY_NAME | JOB_TITLE] (needs PHONE or EMAIL),
// customQuestions?: string[] (up to 5), privacyUrl (https), privacyText?,
// thankYouTitle?, thankYouBody?, websiteUrl? }. 201 { form: { id, name } }.
// A name already used on the Page is refused (409 name_taken); after an unclear
// outcome the form is looked up by name instead of being made twice.
// 503 meta_ads_not_enabled / manage_not_enabled, 400 invalid_request, 403,
// 404 not_connected, 409 missing_scope / token_invalid / name_taken, 429, 502.

import { NextResponse } from 'next/server';
import { assertMutation, requireSession } from '@/lib/auth/session';
import { metaAdsConfig, metaAdsManageEnabled } from '@/lib/meta-ads/config';
import { createPageLeadForm, parseLeadFormInput } from '@/lib/meta-ads/create';
import { actorOf, metaAdsErrorResponse, metaAdsRouteError, notEnabledResponse, NO_STORE } from '@/lib/meta-ads/http';
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit';

export const runtime = 'nodejs';

export async function POST(request: Request) {
  try {
    if (!metaAdsConfig()) return notEnabledResponse();
    if (!metaAdsManageEnabled()) return metaAdsErrorResponse('manage_not_enabled');
    const session = await requireSession(request);
    await assertMutation(request, session);
    const limit = await checkRateLimit(`metaAdsLeadForms:${session.userId}`, RATE_LIMITS.adminAction);
    if (!limit.success) return rateLimitResponse(limit);
    const input = parseLeadFormInput(await request.json().catch(() => null));
    if (!input) return metaAdsErrorResponse('invalid_request');
    return NextResponse.json({ form: await createPageLeadForm(actorOf(session), input) }, { status: 201, headers: NO_STORE });
  } catch (error) {
    return metaAdsRouteError(error);
  }
}
