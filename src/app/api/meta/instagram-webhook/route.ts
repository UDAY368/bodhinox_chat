// GET  /api/meta/instagram-webhook — Meta's subscription check (hub.verify_token).
// POST /api/meta/instagram-webhook — signed Instagram webhook deliveries
// (messages, messaging_postbacks, comments).
//
// A copy of the Page webhook route, kept separate so WhatsApp and Page
// webhooks stay untouched. The signature is checked on the raw bytes before
// parsing, even while Instagram is off. The Instagram app secret(s) and
// META_APP_SECRET are both accepted (both are ours); the live check records
// which one Meta signs Instagram Login deliveries with. While Instagram is off
// or unconfigured a signed delivery is acknowledged and nothing is stored.
// Nothing from the body is logged.
import { createHash, timingSafeEqual } from 'node:crypto';
import { verifyMetaWebhookSignature } from '@/lib/whatsapp/webhook-signature';
import { instagramConfig } from '@/lib/instagram/config';
import { persistInstagramWebhook } from '@/lib/instagram/webhook';

export const runtime = 'nodejs';
const MAX_BYTES = 2 * 1024 * 1024;
const MAX_ITEMS = 100;
const CHALLENGE = /^[0-9A-Za-z_-]{1,128}$/;
const forbidden = () => new Response('Forbidden', { status: 403 });
const sha256 = (value: string) => createHash('sha256').update(value).digest();

export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const token = params.get('hub.verify_token');
  const challenge = params.get('hub.challenge');
  const expected = instagramConfig()?.webhookVerifyToken;
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

const boundedList = (value: unknown) => value === undefined || (Array.isArray(value) && value.length <= MAX_ITEMS);

function validPayload(payload: unknown): payload is Record<string, unknown> {
  if (!payload || typeof payload !== 'object') return false;
  const p = payload as { object?: unknown; entry?: unknown };
  if (p.object !== 'instagram' || !Array.isArray(p.entry) || p.entry.length > MAX_ITEMS) return false;
  return p.entry.every((entry: unknown) => {
    if (!entry || typeof entry !== 'object') return false;
    const e = entry as { messaging?: unknown; changes?: unknown; standby?: unknown };
    return boundedList(e.messaging) && boundedList(e.changes) && boundedList(e.standby);
  });
}

/** Every secret a delivery may be signed with: the Instagram app secret(s), then META_APP_SECRET. */
function webhookSecrets(): string {
  return [process.env.INSTAGRAM_APP_SECRET, process.env.META_APP_SECRET].map((s) => s?.trim()).filter(Boolean).join(',');
}

export async function POST(request: Request) {
  if (Number(request.headers.get('content-length')) > MAX_BYTES) return new Response('Payload too large', { status: 413 });
  const raw = await readCapped(request);
  if (raw === null) return new Response('Payload too large', { status: 413 });
  if (!raw) return new Response('Missing body', { status: 400 });
  const secrets = instagramConfig()?.webhookSecrets ?? webhookSecrets();
  if (!verifyMetaWebhookSignature(raw, request.headers.get('x-hub-signature-256'), secrets))
    return new Response('Invalid signature', { status: 401 });
  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    return new Response('Invalid payload', { status: 400 });
  }
  if (!validPayload(payload)) return new Response('Invalid payload', { status: 400 });
  if (!instagramConfig()) return Response.json({ status: 'ignored' });
  try {
    const receiptId = await persistInstagramWebhook(raw, payload);
    return Response.json({ status: 'received', receipt_id: receiptId });
  } catch {
    return new Response('Persistence unavailable; retry delivery', { status: 503 });
  }
}
