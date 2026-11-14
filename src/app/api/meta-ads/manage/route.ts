// GET /api/meta-ads/manage?adAccountId=<id|all> — any member. The linked ad accounts' (or one's) cached
// campaigns, ad sets and ads (with 30-day spend and chats started), the open
// and recent changes, the workspace's daily budget cap, whether changes can be
// sent (META_ADS_MANAGE_ENABLED) and the permissions they still need.
// Reads stored data only; no Meta call. 503 meta_ads_not_enabled.

import { NextResponse } from 'next/server';
import { requireSession } from '@/lib/auth/session';
import { metaAdsConfig } from '@/lib/meta-ads/config';
import { actorOf, metaAdsRouteError, notEnabledResponse, NO_STORE } from '@/lib/meta-ads/http';
import { getAdManageView } from '@/lib/meta-ads/manage';
import { parseAdAccountFilter } from '@/lib/meta-ads/accounts';

export const runtime = 'nodejs';

export async function GET(request: Request) {
  try {
    if (!metaAdsConfig()) return notEnabledResponse();
    const session = await requireSession(request);
    const adAccountId = parseAdAccountFilter(new URL(request.url).searchParams.get('adAccountId'));
    return NextResponse.json(await getAdManageView(actorOf(session), adAccountId), { headers: NO_STORE });
  } catch (error) {
    return metaAdsRouteError(error);
  }
}
