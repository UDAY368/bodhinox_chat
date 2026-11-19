import type { TenantTransaction } from '@/lib/db/tenant';
import { orderWebhookData, paymentLinkWebhookData } from '@/lib/webhooks/commerce-events';
import { getAppointment } from '@/lib/appointments/booking';
import { eventSnapshot } from '@/lib/appointments/events';
import type { AppointmentEventKind } from '@/lib/appointments/types';
import { appointmentWebhookData } from '@/lib/webhooks/appointment-events';
import type { DomainEventRow } from './store';

/**
 * The `data` object an outbound webhook carries for a domain event (built when the event is
 * dispatched, from the rows as they are then; the event itself stores ids only).
 *
 * order.created / order.paid keep the shape receivers already parse (orderWebhookData),
 * including the customer's name and phone, which endpoints were already given before the
 * feed. Every other event sends its stored ids and amounts plus contact_id.
 */
export async function webhookDataForEvent(tx: TenantTransaction, event: DomainEventRow): Promise<Record<string, unknown> | null> {
  const base = { ...event.data, contact_id: event.contact_id, occurred_at: event.occurred_at.toISOString() };
  if (event.subject_kind === 'order') {
    const [order] = await tx.$queryRaw<{
      id: string; source: string; external_id: string | null; status: string; total_minor: bigint | null;
      currency: string; contact_id: string | null; conversation_id: string | null; item_count: number;
      customer_name: string | null; customer_phone: string | null;
    }[]>`
      SELECT o.id::text AS id, o.source, o.external_id, o.status, COALESCE(o.total_minor, o.subtotal_minor) AS total_minor,
        o.currency, o.contact_id::text AS contact_id, o.conversation_id::text AS conversation_id,
        (SELECT COALESCE(sum(i.quantity),0)::int FROM order_items i WHERE i.account_id=o.account_id AND i.order_id=o.id) AS item_count,
        c.name AS customer_name, c.phone AS customer_phone
      FROM orders o LEFT JOIN contacts c ON c.account_id=o.account_id AND c.id=o.contact_id
      WHERE o.account_id=${event.account_id}::uuid AND o.id=${event.subject_id}::uuid`;
    if (!order) return null;
    return {
      ...orderWebhookData({
        orderId: order.id,
        // The vocabulary receivers saw before the feed: a WhatsApp cart order was 'whatsapp_cart'.
        source: order.source === 'whatsapp' ? 'whatsapp_cart' : order.source,
        externalId: order.external_id, status: String(event.data.status ?? order.status),
        totalMinor: order.total_minor === null ? null : Number(order.total_minor), currency: order.currency,
        itemCount: order.item_count, contactId: order.contact_id, conversationId: order.conversation_id,
        customerName: order.customer_name, customerPhone: order.customer_phone, occurredAt: event.occurred_at,
      }),
      ...(event.data.from_status ? { from_status: event.data.from_status } : {}),
    };
  }
  if (event.subject_kind === 'appointment') {
    const kind = APPOINTMENT_KIND[event.type];
    const current = kind ? await getAppointment(tx, event.account_id, event.subject_id) : null;
    if (!kind || !current) return null;
    const version = typeof event.data.version === 'number' ? event.data.version : current.version;
    const start = typeof event.data.start_at === 'string' ? new Date(event.data.start_at) : null;
    const previous = typeof event.data.previous_start_at === 'string' ? new Date(event.data.previous_start_at) : null;
    // The shape appointment.* receivers always got, as of the event's own version.
    return appointmentWebhookData(eventSnapshot(current, version, kind, start),
      kind === 'rescheduled' ? { previousStartAt: previous } : {});
  }
  return base;
}

const APPOINTMENT_KIND: Partial<Record<DomainEventRow['type'], AppointmentEventKind>> = {
  'appointment.booked': 'confirmed', 'appointment.rescheduled': 'rescheduled', 'appointment.cancelled': 'cancelled',
  'appointment.completed': 'completed', 'appointment.no_show': 'no_show',
};

/** payment_link.paid for a captured payment whose link is now paid in full, else null. */
export async function paymentLinkPaidData(tx: TenantTransaction, event: DomainEventRow): Promise<Record<string, unknown> | null> {
  if (event.type !== 'payment.received' || typeof event.data.payment_link_id !== 'string') return null;
  const [link] = await tx.$queryRaw<{
    id: string; provider: string; reference_id: string; provider_link_id: string | null; amount_minor: bigint;
    currency: string; order_id: string | null; contact_id: string | null; conversation_id: string | null;
    paid_at: Date | null; paid_minor: bigint;
  }[]>`
    SELECT l.id::text AS id, l.provider, l.reference_id, l.provider_link_id, l.amount_minor, l.currency,
      l.order_id::text AS order_id, l.contact_id::text AS contact_id, l.conversation_id::text AS conversation_id, l.paid_at,
      (SELECT COALESCE(sum(p.amount_minor),0) FROM customer_payments p
        WHERE p.account_id=l.account_id AND p.payment_link_id=l.id AND p.status='captured') AS paid_minor
    FROM payment_links l
    WHERE l.account_id=${event.account_id}::uuid AND l.id=${event.data.payment_link_id}::uuid AND l.status='paid'`;
  if (!link) return null;
  return paymentLinkWebhookData({
    paymentLinkId: link.id, provider: link.provider, referenceId: link.reference_id, providerLinkId: link.provider_link_id,
    amountMinor: Number(link.amount_minor), amountPaidMinor: Number(link.paid_minor), currency: link.currency,
    orderId: link.order_id, contactId: link.contact_id, conversationId: link.conversation_id, paidAt: link.paid_at ?? event.occurred_at,
  });
}
