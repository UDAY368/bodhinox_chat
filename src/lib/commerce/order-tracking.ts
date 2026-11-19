/**
 * The public order tracking page's data (store plan Phase 5) and the link we
 * hand to the buyer. The token (./order-tracking-token) names the workspace
 * and the order; the page's shop handle must belong to that same workspace, so
 * a link opened under another shop is the plain 404. The view carries no phone
 * number, street address, internal id, note or payment detail: the order
 * code, status, timeline, item names, totals, the city and pincode, and the
 * courier's name, AWB and tracking link.
 */
import type { TrackingStatus } from '@/lib/fulfilment/types';
import { shipmentTrackingUrl } from '@/lib/fulfilment/types';
import { withTenant, type TenantTransaction } from '@/lib/db/tenant';
import { appOrigin } from '@/lib/auth/csrf';
import { getWorkerPrisma } from '@/lib/db/prisma';
import { buildOrderTimeline, type TimelineStep } from './order-tracking-timeline';
import { orderTrackingPathTx } from './order-tracking-link';
import { readOrderTrackingToken } from './order-tracking-token';
import { minorFromDb } from './money';
import { withPublicShop } from './public-shop';
import { orderReference } from './storefront';

export interface OrderTrackingView {
  reference: string;
  status: string;
  currency: string;
  placedAt: string;
  timeline: TimelineStep[];
  items: Array<{ name: string; quantity: number }>;
  subtotalMinor: number;
  discountMinor: number;
  shippingMinor: number;
  codFeeMinor: number;
  taxMinor: number;
  totalMinor: number | null;
  paymentMethod: string;
  /** City and pincode only. */
  deliveryTo: { city: string | null; postalCode: string | null } | null;
  shipment: { courierName: string | null; awb: string; trackingUrl: string | null } | null;
}

const clip = (value: unknown, max: number): string | null =>
  typeof value === 'string' && value.trim() ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max) : null;

export async function loadOrderTrackingTx(tx: TenantTransaction, accountId: string, orderId: string): Promise<OrderTrackingView | null> {
  const order = await tx.orders.findFirst({
    where: { account_id: accountId, id: orderId },
    select: {
      id: true, status: true, currency: true, created_at: true, subtotal_minor: true, discount_minor: true, shipping_minor: true,
      cod_fee_minor: true, tax_minor: true, total_minor: true, payment_method: true, dispatched_at: true, delivered_at: true, shipping_address: true,
    },
  });
  if (!order) return null;
  const items = await tx.order_items.findMany({
    where: { account_id: accountId, order_id: orderId }, select: { name: true, quantity: true }, orderBy: { id: 'asc' }, take: 100,
  });
  const live = await tx.$queryRaw<{ id: string; awb: string | null; courier_name: string | null; tracking_status: string | null;
    provider_dispatched_at: Date | null; provider_delivered_at: Date | null }[]>`
    SELECT id::text AS id, awb, courier_name, tracking_status, provider_dispatched_at, provider_delivered_at FROM order_shipments
    WHERE account_id=${accountId}::uuid AND order_id=${orderId}::uuid AND create_state NOT IN ('failed','cancelled')
    ORDER BY created_at DESC LIMIT 2`;
  const shipment = live[0];
  // Several parcels (split shipments): the order status alone drives the timeline; the newest parcel's link is still shown.
  const single = live.length === 1;
  const [outForDelivery] = shipment ? await tx.$queryRaw<{ at: Date }[]>`
    SELECT min(event_at) AS at FROM shipment_tracking_events
    WHERE account_id=${accountId}::uuid AND shipment_id=${shipment.id}::uuid AND status='out_for_delivery'` : [];
  const address = order.shipping_address && typeof order.shipping_address === 'object' && !Array.isArray(order.shipping_address)
    ? order.shipping_address as Record<string, unknown> : null;
  return {
    reference: orderReference(order.id), status: order.status, currency: order.currency, placedAt: order.created_at.toISOString(),
    timeline: buildOrderTimeline({
      status: order.status, createdAt: order.created_at, dispatchedAt: order.dispatched_at, deliveredAt: order.delivered_at,
      shipmentStatus: single ? (shipment?.tracking_status as TrackingStatus | null | undefined) ?? null : null,
      shipmentDispatchedAt: single ? shipment?.provider_dispatched_at : null, shipmentDeliveredAt: single ? shipment?.provider_delivered_at : null,
      outForDeliveryAt: single ? outForDelivery?.at ?? null : null,
    }),
    items: items.map((i) => ({ name: clip(i.name, 200) ?? '-', quantity: i.quantity })),
    subtotalMinor: minorFromDb(order.subtotal_minor) ?? 0, discountMinor: minorFromDb(order.discount_minor) ?? 0,
    shippingMinor: minorFromDb(order.shipping_minor) ?? 0, codFeeMinor: minorFromDb(order.cod_fee_minor) ?? 0,
    taxMinor: minorFromDb(order.tax_minor) ?? 0, totalMinor: minorFromDb(order.total_minor), paymentMethod: order.payment_method,
    deliveryTo: address ? { city: clip(address.city, 100), postalCode: clip(address.postal_code, 12) } : null,
    shipment: shipment?.awb ? { courierName: clip(shipment.courier_name, 100), awb: shipment.awb, trackingUrl: shipmentTrackingUrl(shipment.awb) } : null,
  };
}

/** The page's data: null (a plain 404) for a bad token, another shop's token, a missing order or a hidden shop. */
export async function loadOrderTracking(handle: string, token: string): Promise<OrderTrackingView | null> {
  const ids = readOrderTrackingToken(token);
  if (!ids) return null;
  return withPublicShop(handle, (tx, accountId) => (accountId === ids.accountId ? loadOrderTrackingTx(tx, accountId, ids.orderId) : Promise.resolve(null)));
}

/** The absolute tracking link for a message ('' when the workspace has no published shop). */
export async function orderTrackingLink(accountId: string, orderId: string): Promise<string> {
  const path = await withTenant({ accountId, role: 'owner' }, (tx) => orderTrackingPathTx(tx, accountId, orderId), getWorkerPrisma());
  return path ? `${appOrigin()}${path}` : '';
}
