import { createHmac } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { parseScopes, scopesSatisfied, shopifyConfig } from './config';
import {
  buildInstallUrl, exchangeCode, normalizeShopDomain, readState, ShopifyOAuthError, signState, verifyCallback, verifyCallbackHmac,
} from './oauth';

const config = { apiKey: 'test-key', apiSecret: 'test-secret', scopes: ['read_orders', 'read_checkouts'] };
const accountId = '11111111-1111-4111-8111-111111111111';
const userId = '22222222-2222-4222-8222-222222222222';
const now = Date.UTC(2026, 10, 2, 12);

function signedQuery(fields: Record<string, string>, secret = config.apiSecret): URLSearchParams {
  const message = new URLSearchParams(Object.entries(fields).sort(([a], [b]) => (a < b ? -1 : 1))).toString();
  return new URLSearchParams({ ...fields, hmac: createHmac('sha256', secret).update(message).digest('hex') });
}

const cookieFor = (overrides: Partial<{ nonce: string; shop: string; accountId: string; userId: string; expiresAt: number }> = {}) =>
  signState(config.apiSecret, { nonce: 'nonce-abcdefghijklmnop', shop: 'demo.myshopify.com', accountId, userId, expiresAt: now + 60_000, ...overrides });

const callbackParams = (extra: Record<string, string> = {}) => signedQuery({
  code: 'auth-code-1', shop: 'demo.myshopify.com', state: 'nonce-abcdefghijklmnop', timestamp: String(Math.floor(now / 1000)), host: 'ZGVtbw', ...extra,
});

describe('shopify config', () => {
  it('is off without key or secret and defaults the scopes', () => {
    expect(shopifyConfig({ SHOPIFY_API_KEY: 'k' } as unknown as NodeJS.ProcessEnv)).toBeNull();
    expect(shopifyConfig({ SHOPIFY_API_KEY: 'k', SHOPIFY_API_SECRET: 's' } as unknown as NodeJS.ProcessEnv)?.scopes)
      .toEqual(['read_orders', 'read_checkouts', 'read_customers', 'read_fulfillments']);
    expect(parseScopes('read_orders, bad scope!,read_orders')).toEqual(['read_orders']);
  });
  it('accepts write_x for read_x', () => {
    expect(scopesSatisfied(['read_orders', 'read_checkouts'], ['write_orders', 'read_checkouts'])).toBe(true);
    expect(scopesSatisfied(['read_orders', 'read_checkouts'], ['read_orders'])).toBe(false);
  });
});

describe('shop domain', () => {
  it('normalizes a store handle, domain or admin URL', () => {
    expect(normalizeShopDomain('Demo-Store')).toBe('demo-store.myshopify.com');
    expect(normalizeShopDomain('https://demo.myshopify.com/admin/orders')).toBe('demo.myshopify.com');
  });
  it('refuses anything that is not a myshopify.com host', () => {
    for (const bad of ['evil.com', 'demo.myshopify.com.evil.com', '-demo.myshopify.com', 'demo.myshopify.com@evil.com', 'demo shop', '', 42])
      expect(normalizeShopDomain(bad)).toBeNull();
  });
  it('builds the authorize URL on the shop host', () => {
    const url = new URL(buildInstallUrl({ config, shop: 'demo.myshopify.com', redirectUri: 'https://app.test/cb', state: 'n' }));
    expect(url.origin).toBe('https://demo.myshopify.com');
    expect(url.searchParams.get('client_id')).toBe('test-key');
    expect(url.searchParams.get('scope')).toBe('read_orders,read_checkouts');
    expect(url.searchParams.get('state')).toBe('n');
    expect(() => buildInstallUrl({ config, shop: 'evil.com', redirectUri: 'x', state: 'n' })).toThrow(ShopifyOAuthError);
  });
});

describe('callback HMAC', () => {
  it('accepts Shopify’s signature and rejects tampering or the wrong secret', () => {
    const params = callbackParams();
    expect(verifyCallbackHmac(params, config.apiSecret)).toBe(true);
    expect(verifyCallbackHmac(params, 'other-secret')).toBe(false);
    const tampered = new URLSearchParams(params);
    tampered.set('shop', 'other.myshopify.com');
    expect(verifyCallbackHmac(tampered, config.apiSecret)).toBe(false);
    const missing = new URLSearchParams(params);
    missing.delete('hmac');
    expect(verifyCallbackHmac(missing, config.apiSecret)).toBe(false);
    const doubled = new URLSearchParams(params);
    doubled.append('hmac', params.get('hmac')!);
    expect(verifyCallbackHmac(doubled, config.apiSecret)).toBe(false);
  });
});

