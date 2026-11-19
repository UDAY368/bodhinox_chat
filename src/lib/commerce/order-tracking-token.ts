/**
 * Order tracking links (store plan Phase 5). Stateless, like the storefront
 * link tokens (./storefront-token): nothing is stored, so nothing can leak
 * from the database.
 *
 *   token = base64url( account_id[16] | order_id[16] | HMAC-SHA256(HKDF(ENCRYPTION_KEY,'order-tracking'), account_id|order_id)[0..16] )
 *
 * 128 bits of MAC make a token unguessable; a wrong one is refused before any
 * database read. The token reveals only two random UUIDs. Rotating
 * ENCRYPTION_KEY invalidates every link. Server-only (reads the key).
 */
import { createHmac, hkdfSync, timingSafeEqual } from 'node:crypto';
import { appOrigin } from '@/lib/auth/csrf';

/** 48 bytes in base64url. */
export const ORDER_TRACKING_TOKEN = /^[A-Za-z0-9_-]{64}$/;

function key(): Buffer {
  const hex = process.env.ENCRYPTION_KEY;
  if (!hex || !/^[0-9a-fA-F]{64}$/.test(hex)) throw new Error('ENCRYPTION_KEY must be a 32-byte hex key');
  return Buffer.from(hkdfSync('sha256', Buffer.from(hex, 'hex'), Buffer.alloc(0), 'order-tracking', 32));
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const bytes = (uuid: string) => Buffer.from(uuid.replace(/-/g, ''), 'hex');
const uuid = (b: Buffer) => {
  const h = b.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
};
const mac = (ids: Buffer) => createHmac('sha256', key()).update(ids).digest().subarray(0, 16);

export function orderTrackingToken(accountId: string, orderId: string): string {
  if (!UUID.test(accountId) || !UUID.test(orderId)) throw new RangeError('Invalid id');
  const ids = Buffer.concat([bytes(accountId), bytes(orderId)]);
  return Buffer.concat([ids, mac(ids)]).toString('base64url');
}

/** The account and order a genuine token names, or null for anything else. */
export function readOrderTrackingToken(value: unknown): { accountId: string; orderId: string } | null {
  if (typeof value !== 'string' || !ORDER_TRACKING_TOKEN.test(value)) return null;
  const raw = Buffer.from(value, 'base64url');
  if (raw.length !== 48) return null;
  const ids = raw.subarray(0, 32);
  if (!timingSafeEqual(mac(ids), raw.subarray(32))) return null;
  return { accountId: uuid(ids.subarray(0, 16)), orderId: uuid(ids.subarray(16)) };
}

export const orderTrackingPath = (handle: string, token: string) => `/s/${handle}/track/${token}`;
export const orderTrackingUrl = (handle: string, token: string) => `${appOrigin()}${orderTrackingPath(handle, token)}`;
