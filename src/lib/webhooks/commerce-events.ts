import { createAdminClient } from '@/lib/data/admin';
import type { DataClient } from '@/lib/data/types';
import { formatMoney, isCurrencyCode } from '@/lib/commerce/money';
import { dispatchWebhookEvent } from './deliver';

/**
 * Outbound webhooks for commerce: 'order.created', 'order.paid' and
 * 'payment_link.paid'. Order and payment code calls these helpers once the
 * state they describe has COMMITTED (never inside a transaction that may still
 * roll back), for example:
 *
 *   await emitOrderCreated(accountId, { orderId, source: 'whatsapp_cart', totalMinor, currency, … });
 *   await emitPaymentLinkPaid(accountId, { paymentLinkId, referenceId, amountPaidMinor, currency, … });
 *
 * Delivery follows the existing outbound webhook model: a signed
 * 'webhook.delivery' job per subscribed endpoint, best effort. The helpers
 * never throw (a failed enqueue is logged without content and returns false),
 * so a webhook problem can never undo or retry the order or payment itself.
 * Call each at most once per order / link transition; the payload `id` is a
 * per-delivery uuid, and receivers dedupe on data.order_id / data.payment_link_id.
 */

export type CommerceWebhookEvent = 'order.created' | 'order.paid' | 'payment_link.paid';

export interface OrderWebhookInput {
  /** Bodhinox order id (orders.id), when the order is stored. */
  orderId?: string | null;
  /** 'shopify' | 'woocommerce' | 'whatsapp_cart' | … */
  source: string;
  /** The store's own order id. */
  externalId?: string | null;
  orderNumber?: string | null;
  status?: string | null;
  totalMinor?: number | null;
  currency?: string | null;
  itemCount?: number | null;
  contactId?: string | null;
  conversationId?: string | null;
  customerName?: string | null;
  /** International format with +. */
  customerPhone?: string | null;
  occurredAt?: Date;
}

export interface PaymentLinkPaidInput {
  /** Bodhinox payment link id (payment_links.id). */
  paymentLinkId: string;
  provider?: string;
  referenceId?: string | null;
  providerLinkId?: string | null;
  amountMinor?: number | null;
  amountPaidMinor: number;
  currency: string;
  orderId?: string | null;
  contactId?: string | null;
  conversationId?: string | null;
  paidAt?: Date;
}

const s = (v: string | null | undefined, max = 200): string | null => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);
const int = (v: number | null | undefined): number | null => (typeof v === 'number' && Number.isSafeInteger(v) ? v : null);

function money(minor: number | null, currency: string | null): string | null {
  if (minor === null || !currency || !isCurrencyCode(currency)) return null;
  try {
    return formatMoney(minor, currency, 'en');
  } catch {
    return null;
  }
}

/** The `data` object of an order.created / order.paid delivery. */
export function orderWebhookData(input: OrderWebhookInput): Record<string, unknown> {
  const currency = s(input.currency, 3)?.toUpperCase() ?? null;
  const totalMinor = int(input.totalMinor);
  return {
    order_id: s(input.orderId, 64),
    source: s(input.source, 40),
    external_id: s(input.externalId),
    order_number: s(input.orderNumber, 64),
    status: s(input.status, 40),
    total_minor: totalMinor,
    total: money(totalMinor, currency),
    currency,
    item_count: int(input.itemCount),
    contact_id: s(input.contactId, 64),
    conversation_id: s(input.conversationId, 64),
    customer_name: s(input.customerName),
    customer_phone: s(input.customerPhone, 32),
    occurred_at: (input.occurredAt ?? new Date()).toISOString(),
  };
}

/** The `data` object of a payment_link.paid delivery. */
export function paymentLinkWebhookData(input: PaymentLinkPaidInput): Record<string, unknown> {
  const currency = s(input.currency, 3)?.toUpperCase() ?? null;
  const paid = int(input.amountPaidMinor);
  return {
    payment_link_id: s(input.paymentLinkId, 64),
    provider: s(input.provider ?? 'razorpay', 40),
    reference_id: s(input.referenceId, 64),
    provider_link_id: s(input.providerLinkId, 64),
    amount_minor: int(input.amountMinor),
    amount_paid_minor: paid,
    amount_paid: money(paid, currency),
    currency,
    order_id: s(input.orderId, 64),
    contact_id: s(input.contactId, 64),
    conversation_id: s(input.conversationId, 64),
    paid_at: (input.paidAt ?? new Date()).toISOString(),
  };
}

async function emit(accountId: string, event: CommerceWebhookEvent, data: Record<string, unknown>, db?: DataClient): Promise<boolean> {
  try {
    await dispatchWebhookEvent(db ?? createAdminClient({ accountId, role: 'owner' }), accountId, event, data);
    return true;
  } catch (err) {
    console.error('[webhooks] commerce event enqueue failed', { event, error: err instanceof Error ? err.name : 'unknown' });
    return false;
  }
}

export function emitOrderCreated(accountId: string, input: OrderWebhookInput, db?: DataClient): Promise<boolean> {
  return emit(accountId, 'order.created', orderWebhookData(input), db);
}

export function emitOrderPaid(accountId: string, input: OrderWebhookInput, db?: DataClient): Promise<boolean> {
  return emit(accountId, 'order.paid', orderWebhookData(input), db);
}

export function emitPaymentLinkPaid(accountId: string, input: PaymentLinkPaidInput, db?: DataClient): Promise<boolean> {
  return emit(accountId, 'payment_link.paid', paymentLinkWebhookData(input), db);
}
