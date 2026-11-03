// /api/meta-ads/connection — admin.
//   PATCH { adAccountId, pageId }  finish connecting: the ids must be among the
//         choices of the pending connection (re-checked against Meta), and the
//         Page must not be held by another workspace (409 page_in_use).
//   PATCH { capiEnabled?, capiAutoPurchase?, capiAutoLead?, capiWhatsappConfigId? }
//         Conversions API settings; enabling looks up or creates the dataset of
//         the chosen number's WABA. Audit meta_ads.capi_update.
//   DELETE  unsubscribe the Page and disconnect (502 revoke_failed keeps the
//         connection so the admin can retry). Audit meta_ads.disconnect. Not
//         gated: while the feature is off it still clears the stored tokens
//         (no Meta call).
// 200 { connection }. PATCH answers 503 meta_ads_not_enabled before anything else.

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { ForbiddenError } from '@/lib/auth/account';
import { hasMinRole } from '@/lib/auth/roles';
import { assertMutation, requireSession, type AuthContext } from '@/lib/auth/session';
import { metaAdsConfig } from '@/lib/meta-ads/config';
import { disconnect, finishConnection, updateCapiSettings } from '@/lib/meta-ads/connection';
import { actorOf, metaAdsErrorResponse, metaAdsRouteError, notEnabledResponse, NO_STORE } from '@/lib/meta-ads/http';
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit';

export const runtime = 'nodejs';

const metaId = z.string().regex(/^\d{1,32}$/);
const Finish = z.object({ adAccountId: metaId, pageId: metaId }).strict();
const Capi = z.object({
  capiEnabled: z.boolean().optional(),
  capiAutoPurchase: z.boolean().optional(),
  capiAutoLead: z.boolean().optional(),
  capiWhatsappConfigId: z.string().uuid().nullable().optional(),
}).strict().refine((v) => Object.keys(v).length > 0);

async function adminMutation(request: Request): Promise<AuthContext | NextResponse> {
  const session = await requireSession(request);
  await assertMutation(request, session);
  if (!hasMinRole(session.role, 'admin')) throw new ForbiddenError();
  const limit = checkRateLimit(`metaAdsConnection:${session.userId}`, RATE_LIMITS.adminAction);
  if (!limit.success) return rateLimitResponse(limit);
  return session;
}

export async function PATCH(request: Request) {
  try {
    if (!metaAdsConfig()) return notEnabledResponse();
    const session = await adminMutation(request);
    if (session instanceof NextResponse) return session;
    const body: unknown = await request.json().catch(() => null);
    const finish = Finish.safeParse(body);
    if (finish.success) {
      return NextResponse.json({ connection: await finishConnection(actorOf(session), finish.data) }, { headers: NO_STORE });
    }
    const capi = Capi.safeParse(body);
    if (!capi.success) return metaAdsErrorResponse('invalid_request');
    return NextResponse.json({ connection: await updateCapiSettings(actorOf(session), capi.data) }, { headers: NO_STORE });
  } catch (error) {
    return metaAdsRouteError(error);
  }
}

export async function DELETE(request: Request) {
  try {
    const session = await adminMutation(request);
    if (session instanceof NextResponse) return session;
    const connection = await disconnect(actorOf(session));
    if (!connection) return metaAdsErrorResponse('not_connected');
    return NextResponse.json({ connection }, { headers: NO_STORE });
  } catch (error) {
    return metaAdsRouteError(error);
  }
}
