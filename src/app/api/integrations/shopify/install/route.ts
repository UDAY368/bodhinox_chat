// POST /api/integrations/shopify/install { shop } — admin. Starts the Shopify
// OAuth install: returns { url } (the store's authorize page) and sets the
// signed, httpOnly state cookie the callback checks. 503 when the Shopify app
// is not configured.

import { NextResponse } from 'next/server';
import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { appOrigin } from '@/lib/auth/csrf';
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit';
import { shopifyConfig } from '@/lib/integrations/shopify/config';
import {
  buildInstallUrl, newStateNonce, normalizeShopDomain, signState, STATE_COOKIE, STATE_COOKIE_PATH, STATE_TTL_MS,
} from '@/lib/integrations/shopify/oauth';

export const runtime = 'nodejs';
const headers = { 'Cache-Control': 'private, no-store' };

export async function POST(request: Request) {
  try {
    const config = shopifyConfig();
    if (!config) return NextResponse.json({ error: 'not_configured' }, { status: 503, headers });
    const ctx = await requireRole('admin');
    const limit = checkRateLimit(`shopifyInstall:${ctx.userId}`, RATE_LIMITS.adminAction);
    if (!limit.success) return rateLimitResponse(limit);
    const body = (await request.json().catch(() => null)) as { shop?: unknown } | null;
    const shop = normalizeShopDomain(body?.shop);
    if (!shop) return NextResponse.json({ error: 'invalid_shop' }, { status: 400, headers });
    const origin = appOrigin();
    const nonce = newStateNonce();
    const expiresAt = Date.now() + STATE_TTL_MS;
    const url = buildInstallUrl({ config, shop, redirectUri: `${origin}/api/integrations/shopify/callback`, state: nonce });
    const response = NextResponse.json({ url }, { headers });
    response.cookies.set(STATE_COOKIE, signState(config.apiSecret, { nonce, shop, accountId: ctx.accountId, userId: ctx.userId, expiresAt }), {
      httpOnly: true,
      secure: origin.startsWith('https:'),
      // The callback is a top-level navigation from Shopify, which Lax allows.
      sameSite: 'lax',
      path: STATE_COOKIE_PATH,
      maxAge: Math.floor(STATE_TTL_MS / 1000),
    });
    return response;
  } catch (error) {
    return toErrorResponse(error);
  }
}
