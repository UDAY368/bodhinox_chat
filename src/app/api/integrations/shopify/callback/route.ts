// GET /api/integrations/shopify/callback — Shopify's OAuth redirect. Verifies
// the query HMAC, the shop, the state against the signed cookie and that the
// admin who started the install is still signed in to the same workspace,
// exchanges the code, stores the encrypted token and subscribes the webhooks.
// Always redirects back to Settings with ?shopify=<outcome>.

import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { getCurrentAccount } from '@/lib/auth/account';
import { appOrigin } from '@/lib/auth/csrf';
import { hasMinRole } from '@/lib/auth/roles';
import { tenantOf } from '@/lib/audience/http';
import { withTenant } from '@/lib/db/tenant';
import { revokeAccess, registerWebhooks } from '@/lib/integrations/shopify/admin-api';
import { scopesSatisfied, shopifyConfig } from '@/lib/integrations/shopify/config';
import { exchangeCode, ShopifyOAuthError, STATE_COOKIE, STATE_COOKIE_PATH, verifyCallback } from '@/lib/integrations/shopify/oauth';
import { loadShopifyToken, saveShopifyStore, ShopifyStoreError } from '@/lib/integrations/shopify/store';
import { SHOPIFY_SETTINGS_PATH } from '@/lib/integrations/shopify/settings-path';

export const runtime = 'nodejs';

function back(outcome: string): NextResponse {
  const target = new URL(SHOPIFY_SETTINGS_PATH, appOrigin());
  target.searchParams.set('shopify', outcome);
  const response = NextResponse.redirect(target, { status: 303 });
  response.cookies.set(STATE_COOKIE, '', { path: STATE_COOKIE_PATH, maxAge: 0, httpOnly: true, sameSite: 'lax' });
  response.headers.set('Cache-Control', 'no-store');
  return response;
}

export async function GET(request: Request) {
  const config = shopifyConfig();
  if (!config) return NextResponse.json({ error: 'not_configured' }, { status: 503 });
  let ctx;
  try {
    ctx = await getCurrentAccount();
  } catch {
    return back('signed_out');
  }
  if (!hasMinRole(ctx.role, 'admin')) return back('forbidden');

  let verified;
  try {
    verified = verifyCallback({
      params: new URL(request.url).searchParams,
      config,
      cookie: (await cookies()).get(STATE_COOKIE)?.value,
      session: { accountId: ctx.accountId, userId: ctx.userId },
    });
  } catch (error) {
    return back(error instanceof ShopifyOAuthError ? error.reason : 'invalid_state');
  }

  let token;
  try {
    token = await exchangeCode({ config, shop: verified.shop, code: verified.code });
  } catch {
    return back('exchange_failed');
  }
  if (!scopesSatisfied(config.scopes, token.scopes)) {
    await revokeAccess({ shop: verified.shop, accessToken: token.accessToken });
    return back('missing_scopes');
  }

  // The store this workspace has installed now. Unknown (lookup failed) means
  // nothing is revoked: revoking the new token of the same shop would uninstall it.
  let previous: Awaited<ReturnType<typeof loadShopifyToken>>;
  try {
    previous = await loadShopifyToken(ctx.accountId);
  } catch (error) {
    console.error('Shopify store could not be loaded', error instanceof Error ? error.name : 'unknown');
    return back('save_failed');
  }
  const sameShop = !!previous && previous.shop === verified.shop;

  try {
    await withTenant(tenantOf(ctx), (tx) => saveShopifyStore(tx, ctx.accountId, { shop: verified.shop, accessToken: token.accessToken, scopes: token.scopes }));
  } catch (error) {
    // Nothing was saved: the working store stays installed, and a new shop's token is not left live.
    if (!sameShop) await revokeAccess({ shop: verified.shop, accessToken: token.accessToken });
    if (error instanceof ShopifyStoreError && error.reason === 'connected_elsewhere') return back('connected_elsewhere');
    console.error('Shopify store could not be saved', error instanceof Error ? error.name : 'unknown');
    return back('save_failed');
  }
  // Only once the new store is saved: uninstall the shop it replaced, so it stops sending events here.
  if (previous && previous.shop !== verified.shop) await revokeAccess(previous);

  const { failed } = await registerWebhooks({
    shop: verified.shop,
    accessToken: token.accessToken,
    address: `${appOrigin()}/api/integrations/shopify/webhooks`,
  });
  return back(failed.length ? 'webhooks_failed' : 'connected');
}
