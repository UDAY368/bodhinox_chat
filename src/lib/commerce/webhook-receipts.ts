import type { Prisma } from '@prisma/client';

/**
 * Inbound webhook idempotency for commerce providers. Reuses the worker-only
 * webhook_receipts table (the Meta webhook uses it with a body-hash key); our
 * keys are namespaced `<provider>:<receipt id>` so they can never collide.
 *
 * Use inside a worker-role transaction (getWorkerPrisma().$transaction), after
 * the signature has been verified, and enqueue the processing job in the same
 * transaction so the receipt and its job commit together before the HTTP 200.
 */
export type CommerceWebhookProvider = 'razorpay' | 'shopify' | 'woocommerce' | 'zoom' | 'shiprocket';

const RECEIPT_ID = /^[A-Za-z0-9._:-]{1,200}$/;

export function receiptDedupeKey(provider: CommerceWebhookProvider, receiptId: string): string {
  if (!RECEIPT_ID.test(receiptId)) throw new Error('Invalid webhook receipt id');
  return `${provider}:${receiptId}`;
}

/**
 * Records a provider delivery once. `receiptId` is the provider's delivery id
 * (Razorpay x-razorpay-event-id, Shopify X-Shopify-Webhook-Id, WooCommerce
 * X-WC-Webhook-Delivery-ID plus topic, or a body hash when none exists).
 * `payload` must be minimised: ids and statuses, never full customer records.
 * Returns `duplicate: true` when this delivery was already recorded.
 */
export async function claimWebhookReceipt(
  tx: Prisma.TransactionClient,
  input: { provider: CommerceWebhookProvider; receiptId: string; payload: Record<string, unknown> },
): Promise<{ id: string; duplicate: boolean }> {
  const key = receiptDedupeKey(input.provider, input.receiptId);
  const payload = JSON.stringify(input.payload ?? {});
  if (payload.length > 64 * 1024) throw new Error('Webhook receipt payload too large');
  const inserted = await tx.$queryRaw<{ id: string }[]>`
    INSERT INTO webhook_receipts(provider,dedupe_key,payload) VALUES(${input.provider},${key},${payload}::jsonb)
    ON CONFLICT(dedupe_key) DO NOTHING RETURNING id`;
  if (inserted.length) return { id: inserted[0].id, duplicate: false };
  const existing = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM webhook_receipts WHERE dedupe_key=${key}`;
  if (!existing.length) throw new Error('Webhook receipt could not be recorded');
  return { id: existing[0].id, duplicate: true };
}

/** Marks a receipt processed (call from the job that handled it). */
export async function markWebhookReceiptProcessed(tx: Prisma.TransactionClient, id: string): Promise<void> {
  await tx.$executeRaw`UPDATE webhook_receipts SET status='processed' WHERE id=${id}::uuid`;
}
