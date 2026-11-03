/**
 * Customer manage-link tokens (design D8).
 *
 *   token = base64url(HMAC-SHA256(HKDF(ENCRYPTION_KEY, 'appointment-manage-link'), id ':' epoch))
 *
 * Only sha256(token) is stored (appointments.manage_token_hash). The token is
 * re-derivable, so the reminder's URL button can carry it without storing
 * plaintext; bumping token_epoch rotates it. Rotating ENCRYPTION_KEY
 * invalidates every link. Server-only (reads the key).
 */
import { createHmac, hkdfSync } from 'node:crypto';
// Relative import: the Playwright seed (e2e/global-setup.ts) derives a token with this module.
import { appOrigin, hashToken } from '../auth/csrf';

const INFO = 'appointment-manage-link';
/** base64url of a 32-byte HMAC. */
export const MANAGE_TOKEN = /^[A-Za-z0-9_-]{43}$/;

function linkKey(): Buffer {
  const hex = process.env.ENCRYPTION_KEY;
  if (!hex || !/^[0-9a-fA-F]{64}$/.test(hex)) throw new Error('ENCRYPTION_KEY must be a 32-byte hex key');
  return Buffer.from(hkdfSync('sha256', Buffer.from(hex, 'hex'), Buffer.alloc(0), INFO, 32));
}

export function deriveManageToken(appointmentId: string, tokenEpoch: number): string {
  if (!Number.isInteger(tokenEpoch) || tokenEpoch < 1) throw new RangeError('Invalid token epoch');
  return createHmac('sha256', linkKey()).update(`${appointmentId}:${tokenEpoch}`).digest('base64url');
}

/** The stored form: sha256 hex of the token. */
export function manageTokenHash(token: string): string {
  return hashToken(token);
}

/** Cheap format check before touching the database. */
export function isManageTokenFormat(value: unknown): value is string {
  return typeof value === 'string' && MANAGE_TOKEN.test(value);
}

/** The path segment a reminder URL button appends to `${APP_URL}/my-booking/`. */
export const MANAGE_PATH = '/my-booking/';

export function manageUrl(token: string): string {
  return `${appOrigin()}${MANAGE_PATH}${token}`;
}
