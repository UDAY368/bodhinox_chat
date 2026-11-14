// /api/meta-ads/accounts — the ad accounts the workspace reports on and manages.
// GET (any member): { accounts } — the linked ones, primary first.
//   ?available=1 (admin): also { available } — the ones this login can see
//   that are not linked yet (one Meta call).
// POST (admin, CSRF) { action: 'add' | 'remove', adAccountId }: links one
//   the login can see (re-checked with Meta; at most 10) or unlinks a
//   secondary one and drops its synced data. 200 { accounts }.
// 503 meta_ads_not_enabled, 400 invalid_request / invalid_choice, 403, 404,
// 409 token_invalid, 429, 502 meta_error.

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { assertMutation, requireSession } from '@/lib/auth/session';
import { metaAdsConfig } from '@/lib/meta-ads/config';
import { addAdAccount, listAvailableAdAccounts, listLinkedAdAccounts, removeAdAccount } from '@/lib/meta-ads/accounts';
import { actorOf, metaAdsErrorResponse, metaAdsRouteError, notEnabledResponse, NO_STORE } from '@/lib/meta-ads/http';
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit';

export const runtime = 'nodejs';

const Body = z.object({ action: z.enum(['add', 'remove']), adAccountId: z.string().regex(/^\d{1,32}$/) }).strict();

export async function GET(request: Request) {
  try {
    if (!metaAdsConfig()) return notEnabledResponse();
    const session = await requireSession(request);
    const actor = actorOf(session);
    const accounts = await listLinkedAdAccounts(actor);
    if (new URL(request.url).searchParams.get('available') !== '1') return NextResponse.json({ accounts }, { headers: NO_STORE });
    const limit = checkRateLimit(`metaAdsAccounts:${session.userId}`, RATE_LIMITS.adminAction);
    if (!limit.success) return rateLimitResponse(limit);
    return NextResponse.json({ accounts, available: await listAvailableAdAccounts(actor) }, { headers: NO_STORE });
  } catch (error) {
    return metaAdsRouteError(error);
  }
}

export async function POST(request: Request) {
  try {
    if (!metaAdsConfig()) return notEnabledResponse();
    const session = await requireSession(request);
    await assertMutation(request, session);
    const limit = checkRateLimit(`metaAdsAccounts:${session.userId}`, RATE_LIMITS.adminAction);
    if (!limit.success) return rateLimitResponse(limit);
    const parsed = Body.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return metaAdsErrorResponse('invalid_request');
    const actor = actorOf(session);
    const accounts = parsed.data.action === 'add'
      ? await addAdAccount(actor, parsed.data.adAccountId)
      : await removeAdAccount(actor, parsed.data.adAccountId);
    return NextResponse.json({ accounts }, { headers: NO_STORE });
  } catch (error) {
    return metaAdsRouteError(error);
  }
}
