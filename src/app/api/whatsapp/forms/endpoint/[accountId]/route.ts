// POST /api/whatsapp/forms/endpoint/{accountId} — the data endpoint Meta calls
// for WhatsApp Forms that check answers on our server. Public (no session):
// Meta signs the body with the app secret and encrypts it with the account's
// forms public key. Status codes follow Meta's contract: 421 asks the client
// to refetch the public key, 427 means the flow token is invalid or expired.
// The decrypted request carries customer answers and is never logged.

import { checkRateLimit, rateLimitResponse } from '@/lib/rate-limit';
import { decryptRequest, encryptResponse, isEncryptedFormsRequest } from '@/lib/whatsapp/forms/crypto';
import { handleFormsExchange } from '@/lib/whatsapp/forms/endpoint';
import { formsPrivateKeys, formsSessionStore } from '@/lib/whatsapp/forms/session-store';
import { verifyMetaWebhookSignature } from '@/lib/whatsapp/webhook-signature';

export const runtime = 'nodejs';

const MAX_BYTES = 256 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
/** Per account: a busy form sends one request per screen per customer. */
const ENDPOINT_LIMIT = { limit: 600, windowMs: 60_000 };

async function readBody(request: Request): Promise<string | null> {
  if (Number(request.headers.get('content-length')) > MAX_BYTES) return null;
  const reader = request.body?.getReader();
  if (!reader) return null;
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  while (true) {
    const item = await reader.read();
    if (item.done) break;
    bytes += item.value.byteLength;
    if (bytes > MAX_BYTES) { await reader.cancel(); return null; }
    chunks.push(item.value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export async function POST(request: Request, context: { params: Promise<{ accountId: string }> }) {
  const { accountId } = await context.params;
  const raw = await readBody(request);
  if (raw === null) return new Response('Invalid body', { status: 400 });
  // Fails closed when META_APP_SECRET is missing.
  if (!verifyMetaWebhookSignature(raw, request.headers.get('x-hub-signature-256'))) return new Response('Invalid signature', { status: 401 });
  if (!UUID.test(accountId)) return new Response('Not found', { status: 404 });
  const limit = checkRateLimit(`formsEndpoint:${accountId}`, ENDPOINT_LIMIT);
  if (!limit.success) return rateLimitResponse(limit);

  let body: unknown;
  try { body = JSON.parse(raw); } catch { return new Response('Invalid payload', { status: 400 }); }
  if (!isEncryptedFormsRequest(body)) return new Response('Invalid payload', { status: 400 });

  try {
    // The current key first, then a rotation Meta may hold but we never promoted.
    const privateKeys = await formsPrivateKeys(accountId);
    if (privateKeys.length === 0) return new Response('Key unavailable', { status: 421 });
    let opened;
    for (const privateKeyPem of privateKeys) {
      try { opened = decryptRequest(body, privateKeyPem); break; } catch { /* try the next key */ }
    }
    if (!opened) return new Response('Decryption failed', { status: 421 });
    const result = await handleFormsExchange(opened.decrypted, formsSessionStore(accountId));
    if (result.status !== 200) return new Response(null, { status: result.status });
    return new Response(encryptResponse(result.body, opened.aesKey, opened.iv), { headers: { 'Content-Type': 'text/plain' } });
  } catch {
    return new Response('Endpoint unavailable', { status: 500 });
  }
}
