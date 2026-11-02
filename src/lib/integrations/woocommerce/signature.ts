import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * WooCommerce signs every webhook delivery with
 *   X-WC-Webhook-Signature: base64(HMAC-SHA256(raw body, secret))
 * where the secret is the one pasted into WooCommerce → Settings → Advanced →
 * Webhooks. We generate that secret, so it is always ours and high-entropy.
 */

/** A new webhook secret: 32 random bytes, url-safe base64 (43 characters). */
export function generateWooSecret(): string {
  return randomBytes(32).toString('base64url');
}

const SIGNATURE_SHAPE = /^[A-Za-z0-9+/]{43}=$/;

/**
 * True when the header has the shape of a base64 HMAC-SHA256 (44 characters).
 * Checked before any database work, so junk signatures cost nothing.
 */
export function isWellFormedWooSignature(signatureHeader: string | null | undefined): signatureHeader is string {
  return typeof signatureHeader === 'string' && SIGNATURE_SHAPE.test(signatureHeader.trim());
}

/** Constant-time check of X-WC-Webhook-Signature over the exact raw body. */
export function verifyWooSignature(rawBody: string | Buffer, signatureHeader: string | null | undefined, secret: string): boolean {
  if (!secret || !isWellFormedWooSignature(signatureHeader)) return false;
  const presented = signatureHeader.trim();
  const expected = createHmac('sha256', secret).update(rawBody).digest();
  const given = Buffer.from(presented, 'base64');
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/**
 * WooCommerce "pings" a new webhook's delivery URL with an unsigned
 * `webhook_id=<n>` form body. We answer it 200 without doing anything, so the
 * store can save the webhook; every real delivery must carry a valid signature.
 */
export function isWooPing(rawBody: string): boolean {
  return /^webhook_id=\d{1,20}$/.test(rawBody.trim());
}
