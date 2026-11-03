// GET /api/meta-ads/status — any member. Always 200:
//   { enabled: false, reason, connection: null, missingScopes }  while the feature is off or not configured
//   { enabled: true, appId, loginConfigId, connection, missingScopes }  otherwise
// connection is the live connection's DTO (never a token); missingScopes lists,
// per feature, the permissions the grant lacks. No Meta call.

import { NextResponse } from 'next/server';
import { requireSession } from '@/lib/auth/session';
import { metaAdsStatus, missingScopes } from '@/lib/meta-ads/config';
import { getConnection } from '@/lib/meta-ads/connection';
import { actorOf, metaAdsRouteError, NO_STORE } from '@/lib/meta-ads/http';

export const runtime = 'nodejs';

export async function GET(request: Request) {
  try {
    const session = await requireSession(request);
    const status = metaAdsStatus();
    const connection = status.enabled ? await getConnection(actorOf(session)) : null;
    const scopes = connection?.scopes ?? [];
    return NextResponse.json({
      ...status,
      connection,
      missingScopes: {
        insights: missingScopes(scopes, 'insights'),
        leads: missingScopes(scopes, 'leads'),
        capi: missingScopes(scopes, 'capi'),
      },
    }, { headers: NO_STORE });
  } catch (error) {
    return metaAdsRouteError(error);
  }
}
