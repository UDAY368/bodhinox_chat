import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { ShopifyConfig } from './config';

/**
 * Shopify OAuth (authorization code grant, offline token).
 *
 * 1. An admin asks to connect `shop`. We build the authorize URL with a random
 *    `state` nonce and keep {nonce, shop, account, user, expiry} in an httpOnly
 *    cookie signed with a key derived from SHOPIFY_API_SECRET.
 * 2. Shopify redirects back with code, shop, state, timestamp and hmac. The
 *    callback checks the query HMAC, the shop domain, the state against the
 *    signed cookie and that the same admin session is still signed in, then
 *    exchanges the code at https://{shop}/admin/oauth/access_token.
 */

export const SHOP_DOMAIN = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/;
export const STATE_COOKIE = 'bx_shopify_oauth';
export const STATE_COOKIE_PATH = '/api/integrations/shopify';
export const STATE_TTL_MS = 10 * 60_000;
/** Shopify's callback timestamp must be this fresh. */
const CALLBACK_MAX_AGE_S = 24 * 60 * 60;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class ShopifyOAuthError extends Error {
  constructor(public readonly reason: 'invalid_shop' | 'invalid_hmac' | 'invalid_state' | 'expired' | 'exchange_failed' | 'missing_scopes') {
    super(`Shopify OAuth: ${reason}`);
    this.name = 'ShopifyOAuthError';
  }
}

