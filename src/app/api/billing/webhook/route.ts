// POST /api/billing/webhook — the PLATFORM's Razorpay subscription events.
// Public (no session): Razorpay signs the raw body with
// BILLING_RAZORPAY_WEBHOOK_SECRET (X-Razorpay-Signature, hex HMAC-SHA256).
// Set up in the platform Razorpay dashboard: Settings → Webhooks → URL
// https://<APP_URL>/api/billing/webhook, events subscription.*, invoice.paid and payment.failed
// (acted on only when the payment names its subscription).
//
// The verified event is stored once per X-Razorpay-Event-Id (billing_events)
// and its processing job is queued in the same transaction before the 200, so
// a crash after the acknowledgment loses nothing and a redelivery changes
// nothing. Only ids, states and amounts are stored. Bodies and secrets are never logged.

import { createHash } from 'node:crypto';
import { NextResponse } from 'next/server';

import { getBillingProvider } from '@/lib/billing/razorpay-billing';
import { HANDLED_EVENTS, recordBillingEvent } from '@/lib/billing/subscriptions';
import { checkRateLimit, rateLimitResponse } from '@/lib/rate-limit';

export const runtime = 'nodejs';

const MAX_BYTES = 256 * 1024;
const EVENT_ID = /^[A-Za-z0-9_.-]{1,100}$/;
const WEBHOOK_LIMIT = { limit: 600, windowMs: 60_000 };

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

export async function POST(request: Request) {
  const provider = getBillingProvider();
  // Billing off: nothing listens here.
  if (!provider) return new Response('Not found', { status: 404 });
  const limit = checkRateLimit('billingWebhook', WEBHOOK_LIMIT);
  if (!limit.success) return rateLimitResponse(limit);
  const raw = await readBody(request);
  if (raw === null) return new Response('Invalid body', { status: 400 });
  if (!provider.verifyWebhook(raw, request.headers.get('x-razorpay-signature'))) return new Response('Invalid signature', { status: 401 });

  let body: unknown;
  try { body = JSON.parse(raw); } catch { return new Response('Invalid payload', { status: 400 }); }
  const event = provider.parseWebhook(body);
  // Anything we do not act on (payment.* without a subscription, other products) is acknowledged and ignored.
  if (!event || !HANDLED_EVENTS.has(event.type) || !event.subscriptionId) return NextResponse.json({ ok: true });

  const header = request.headers.get('x-razorpay-event-id')?.trim() ?? '';
  const eventId = EVENT_ID.test(header) ? header : `sha256-${createHash('sha256').update(raw).digest('hex')}`;
  try {
    await recordBillingEvent(eventId, event);
  } catch {
    // Not acknowledged, so Razorpay delivers it again.
    return new Response('Unavailable', { status: 500 });
  }
  return NextResponse.json({ ok: true });
}
