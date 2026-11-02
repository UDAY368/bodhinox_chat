// POST /api/integrations/shopify/webhooks — public; authenticated only by
// X-Shopify-Hmac-Sha256 over the raw body (app secret). Order, checkout,
// app/uninstalled and the mandatory GDPR topics. Answers 200 only after the
// receipt, the event and its queued send are committed; any failure is 503 so
// Shopify redelivers, and a redelivery is deduplicated by X-Shopify-Webhook-Id.
// No session or CSRF applies: the proxy only checks mutations that carry a
// session cookie, which Shopify never sends.

import { shopifyConfig } from '@/lib/integrations/shopify/config';
import { isShopDomain } from '@/lib/integrations/shopify/oauth';
import { processShopifyWebhook, SUPPORTED_TOPICS, verifyWebhookHmac } from '@/lib/integrations/shopify/webhooks';

export const runtime = 'nodejs';
const MAX_BYTES = 1024 * 1024;
const WEBHOOK_ID = /^[A-Za-z0-9-]{1,100}$/;

async function readBody(request: Request): Promise<Buffer | null> {
  if (Number(request.headers.get('content-length')) > MAX_BYTES) return null;
  const reader = request.body?.getReader();
  if (!reader) return Buffer.alloc(0);
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
  return Buffer.concat(chunks);
}

export async function POST(request: Request) {
  const config = shopifyConfig();
  if (!config) return new Response('Shopify is not configured', { status: 503 });
  const raw = await readBody(request);
  if (!raw) return new Response('Payload too large', { status: 413 });
  if (!verifyWebhookHmac(raw, request.headers.get('x-shopify-hmac-sha256'), config.apiSecret))
    return new Response('Invalid signature', { status: 401 });

  const topic = request.headers.get('x-shopify-topic') ?? '';
  const shop = (request.headers.get('x-shopify-shop-domain') ?? '').toLowerCase();
  const webhookId = request.headers.get('x-shopify-webhook-id') ?? '';
  if (!isShopDomain(shop) || !WEBHOOK_ID.test(webhookId)) return new Response('Invalid headers', { status: 400 });
  // A signed delivery for a topic we do not handle is acknowledged and dropped.
  if (!SUPPORTED_TOPICS.includes(topic)) return Response.json({ status: 'ignored' });

  let body: Record<string, unknown>;
  try {
    const parsed = JSON.parse(raw.toString('utf8')) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Invalid payload');
    body = parsed as Record<string, unknown>;
  } catch {
    return new Response('Invalid payload', { status: 400 });
  }
  const triggeredHeader = request.headers.get('x-shopify-triggered-at');
  const triggeredAt = triggeredHeader ? new Date(triggeredHeader) : null;

  try {
    const status = await processShopifyWebhook({
      topic, shop, webhookId, body, triggeredAt: triggeredAt && !Number.isNaN(triggeredAt.getTime()) ? triggeredAt : null,
    });
    return Response.json({ status });
  } catch (error) {
    console.error('Shopify webhook could not be recorded', error instanceof Error ? error.name : 'unknown');
    return new Response('Persistence unavailable; retry delivery', { status: 503 });
  }
}
