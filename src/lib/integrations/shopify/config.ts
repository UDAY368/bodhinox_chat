/**
 * Shopify app configuration from the environment. Server only.
 *   SHOPIFY_API_KEY     the app's client id
 *   SHOPIFY_API_SECRET  the app's client secret (OAuth HMAC, webhook HMAC, code exchange)
 *   SHOPIFY_SCOPES      optional; defaults to DEFAULT_SHOPIFY_SCOPES
 * When the key or secret is missing the integration is off: the settings card
 * says so and every Shopify route answers 503.
 */

export const DEFAULT_SHOPIFY_SCOPES = 'read_orders,read_checkouts,read_customers,read_fulfillments';
/** Admin REST API version used for webhook registration. */
export const SHOPIFY_API_VERSION = '2025-10';

export interface ShopifyConfig {
  apiKey: string;
  apiSecret: string;
  scopes: string[];
}

export function parseScopes(value: string | null | undefined): string[] {
  return [...new Set((value ?? '').split(',').map((s) => s.trim()).filter((s) => /^[a-z_]{1,64}$/.test(s)))];
}

export function shopifyConfig(env: NodeJS.ProcessEnv = process.env): ShopifyConfig | null {
  const apiKey = env.SHOPIFY_API_KEY?.trim();
  const apiSecret = env.SHOPIFY_API_SECRET?.trim();
  if (!apiKey || !apiSecret) return null;
  const scopes = parseScopes(env.SHOPIFY_SCOPES || DEFAULT_SHOPIFY_SCOPES);
  return { apiKey, apiSecret, scopes: scopes.length ? scopes : parseScopes(DEFAULT_SHOPIFY_SCOPES) };
}

/** True when every required scope was granted (a write_x scope includes read_x). */
export function scopesSatisfied(required: string[], granted: string[]): boolean {
  const have = new Set(granted);
  return required.every((scope) => have.has(scope) || (scope.startsWith('read_') && have.has(`write_${scope.slice(5)}`)));
}
