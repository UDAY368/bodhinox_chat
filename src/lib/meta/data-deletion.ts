/**
 * Meta's Data Deletion Request Callback (Meta App Dashboard → App settings →
 * Basic → Data deletion request URL = `${APP_URL}/api/meta/data-deletion`).
 * Reference: https://developers.facebook.com/docs/development/create-an-app/app-dashboard/data-deletion-callback
 *
 * When a person removes the app from their Facebook settings and asks for their
 * data to be deleted, Meta POSTs `signed_request=<sig>.<payload>` (base64url):
 * the payload is JSON `{ algorithm: 'HMAC-SHA256', issued_at, user_id }` and
 * the signature is HMAC-SHA256 of the encoded payload with our app secret.
 * We answer `{ url, confirmation_code }`; the url is the public status page
 * (/data-deletion?code=...).
 *
 * What is deleted: nothing in the product is keyed to a Facebook user id. The
 * Facebook login only authorises business assets (WhatsApp Business accounts,
 * Instagram accounts, Pages, ad accounts) for a workspace, and Meta revokes the
 * tokens it issued to us when the app is removed. So the request is recorded as
 * completed; business data inside a workspace is deleted by the workspace owner
 * (Settings → Privacy & access) as the /data-deletion page explains.
 *
 * The Facebook user id is stored only as a SHA-256 hash (to answer a repeated
 * delivery with the same code) and is never logged.
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { getWorkerPrisma } from '@/lib/db/prisma';
import { parseAppSecrets } from '@/lib/whatsapp/webhook-signature';

export interface SignedDeletionRequest {
  userId: string;
  issuedAt: number;
}

const B64URL = /^[A-Za-z0-9_-]+={0,2}$/;
const USER_ID = /^\d{1,32}$/;
export const CONFIRMATION_CODE = /^[A-Za-z0-9]{20,64}$/;
const MAX_SIGNED_REQUEST = 4096;

/**
 * Verify and decode a signed_request against any configured app secret
 * (META_APP_SECRET may hold several, comma separated). Every candidate is
 * compared in constant time. Null when malformed, unsigned or not ours.
 */
export function parseSignedRequest(
  signedRequest: unknown,
  secretsRaw: string | undefined = process.env.META_APP_SECRET
): SignedDeletionRequest | null {
  if (typeof signedRequest !== 'string' || signedRequest.length > MAX_SIGNED_REQUEST) return null;
  const parts = signedRequest.split('.');
  if (parts.length !== 2) return null;
  const [encodedSig, encodedPayload] = parts;
  if (!B64URL.test(encodedSig) || !B64URL.test(encodedPayload)) return null;
  const secrets = parseAppSecrets(secretsRaw);
  if (secrets.length === 0) return null;
  const supplied = Buffer.from(encodedSig, 'base64url');
  let ok = false;
  for (const secret of secrets) {
    const expected = createHmac('sha256', secret).update(encodedPayload).digest();
    if (supplied.length === expected.length && timingSafeEqual(supplied, expected)) ok = true;
  }
  if (!ok) return null;
  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(encodedPayload, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (!payload || typeof payload !== 'object') return null;
  const { algorithm, user_id: userId, issued_at: issuedAt } = payload as Record<string, unknown>;
  if (typeof algorithm !== 'string' || algorithm.toUpperCase() !== 'HMAC-SHA256') return null;
  const id = typeof userId === 'number' && Number.isSafeInteger(userId) ? String(userId) : userId;
  if (typeof id !== 'string' || !USER_ID.test(id)) return null;
  if (typeof issuedAt !== 'number' || !Number.isSafeInteger(issuedAt) || issuedAt < 0) return null;
  return { userId: id, issuedAt };
}

export function newConfirmationCode(): string {
  // 24 bytes as hex: 48 characters, matches CONFIRMATION_CODE.
  return randomBytes(24).toString('hex');
}

/**
 * Record a verified request and return its confirmation code. The same signed
 * request delivered again returns the code it got the first time.
 */
export async function recordDeletionRequest(
  request: SignedDeletionRequest,
  db: PrismaClient = getWorkerPrisma()
): Promise<string> {
  const hash = createHash('sha256').update(request.userId).digest('hex');
  const inserted = await db.$queryRaw<{ confirmation_code: string }[]>`
    INSERT INTO meta_data_deletion_requests(confirmation_code, app_user_hash, issued_at, status)
    VALUES (${newConfirmationCode()}, ${hash}, ${request.issuedAt}, 'completed')
    ON CONFLICT (app_user_hash, issued_at) DO NOTHING
    RETURNING confirmation_code`;
  if (inserted[0]) return inserted[0].confirmation_code;
  const existing = await db.$queryRaw<{ confirmation_code: string }[]>`
    SELECT confirmation_code FROM meta_data_deletion_requests
    WHERE app_user_hash=${hash} AND issued_at=${request.issuedAt}`;
  if (!existing[0]) throw new Error('Data deletion request could not be recorded');
  return existing[0].confirmation_code;
}

export interface DeletionRequestStatus {
  status: 'received' | 'completed';
  createdAt: Date;
}

/** The status page's lookup: one row by its code, null for an unknown or malformed code. */
export async function findDeletionRequest(
  code: unknown,
  db: PrismaClient = getWorkerPrisma()
): Promise<DeletionRequestStatus | null> {
  if (typeof code !== 'string' || !CONFIRMATION_CODE.test(code)) return null;
  const rows = await db.$queryRaw<{ status: 'received' | 'completed'; created_at: Date }[]>`
    SELECT status, created_at FROM meta_data_deletion_requests WHERE confirmation_code=${code}`;
  return rows[0] ? { status: rows[0].status, createdAt: rows[0].created_at } : null;
}

/** The status page URL Meta shows the person. */
export function deletionStatusUrl(origin: string, code: string): string {
  const url = new URL('/data-deletion', origin);
  url.searchParams.set('code', code);
  return url.toString();
}
