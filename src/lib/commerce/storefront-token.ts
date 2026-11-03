/**
 * Storefront link tokens (design E12, same scheme as appointment manage links).
 *
 *   token = base64url(HMAC-SHA256(HKDF(ENCRYPTION_KEY, 'storefront-session'), session_id ':' epoch))
 *
 * Only sha256(token) is stored (storefront_sessions.token_hash) and looked up
 * through resolve_storefront_token. The token is re-derivable, so the server
 * can rebuild the link (Razorpay callback_url, a re-send) without storing it;
 * bumping token_epoch rotates it. Rotating ENCRYPTION_KEY invalidates every
 * link. Server-only (reads the key). Shared by lib/commerce/storefront.ts and
 * the Playwright seed (e2e/global-setup.ts), hence the relative import.
 */
import { createHmac, hkdfSync } from 'node:crypto';
import { appOrigin, hashToken } from '../auth/csrf';

const INFO = 'storefront-session';
/** base64url of a 32-byte HMAC. */
export const STOREFRONT_TOKEN = /^[A-Za-z0-9_-]{43}$/;
/** The page path; the success page is `${STOREFRONT_PATH}<token>/done`. */
export const STOREFRONT_PATH = '/shop/';

function linkKey(): Buffer {
  const hex = process.env.ENCRYPTION_KEY;
  if (!hex || !/^[0-9a-fA-F]{64}$/.test(hex)) throw new Error('ENCRYPTION_KEY must be a 32-byte hex key');
  return Buffer.from(hkdfSync('sha256', Buffer.from(hex, 'hex'), Buffer.alloc(0), INFO, 32));
}

export function deriveStorefrontToken(sessionId: string, tokenEpoch: number): string {
  if (!Number.isInteger(tokenEpoch) || tokenEpoch < 1) throw new RangeError('Invalid token epoch');
  return createHmac('sha256', linkKey()).update(`${sessionId}:${tokenEpoch}`).digest('base64url');
}

/** The stored form: sha256 hex of the token. */
export function storefrontTokenHash(token: string): string {
  return hashToken(token);
}

/** Cheap format check before touching the database. */
export function isStorefrontTokenFormat(value: unknown): value is string {
  return typeof value === 'string' && STOREFRONT_TOKEN.test(value);
}

export function storefrontUrl(token: string): string {
  return `${appOrigin()}${STOREFRONT_PATH}${token}`;
}
