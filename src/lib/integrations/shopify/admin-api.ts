import { SHOPIFY_API_VERSION } from './config';
import { isShopDomain } from './oauth';

/**
 * The few Shopify Admin API calls the integration makes. The shop domain is
 * validated (*.myshopify.com) before any request, redirects are refused and
 * nothing here logs the token or a response body.
 *
 * The mandatory GDPR topics (customers/data_request, customers/redact,
 * shop/redact) cannot be subscribed through the API: they are set once in the
 * app's configuration (Partner Dashboard / shopify.app.toml) and point at the
 * same webhooks route.
 */

export const SHOPIFY_EVENT_TOPICS = [
  'orders/create',
  'orders/paid',
  'orders/fulfilled',
  'orders/cancelled',
  'checkouts/create',
  'checkouts/update',
  'app/uninstalled',
] as const;

type Fetch = typeof fetch;

async function call(shop: string, accessToken: string, path: string, init: RequestInit, fetchImpl: Fetch = fetch): Promise<Response> {
  if (!isShopDomain(shop)) throw new Error('Invalid shop domain');
  return fetchImpl(`https://${shop}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', accept: 'application/json', 'x-shopify-access-token': accessToken },
    redirect: 'error',
    signal: AbortSignal.timeout(15_000),
  });
}

/**
 * Subscribes the store to every event topic, pointed at `address`. A topic that
 * is already subscribed (422 "has already been taken") counts as done.
 * Returns the topics that could not be registered.
 */
export async function registerWebhooks(input: { shop: string; accessToken: string; address: string; fetchImpl?: Fetch }): Promise<{ failed: string[] }> {
  const failed: string[] = [];
  for (const topic of SHOPIFY_EVENT_TOPICS) {
    try {
      const response = await call(input.shop, input.accessToken, `/admin/api/${SHOPIFY_API_VERSION}/webhooks.json`, {
        method: 'POST',
        body: JSON.stringify({ webhook: { topic, address: input.address, format: 'json' } }),
      }, input.fetchImpl);
      if (response.ok) continue;
      if (response.status === 422) {
        const text = await response.text().catch(() => '');
        if (/already been taken/i.test(text)) continue;
      }
      failed.push(topic);
    } catch {
      failed.push(topic);
    }
  }
  return { failed };
}

/**
 * Uninstalls the app from the store (revokes the token). A 401/404 means it is
 * already revoked. Returns false when Shopify could not be reached or refused.
 */
export async function revokeAccess(input: { shop: string; accessToken: string; fetchImpl?: Fetch }): Promise<boolean> {
  try {
    const response = await call(input.shop, input.accessToken, '/admin/api_permissions/current.json', { method: 'DELETE' }, input.fetchImpl);
    return response.ok || response.status === 401 || response.status === 404;
  } catch {
    return false;
  }
}
