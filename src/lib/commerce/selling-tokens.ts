/**
 * Signed values for the store's selling options (store plan Phase 8, batch 3). Server only (node:crypto).
 *
 * - Download links for digital products: HMAC over account, order and expiry. The link carries no secret
 *   and names no storage object; the route checks signature, expiry and that the order is paid.
 * - The shop password: scrypt with a random salt, compared in constant time. Only the hash is stored.
 * - The shop access cookie: HMAC over handle, expiry and a fingerprint of the stored hash, so changing
 *   the password (or the shop) invalidates every cookie.
 *
 * Every function takes an optional key so the tests do not need ENCRYPTION_KEY; production derives
 * separate keys from it (HKDF with a purpose each).
 */
import { createHash, createHmac, hkdfSync, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

export const DOWNLOAD_LINK_TTL_MS = 14 * 86_400_000;
export const ACCESS_COOKIE_TTL_MS = 30 * 86_400_000;
export const SHOP_PASSWORD = { min: 6, max: 72 } as const;

function purposeKey(info: string): Buffer {
  const hex = process.env.ENCRYPTION_KEY;
  if (!hex || !/^[0-9a-fA-F]{64}$/.test(hex)) throw new Error('ENCRYPTION_KEY must be a 32-byte hex key');
  return Buffer.from(hkdfSync('sha256', Buffer.from(hex, 'hex'), Buffer.alloc(0), info, 32));
}

const mac = (key: Buffer, data: string): string => createHmac('sha256', key).update(data).digest('base64url');
const sameText = (a: string, b: string): boolean => {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// ---------------------------------------------------------------------------
// Download links

export interface DownloadLinkClaim { accountId: string; orderId: string; expiresAtMs: number }

/** The signature of a download link. */
export function signDownload(claim: DownloadLinkClaim, key: Buffer = purposeKey('shop-download')): string {
  return mac(key, `d1:${claim.accountId.toLowerCase()}:${claim.orderId.toLowerCase()}:${claim.expiresAtMs}`);
}

export type DownloadCheck = 'ok' | 'expired' | 'invalid';

/** Check a link's parts (as read from the query string). A bad shape or signature is 'invalid' whatever the time. */
export function checkDownload(parts: { accountId: unknown; orderId: unknown; expires: unknown; signature: unknown }, now: Date,
  key: Buffer = purposeKey('shop-download')): DownloadCheck {
  const { accountId, orderId, expires, signature } = parts;
  if (typeof accountId !== 'string' || !UUID.test(accountId) || typeof orderId !== 'string' || !UUID.test(orderId)
    || typeof expires !== 'string' || !/^\d{10,15}$/.test(expires) || typeof signature !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(signature)) return 'invalid';
  const expiresAtMs = Number(expires);
  if (!sameText(signDownload({ accountId, orderId, expiresAtMs }, key), signature)) return 'invalid';
  return expiresAtMs <= now.getTime() ? 'expired' : 'ok';
}

/** The query string of a signed download link that expires at `expiresAt`. */
export function downloadQuery(claim: { accountId: string; orderId: string }, expiresAt: Date, key?: Buffer): string {
  const expiresAtMs = expiresAt.getTime();
  const signature = signDownload({ ...claim, expiresAtMs }, key);
  return `a=${claim.accountId}&o=${claim.orderId}&e=${expiresAtMs}&s=${signature}`;
}

// ---------------------------------------------------------------------------
// Shop password

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 32 } as const;

/** A password's stored form: scrypt$N$salt$hash (base64url parts). */
export function hashShopPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p });
  return `scrypt$${SCRYPT.N}$${salt.toString('base64url')}$${hash.toString('base64url')}`;
}

/** Whether `password` matches a stored hash, comparing in constant time. A malformed stored value never matches. */
export function verifyShopPassword(password: string, stored: string | null): boolean {
  if (!stored || typeof password !== 'string' || password.length > 1024) return false;
  const [scheme, n, salt, hash] = stored.split('$');
  if (scheme !== 'scrypt' || n !== String(SCRYPT.N) || !salt || !hash) return false;
  const expected = Buffer.from(hash, 'base64url');
  if (expected.length !== SCRYPT.keylen) return false;
  const actual = scryptSync(password, Buffer.from(salt, 'base64url'), SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p });
  return timingSafeEqual(actual, expected);
}

/** A password the shop accepts as a new password: 6 to 72 characters, no control characters. */
export const validShopPassword = (value: unknown): value is string =>
  typeof value === 'string' && value.length >= SHOP_PASSWORD.min && value.length <= SHOP_PASSWORD.max && !/[\u0000-\u001f\u007f]/.test(value);

// ---------------------------------------------------------------------------
// Shop access cookie

export const accessCookieName = (handle: string): string => `shop_access_${handle}`;
/** Binds a cookie to the current password: changing it signs every visitor out. */
const fingerprint = (passwordHash: string): string => createHash('sha256').update(passwordHash).digest('hex').slice(0, 16);

export function signAccessCookie(handle: string, passwordHash: string, expiresAt: Date, key: Buffer = purposeKey('shop-access')): string {
  const expires = expiresAt.getTime();
  return `${expires}.${mac(key, `a1:${handle}:${fingerprint(passwordHash)}:${expires}`)}`;
}

export function verifyAccessCookie(value: string | null | undefined, handle: string, passwordHash: string | null, now: Date,
  key: Buffer = purposeKey('shop-access')): boolean {
  if (!value || !passwordHash || value.length > 100) return false;
  const [expires, signature] = value.split('.');
  if (!expires || !signature || !/^\d{10,15}$/.test(expires) || Number(expires) <= now.getTime()) return false;
  return sameText(mac(key, `a1:${handle}:${fingerprint(passwordHash)}:${expires}`), signature);
}
