// POST /api/meta/data-deletion: Meta's Data Deletion Request Callback.
// Meta posts application/x-www-form-urlencoded `signed_request`; it is verified
// against META_APP_SECRET (HMAC-SHA256, constant time) before anything is
// stored. Answers { url, confirmation_code } with the public status page.
// Nothing from the request (user id, signature) is logged.
import { appOrigin } from '@/lib/auth/csrf';
import { deletionStatusUrl, parseSignedRequest, recordDeletionRequest } from '@/lib/meta/data-deletion';

export const runtime = 'nodejs';
const MAX_BYTES = 16 * 1024;

export async function POST(request: Request) {
  if (Number(request.headers.get('content-length')) > MAX_BYTES) return new Response('Payload too large', { status: 413 });
  let raw: string;
  try {
    raw = await request.text();
  } catch {
    return new Response('Invalid body', { status: 400 });
  }
  if (raw.length > MAX_BYTES) return new Response('Payload too large', { status: 413 });
  const type = request.headers.get('content-type') ?? '';
  let signed: unknown = null;
  if (type.includes('application/json')) {
    try {
      signed = (JSON.parse(raw) as { signed_request?: unknown })?.signed_request;
    } catch {
      return new Response('Invalid body', { status: 400 });
    }
  } else {
    signed = new URLSearchParams(raw).get('signed_request');
  }
  const parsed = parseSignedRequest(signed);
  if (!parsed) return Response.json({ error: 'invalid_signed_request' }, { status: 400 });
  let origin: string;
  try {
    origin = appOrigin();
  } catch {
    return Response.json({ error: 'not_configured' }, { status: 503 });
  }
  try {
    const code = await recordDeletionRequest(parsed);
    return Response.json({ url: deletionStatusUrl(origin, code), confirmation_code: code });
  } catch {
    return Response.json({ error: 'unavailable' }, { status: 503 });
  }
}
