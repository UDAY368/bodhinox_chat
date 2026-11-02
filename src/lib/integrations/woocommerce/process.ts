import { createHash } from 'node:crypto';
import { Prisma } from '@prisma/client';

import { normalizePhone, parseInternationalPhone, phoneVariants } from '@/lib/whatsapp/phone-utils';
import { recordCommerceEvent, type RecordCommerceEventResult } from '@/lib/commerce/event-rules';
import { claimWebhookReceipt, markWebhookReceiptProcessed } from '@/lib/commerce/webhook-receipts';
import { getWorkerPrisma } from '@/lib/db/prisma';
import { withTenant, type TenantTransaction } from '@/lib/db/tenant';
import { emitOrderCreated, emitOrderPaid } from '@/lib/webhooks/commerce-events';
import { buildWooCommerceInputs, isWooTopic, parseWooOrder, type WooOrder } from './mapping';
import { isWellFormedWooSignature, isWooPing, verifyWooSignature } from './signature';
import { resolveWooStore, wooStoreExists } from './stores';

/**
 * One WooCommerce webhook delivery, end to end:
 *  1. before any database work: WooCommerce's unsigned creation ping → 200,
 *     nothing stored; a missing or malformed X-WC-Webhook-Signature → 401
 *  2. unknown store → 404; the signature must verify over the raw body → else 401
 *  3. topics other than order.created / order.updated → 200, ignored
 *  4. one worker transaction: claim the receipt (store + X-WC-Webhook-Delivery-ID,
 *     or a body hash), record every mapped commerce event (each queues its send
 *     job in the same transaction), mark the receipt processed. The 200 is
 *     returned only after that commit, so an acknowledged delivery is durable;
 *     a redelivery is a duplicate receipt and changes nothing. If the store was
 *     disconnected meanwhile, the transaction rolls back and the answer is 404,
 *     so no event outlives the disconnect (see stopWooStore).
 *  5. after the commit, best-effort outbound order.created / order.paid webhooks
 *     for events recorded by this delivery.
 * Nothing here logs the body, customer data or the secret.
 */

export interface WooWebhookResult {
  status: number;
  body: Record<string, unknown>;
}

const DELIVERY_ID = /^[A-Za-z0-9_-]{1,80}$/;

/** Thrown inside the transaction to roll it back when the store is gone. */
class WooStoreGone extends Error {}

/**
 * True when a contact with this phone existed before the order's first recorded
 * event. A contact created in the current transaction has created_at = now(),
 * and one created by an earlier delivery of the same order shares that
 * delivery's event timestamp, so neither counts.
 */
async function contactPredatesOrder(
  tx: TenantTransaction, accountId: string, phone: string | null | undefined, storeId: string, orderId: string,
): Promise<boolean> {
  const sanitized = parseInternationalPhone(phone ?? null);
  const normalized = sanitized ? normalizePhone(sanitized) : '';
  if (!normalized) return false;
  const rows = await tx.$queryRaw<{ predates: boolean }[]>`
    SELECT EXISTS(
      SELECT 1 FROM contacts c
      WHERE c.account_id=${accountId}::uuid AND c.phone_normalized IN (${Prisma.join(phoneVariants(normalized))})
        AND c.created_at < COALESCE((
          SELECT min(e.created_at) FROM commerce_events e
          WHERE e.account_id=${accountId}::uuid AND e.source='woocommerce' AND e.external_id=${orderId}
            AND e.dedupe_key LIKE ${`woocommerce:${storeId}:${orderId}:%`}), now())
    ) AS predates`;
  return rows[0]?.predates === true;
}

