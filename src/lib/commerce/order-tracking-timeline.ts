/**
 * The buyer's order timeline (store plan Phase 5): placed, confirmed, shipped,
 * out for delivery, delivered, or placed then cancelled. Pure: no database, no
 * server imports. It reads the order status first and only adds what the
 * courier's tracking status (src/lib/fulfilment/status-map.ts) proves.
 */
import { DISPATCH_EVIDENCE_STATUSES } from '../fulfilment/status-map';
import type { TrackingStatus } from '../fulfilment/types';

export type TimelineStepKey = 'placed' | 'confirmed' | 'shipped' | 'out_for_delivery' | 'delivered' | 'cancelled';
export type TimelineStepState = 'done' | 'current' | 'upcoming';
export interface TimelineStep { key: TimelineStepKey; state: TimelineStepState; at: string | null }

export interface TimelineInput {
  /** orders.status */
  status: string;
  createdAt: Date;
  dispatchedAt?: Date | null;
  deliveredAt?: Date | null;
  /**
   * The order's one live shipment's normalised tracking status, if any. Leave it out for an order with
   * several parcels: one parcel's delivery says nothing about the others, so the order status decides.
   */
  shipmentStatus?: TrackingStatus | null;
  shipmentDispatchedAt?: Date | null;
  shipmentDeliveredAt?: Date | null;
  /** When the courier first said out for delivery. */
  outForDeliveryAt?: Date | null;
}

const CONFIRMED = new Set(['confirmed', 'paid', 'partially_shipped', 'dispatched', 'fulfilled']);
const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);

export function buildOrderTimeline(input: TimelineInput): TimelineStep[] {
  if (input.status === 'cancelled' || input.status === 'expired')
    return [{ key: 'placed', state: 'done', at: iso(input.createdAt) }, { key: 'cancelled', state: 'current', at: null }];

  // Partially shipped: some parcels left, so the order is shipped; no single parcel may mark it delivered.
  const partial = input.status === 'partially_shipped';
  const courier = partial ? null : input.shipmentStatus ?? null;
  const delivered = input.status === 'fulfilled' || courier === 'delivered';
  const outForDelivery = delivered || courier === 'out_for_delivery' || courier === 'delivery_failed';
  const shipped = outForDelivery || partial || input.status === 'dispatched' || (courier !== null && DISPATCH_EVIDENCE_STATUSES.has(courier));
  const confirmed = shipped || CONFIRMED.has(input.status);

  const reached: Array<[TimelineStepKey, boolean, string | null]> = [
    ['placed', true, iso(input.createdAt)],
    ['confirmed', confirmed, null],
    ['shipped', shipped, iso(input.dispatchedAt ?? input.shipmentDispatchedAt)],
    ['out_for_delivery', outForDelivery, iso(input.outForDeliveryAt)],
    ['delivered', delivered, iso(input.deliveredAt ?? input.shipmentDeliveredAt)],
  ];
  const last = reached.reduce((n, [, ok], i) => (ok ? i : n), 0);
  return reached.map(([key, ok, at], i) => ({
    key, at: ok ? at : null,
    state: i < last || (i === last && key === 'delivered') ? 'done' : i === last ? 'current' : 'upcoming',
  }));
}