describe('OAuth state', () => {
  it('round-trips a signed cookie and rejects a forged one', () => {
    const cookie = cookieFor();
    expect(readState(config.apiSecret, cookie)).toMatchObject({ shop: 'demo.myshopify.com', accountId, userId });
    expect(readState('other-secret', cookie)).toBeNull();
    const [body, mac] = cookie.split('.');
    const forged = Buffer.from(JSON.stringify({ n: 'nonce-abcdefghijklmnop', s: 'evil.myshopify.com', a: accountId, u: userId, e: now + 1 })).toString('base64url');
    expect(readState(config.apiSecret, `${forged}.${mac}`)).toBeNull();
    expect(readState(config.apiSecret, `${body}.${mac}.x`)).toBeNull();
    expect(readState(config.apiSecret, undefined)).toBeNull();
  });

  const verify = (params: URLSearchParams, cookie: string | undefined, session = { accountId, userId }) =>
    verifyCallback({ params, config, cookie, session, now });
  const reason = (fn: () => unknown) => { try { fn(); return null; } catch (e) { return (e as ShopifyOAuthError).reason; } };

  it('returns the shop and code when every check passes', () => {
    expect(verify(callbackParams(), cookieFor())).toEqual({ shop: 'demo.myshopify.com', code: 'auth-code-1' });
  });
  it('rejects a missing cookie, wrong nonce, other shop, other workspace or other user', () => {
    expect(reason(() => verify(callbackParams(), undefined))).toBe('invalid_state');
    expect(reason(() => verify(callbackParams({ state: 'nonce-zzzzzzzzzzzzzzzz' }), cookieFor()))).toBe('invalid_state');
    expect(reason(() => verify(callbackParams(), cookieFor({ shop: 'other.myshopify.com' })))).toBe('invalid_state');
    expect(reason(() => verify(callbackParams(), cookieFor(), { accountId: '33333333-3333-4333-8333-333333333333', userId }))).toBe('invalid_state');
    expect(reason(() => verify(callbackParams(), cookieFor(), { accountId, userId: '33333333-3333-4333-8333-333333333333' }))).toBe('invalid_state');
  });
  it('rejects an expired state, a stale timestamp, a bad HMAC and a bad shop', () => {
    expect(reason(() => verify(callbackParams(), cookieFor({ expiresAt: now - 1 })))).toBe('expired');
    expect(reason(() => verify(callbackParams({ timestamp: String(Math.floor(now / 1000) - 3 * 86400) }), cookieFor()))).toBe('expired');
    const bad = callbackParams();
    bad.set('code', 'other');
    expect(reason(() => verify(bad, cookieFor()))).toBe('invalid_hmac');
    expect(reason(() => verify(callbackParams({ shop: 'evil.com' }), cookieFor()))).toBe('invalid_shop');
  });
});

describe('code exchange', () => {
  it('posts the code to the shop and returns the token and scopes', async () => {
    const fetchImpl = vi.fn(async () => Response.json({ access_token: 'shpat_test', scope: 'read_orders,read_checkouts' }));
    await expect(exchangeCode({ config, shop: 'demo.myshopify.com', code: 'c', fetchImpl: fetchImpl as unknown as typeof fetch }))
      .resolves.toEqual({ accessToken: 'shpat_test', scopes: ['read_orders', 'read_checkouts'] });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://demo.myshopify.com/admin/oauth/access_token');
    expect(JSON.parse(String(init.body))).toEqual({ client_id: 'test-key', client_secret: 'test-secret', code: 'c' });
    expect(init.redirect).toBe('error');
  });
  it('fails closed on an error response, a network error or a bad shop', async () => {
    const reject = vi.fn(async () => new Response('no', { status: 400 }));
    await expect(exchangeCode({ config, shop: 'demo.myshopify.com', code: 'c', fetchImpl: reject as unknown as typeof fetch })).rejects.toThrow(ShopifyOAuthError);
    const offline = vi.fn(async () => { throw new TypeError('offline'); });
    await expect(exchangeCode({ config, shop: 'demo.myshopify.com', code: 'c', fetchImpl: offline as unknown as typeof fetch })).rejects.toThrow(ShopifyOAuthError);
    await expect(exchangeCode({ config, shop: 'evil.com', code: 'c', fetchImpl: reject as unknown as typeof fetch })).rejects.toThrow(ShopifyOAuthError);
    expect(reject).toHaveBeenCalledTimes(1);
  });
});