export async function processWooWebhook(input: { storeId: string; rawBody: string; headers: Headers }): Promise<WooWebhookResult> {
  const signature = input.headers.get('x-wc-webhook-signature');
  if (!signature) {
    return isWooPing(input.rawBody)
      ? { status: 200, body: { status: 'ping' } }
      : { status: 401, body: { error: 'Invalid signature' } };
  }
  if (!isWellFormedWooSignature(signature)) return { status: 401, body: { error: 'Invalid signature' } };

  const store = await resolveWooStore(input.storeId);
  if (!store) return { status: 404, body: { error: 'Unknown store' } };
  if (!verifyWooSignature(input.rawBody, signature, store.secret)) return { status: 401, body: { error: 'Invalid signature' } };

  const topic = input.headers.get('x-wc-webhook-topic');
  if (!isWooTopic(topic)) return { status: 200, body: { status: 'ignored' } };

  let order: WooOrder | null;
  try {
    order = parseWooOrder(JSON.parse(input.rawBody));
  } catch {
    order = null;
  }
  if (!order) return { status: 400, body: { error: 'Invalid payload' } };

  const header = input.headers.get('x-wc-webhook-delivery-id')?.trim() ?? '';
  const deliveryId = DELIVERY_ID.test(header) ? header : `sha256-${createHash('sha256').update(input.rawBody).digest('hex')}`;
  const inputs = buildWooCommerceInputs({
    accountId: store.accountId,
    storeId: store.storeId,
    storeUrl: store.storeUrl,
    consentMetaKey: store.consentMetaKey,
    topic,
    order,
  });

  let outcome: { duplicate: boolean; results: RecordCommerceEventResult[] };
  try {
    outcome = await withTenant({ accountId: store.accountId, role: 'owner' }, async (tx) => {
      const receipt = await claimWebhookReceipt(tx, {
        provider: 'woocommerce',
        receiptId: `${store.storeId}:${deliveryId}`,
        payload: { store_id: store.storeId, topic, order_id: order.id, order_status: order.status },
      });
      if (receipt.duplicate) return { duplicate: true, results: [] as RecordCommerceEventResult[] };
      // Without an explicit store consent, a contact first created by this order
      // (in this or an earlier delivery) is not an "existing contact" for marketing.
      const unknownConsent = inputs.some((i) => i.marketingConsent === null || i.marketingConsent === undefined);
      const predates = unknownConsent && (await contactPredatesOrder(tx, store.accountId, inputs[0]?.phone, store.storeId, order.id));
      const results: RecordCommerceEventResult[] = [];
      for (const event of inputs) {
        const consent = event.marketingConsent ?? (predates ? null : false);
        results.push(await recordCommerceEvent(tx, { ...event, marketingConsent: consent }));
      }
      // A disconnect that committed while this ran: roll back, so its cleanup
      // (stopWooStore) cannot miss events committed after it.
      if (!(await wooStoreExists(tx, store.accountId, store.storeId))) throw new WooStoreGone();
      await markWebhookReceiptProcessed(tx, receipt.id);
      return { duplicate: false, results };
    }, getWorkerPrisma());
  } catch (err) {
    if (err instanceof WooStoreGone) return { status: 404, body: { error: 'Unknown store' } };
    throw err;
  }

  if (outcome.duplicate) return { status: 200, body: { status: 'duplicate' } };

  for (const [i, result] of outcome.results.entries()) {
    if (result.duplicate) continue;
    const event = inputs[i];
    const data = {
      source: 'woocommerce',
      externalId: order.id,
      orderNumber: order.number,
      status: order.status,
      totalMinor: typeof event.payload.total_minor === 'number' ? event.payload.total_minor : null,
      currency: typeof event.payload.currency === 'string' ? event.payload.currency : null,
      itemCount: order.itemCount,
      contactId: result.contactId,
      customerName: event.name ?? null,
      customerPhone: event.phone ?? null,
    };
    if (event.event === 'order_created') await emitOrderCreated(store.accountId, data);
    else if (event.event === 'order_paid') await emitOrderPaid(store.accountId, data);
  }
  return { status: 200, body: { status: 'received', events: outcome.results.length } };
}
