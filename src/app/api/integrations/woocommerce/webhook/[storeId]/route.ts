// POST /api/integrations/woocommerce/webhook/<storeId> — public WooCommerce
// order webhooks. Signature-verified (X-WC-Webhook-Signature), idempotent per
// delivery and per order event, and acknowledged only after the events and
// their send jobs are committed (src/lib/integrations/woocommerce/process.ts).

import { processWooWebhook } from '@/lib/integrations/woocommerce/process';
import { checkRateLimit, rateLimitResponse } from '@/lib/rate-limit';

export const runtime = 'nodejs';
const MAX_BYTES = 1024 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Per store, before any database work: WooCommerce retries, but never at this rate. */
const WEBHOOK_LIMIT = { limit: 300, windowMs: 60_000 };

export async function POST(request: Request, { params }: { params: Promise<{ storeId: string }> }) {
  const { storeId } = await params;
  if (!UUID.test(storeId)) return Response.json({ error: 'Unknown store' }, { status: 404 });
  const limit = checkRateLimit(`wooWebhook:${storeId.toLowerCase()}`, WEBHOOK_LIMIT);
  if (!limit.success) return rateLimitResponse(limit);
  if (Number(request.headers.get('content-length')) > MAX_BYTES) return new Response('Payload too large', { status: 413 });
  const reader = request.body?.getReader();
  if (!reader) return new Response('Missing body', { status: 400 });
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  while (true) {
    const item = await reader.read();
    if (item.done) break;
    bytes += item.value.byteLength;
    if (bytes > MAX_BYTES) {
      await reader.cancel();
      return new Response('Payload too large', { status: 413 });
    }
    chunks.push(item.value);
  }
  try {
    const result = await processWooWebhook({ storeId, rawBody: Buffer.concat(chunks).toString('utf8'), headers: request.headers });
    return Response.json(result.body, { status: result.status });
  } catch (err) {
    console.error('[woocommerce] webhook processing failed', err instanceof Error ? err.name : 'unknown');
    return Response.json({ error: 'Temporarily unavailable' }, { status: 503 });
  }
}
