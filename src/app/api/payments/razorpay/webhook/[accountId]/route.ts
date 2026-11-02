// POST /api/payments/razorpay/webhook/{accountId} — Razorpay payment-link events
// for one workspace. Public (no session): Razorpay signs the raw body with the
// webhook secret the workspace saved (X-Razorpay-Signature, hex HMAC-SHA256).
// Set up in the Razorpay dashboard: Settings → Webhooks → URL
// https://<APP_URL>/api/payments/razorpay/webhook/<accountId>, the same secret,
// events payment_link.paid / partially_paid / expired / cancelled.
//
// The verified delivery is recorded once (webhook_receipts) and its processing
// job is queued in the same transaction before the 200, so a crash after the
// acknowledgment loses nothing and a redelivery changes nothing. Bodies and
// secrets are never logged.

import { createHash } from 'node:crypto';
import { NextResponse } from 'next/server';

import { getWorkerPrisma } from '@/lib/db/prisma';
import { claimWebhookReceipt } from '@/lib/commerce/webhook-receipts';
import { PAYMENT_EVENT_JOB, statusForEvent } from '@/lib/payments/links';
import { loadRazorpaySecrets, PaymentProviderError } from '@/lib/payments/providers';
import { parsePaymentLinkEvent, verifyWebhookSignature } from '@/lib/payments/razorpay';
import { checkRateLimit, rateLimitResponse } from '@/lib/rate-limit';

export const runtime = 'nodejs';

const MAX_BYTES = 256 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const EVENT_ID = /^[A-Za-z0-9_.-]{1,100}$/;
/** Per account: Razorpay retries failed deliveries, but never at this rate. */
const WEBHOOK_LIMIT = { limit: 300, windowMs: 60_000 };

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

const unauthorized = () => new Response('Invalid signature', { status: 401 });

export async function POST(request: Request, context: { params: Promise<{ accountId: string }> }) {
  const { accountId } = await context.params;
  // An unknown account looks exactly like a bad signature.
  if (!UUID.test(accountId)) return unauthorized();
  const limit = checkRateLimit(`razorpayWebhook:${accountId}`, WEBHOOK_LIMIT);
  if (!limit.success) return rateLimitResponse(limit);
  const raw = await readBody(request);
  if (raw === null) return new Response('Invalid body', { status: 400 });

  let secret: string | null;
  try {
    secret = (await loadRazorpaySecrets(accountId)).webhookSecret;
  } catch (error) {
    if (error instanceof PaymentProviderError) return unauthorized();
    return new Response('Unavailable', { status: 500 });
  }
  if (!secret || !verifyWebhookSignature(raw, request.headers.get('x-razorpay-signature'), secret)) return unauthorized();

  let body: unknown;
  try { body = JSON.parse(raw); } catch { return new Response('Invalid payload', { status: 400 }); }
  const event = parsePaymentLinkEvent(body);
  // Anything but a payment-link event we act on is acknowledged and ignored.
  if (!event || !statusForEvent(event.event)) return NextResponse.json({ ok: true });

  // Razorpay's delivery id; a body hash when it is missing. Namespaced by
  // account so one Razorpay account connected to two workspaces reaches both.
  const header = request.headers.get('x-razorpay-event-id')?.trim() ?? '';
  const deliveryId = EVENT_ID.test(header) ? header : `sha256-${createHash('sha256').update(raw).digest('hex')}`;
  try {
    await getWorkerPrisma().$transaction(async (tx) => {
      const receipt = await claimWebhookReceipt(tx, {
        provider: 'razorpay',
        receiptId: `${accountId}:${deliveryId}`,
        // Ids and statuses only: no customer details.
        payload: { accountId, event: event.event, paymentLinkId: event.paymentLinkId, referenceId: event.referenceId, status: event.status },
      });
      if (receipt.duplicate) return;
      await tx.$executeRaw`INSERT INTO jobs(type,tenant_id,payload,dedupe_key)
        VALUES(${PAYMENT_EVENT_JOB},${accountId}::uuid,${JSON.stringify({ receiptId: receipt.id })}::jsonb,${`payment-event:${receipt.id}`})
        ON CONFLICT(dedupe_key) DO NOTHING`;
    });
  } catch {
    // Not acknowledged, so Razorpay delivers it again.
    return new Response('Unavailable', { status: 500 });
  }
  return NextResponse.json({ ok: true });
}