/** Accepts "store", "store.myshopify.com" or "https://store.myshopify.com/admin"; returns the canonical domain or null. */
export function normalizeShopDomain(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  let value = input.trim().toLowerCase();
  if (!value || value.length > 300) return null;
  value = value.replace(/^https?:\/\//, '').replace(/[/?#].*$/, '');
  if (!value.includes('.')) value = `${value}.myshopify.com`;
  return isShopDomain(value) ? value : null;
}

export function isShopDomain(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 255 && SHOP_DOMAIN.test(value);
}

function safeEqualText(a: string, b: string): boolean {
  const left = Buffer.from(a), right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

export function buildInstallUrl(input: { config: ShopifyConfig; shop: string; redirectUri: string; state: string }): string {
  if (!isShopDomain(input.shop)) throw new ShopifyOAuthError('invalid_shop');
  const url = new URL(`https://${input.shop}/admin/oauth/authorize`);
  url.searchParams.set('client_id', input.config.apiKey);
  url.searchParams.set('scope', input.config.scopes.join(','));
  url.searchParams.set('redirect_uri', input.redirectUri);
  url.searchParams.set('state', input.state);
  return url.toString();
}

// ---------------------------------------------------------------------------
// State cookie

export interface OAuthState {
  nonce: string;
  shop: string;
  accountId: string;
  userId: string;
  expiresAt: number;
}

const stateKey = (secret: string) => createHmac('sha256', secret).update('bodhinox:shopify:oauth-state:v1').digest();
const sign = (secret: string, body: string) => createHmac('sha256', stateKey(secret)).update(body).digest('base64url');

export function newStateNonce(): string {
  return randomBytes(24).toString('base64url');
}

/** The signed cookie value carrying the state. */
export function signState(secret: string, state: OAuthState): string {
  const body = Buffer.from(JSON.stringify({ n: state.nonce, s: state.shop, a: state.accountId, u: state.userId, e: state.expiresAt })).toString('base64url');
  return `${body}.${sign(secret, body)}`;
}

/** Reads a signed state cookie; null when missing, tampered or malformed (expiry is checked by the caller). */
export function readState(secret: string, cookie: string | null | undefined): OAuthState | null {
  if (!cookie || cookie.length > 2000) return null;
  const [body, mac, extra] = cookie.split('.');
  if (!body || !mac || extra !== undefined || !safeEqualText(mac, sign(secret, body))) return null;
  try {
    const raw = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as Record<string, unknown>;
    const state: OAuthState = {
      nonce: String(raw.n ?? ''), shop: String(raw.s ?? ''), accountId: String(raw.a ?? ''), userId: String(raw.u ?? ''), expiresAt: Number(raw.e),
    };
    if (!/^[A-Za-z0-9_-]{16,64}$/.test(state.nonce) || !isShopDomain(state.shop) || !UUID.test(state.accountId) || !UUID.test(state.userId)
      || !Number.isFinite(state.expiresAt)) return null;
    return state;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Callback

/**
 * Shopify signs the callback query: every parameter except `hmac` (and the
 * legacy `signature`), sorted by name and form-encoded, HMAC-SHA256 hex with
 * the app secret.
 */
export function verifyCallbackHmac(params: URLSearchParams, secret: string): boolean {
  const supplied = params.get('hmac');
  if (!supplied || !/^[a-f0-9]{64}$/i.test(supplied) || params.getAll('hmac').length !== 1) return false;
  const entries = [...params.entries()].filter(([k]) => k !== 'hmac' && k !== 'signature').sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const message = new URLSearchParams(entries).toString();
  const expected = createHmac('sha256', secret).update(message).digest();
  const actual = Buffer.from(supplied, 'hex');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export interface VerifiedCallback {
  shop: string;
  code: string;
}

/** Every callback check that needs no network: HMAC, shop, timestamp, state vs cookie, session. Throws ShopifyOAuthError. */
export function verifyCallback(input: {
  params: URLSearchParams;
  config: ShopifyConfig;
  cookie: string | null | undefined;
  session: { accountId: string; userId: string };
  now?: number;
}): VerifiedCallback {
  const now = input.now ?? Date.now();
  const { params, config } = input;
  if (!verifyCallbackHmac(params, config.apiSecret)) throw new ShopifyOAuthError('invalid_hmac');
  const shop = params.get('shop') ?? '';
  if (!isShopDomain(shop)) throw new ShopifyOAuthError('invalid_shop');
  const timestamp = Number(params.get('timestamp'));
  if (!Number.isFinite(timestamp) || Math.abs(now / 1000 - timestamp) > CALLBACK_MAX_AGE_S) throw new ShopifyOAuthError('expired');
  const state = readState(config.apiSecret, input.cookie);
  const nonce = params.get('state') ?? '';
  if (!state || !nonce || !safeEqualText(nonce, state.nonce) || state.shop !== shop
    || state.accountId !== input.session.accountId || state.userId !== input.session.userId) throw new ShopifyOAuthError('invalid_state');
  if (state.expiresAt < now) throw new ShopifyOAuthError('expired');
  const code = params.get('code') ?? '';
  if (!/^[A-Za-z0-9_-]{1,256}$/.test(code)) throw new ShopifyOAuthError('invalid_state');
  return { shop, code };
}

/** Exchanges the authorization code for an offline access token. Never logs the token. */
export async function exchangeCode(input: { config: ShopifyConfig; shop: string; code: string; fetchImpl?: typeof fetch }): Promise<{ accessToken: string; scopes: string[] }> {
  if (!isShopDomain(input.shop)) throw new ShopifyOAuthError('invalid_shop');
  let response: Response;
  try {
    response = await (input.fetchImpl ?? fetch)(`https://${input.shop}/admin/oauth/access_token`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ client_id: input.config.apiKey, client_secret: input.config.apiSecret, code: input.code }),
      redirect: 'error',
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new ShopifyOAuthError('exchange_failed');
  }
  if (!response.ok) throw new ShopifyOAuthError('exchange_failed');
  const body = (await response.json().catch(() => null)) as { access_token?: unknown; scope?: unknown } | null;
  const accessToken = typeof body?.access_token === 'string' ? body.access_token : '';
  if (!accessToken || accessToken.length > 1000) throw new ShopifyOAuthError('exchange_failed');
  const scopes = typeof body?.scope === 'string' ? body.scope.split(',').map((s) => s.trim()).filter(Boolean) : [];
  return { accessToken, scopes };
}
