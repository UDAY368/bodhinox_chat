// GET  /api/meta/page-webhook — Meta's subscription check (hub.verify_token).
// POST /api/meta/page-webhook — signed Page webhook deliveries (leadgen).
//
// Separate from the WhatsApp webhook so that route and its verify-token lookup
// stay untouched. The signature is checked on the raw bytes before parsing,
// even while the feature is off. While META_ADS_ENABLED is off or unconfigured
// a signed delivery is acknowledged and nothing is stored. Nothing from the
// body (Page or lead ids) is logged.
import { createHash, timingSafeEqual } from 'node:crypto';
import { verifyMetaWebhookSignature } from '@/lib/whatsapp/webhook-signature';
import { metaAdsConfig } from '@/lib/meta-ads/config';
import { persistPageWebhook } from '@/lib/meta-ads/leads';

export const runtime = 'nodejs';
const MAX_BYTES = 2 * 1024 * 1024;
const CHALLENGE = /^[0-9A-Za-z_-]{1,128}$/;
const forbidden = () => new Response('Forbidden', { status: 403 });
const sha256 = (value: string) => createHash('sha256').update(value).digest();

export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const token = params.get('hub.verify_token');
  const challenge = params.get('hub.challenge');
  const expected = metaAdsConfig()?.pageWebhookVerifyToken;
  if (!expected || params.get('hub.mode') !== 'subscribe' || !token || token.length > 512 || !challenge || !CHALLENGE.test(challenge))
    return forbidden();
  // Equal-length digests, so the comparison time does not depend on the token.
  if (!timingSafeEqual(sha256(token), sha256(expected))) return forbidden();
  return new Response(challenge, { headers: { 'Content-Type': 'text/plain' } });
}

async function readCapped(request: Request): Promise<string | null> {
  const reader = request.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  while (true) {
    const item = await reader.read();
    if (item.done) break;
    bytes += item.value.byteLength;
    if (bytes > MAX_BYTES) {
      await reader.cancel();
      return null;
    }
    chunks.push(item.value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function validPayload(payload: unknown): payload is Record<string, unknown> {
  if (!payload || typeof payload !== 'object') return false;
  const p = payload as { object?: unknown; entry?: unknown };
  if (p.object !== 'page' || !Array.isArray(p.entry) || p.entry.length > 100) return false;
  return p.entry.every((entry: unknown) => {
    if (!entry || typeof entry !== 'object') return false;
    const changes = (entry as { changes?: unknown }).changes;
    return changes === undefined || (Array.isArray(changes) && changes.length <= 100);
  });
}

export async function POST(request: Request) {
  if (Number(request.headers.get('content-length')) > MAX_BYTES) return new Response('Payload too large', { status: 413 });
  const raw = await readCapped(request);
  if (raw === null) return new Response('Payload too large', { status: 413 });
  if (!raw) return new Response('Missing body', { status: 400 });
  if (!verifyMetaWebhookSignature(raw, request.headers.get('x-hub-signature-256'))) return new Response('Invalid signature', { status: 401 });
  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    return new Response('Invalid payload', { status: 400 });
  }
  if (!validPayload(payload)) return new Response('Invalid payload', { status: 400 });
  if (!metaAdsConfig()) return Response.json({ status: 'ignored' });
  try {
    const receiptId = await persistPageWebhook(raw, payload);
    return Response.json({ status: 'received', receipt_id: receiptId });
  } catch {
    return new Response('Persistence unavailable; retry delivery', { status: 503 });
  }
}
