// Shiprocket status normalisation (Phase 9, design §2 "Normalized set and rank"). Owner: T5.
//
// Pure (no server imports). Shiprocket has two code spaces: a push carries
// current_status_id AND shipment_status_id for the same scan (sample: 20 and 18
// for "IN TRANSIT"); tracking scans carry `sr-status` in the shipment status
// space. We normalise from shipment_status_id / scan sr-status, with the label
// as a fallback.
//
// ASSUMPTION (not confirmed against an official, complete table): the code
// list below is the Shiprocket "shipment status" table as published in their
// API docs and help pages at build time. Anything not listed, and every status
// that is not a clear courier claim (pickup errors, cancellation *requested*,
// partial delivery, self-fulfilled, untraceable), maps to 'unrecognised' and is
// dropped: an unknown code can never move an order. A wrong mapping here can
// only make us claim less, not more, except for the codes listed as delivered
// (7) and dispatched-or-later, which match their labels.
import { TRACKING_STATUSES, type ShipmentExceptionKind, type ShipmentExceptionResolution, type TrackingStatus } from './types';

export const TRACKING_RANK: Readonly<Record<TrackingStatus, number>> = {
  created: 10,
  awb_assigned: 20,
  pickup_scheduled: 25,
  picked_up: 30,
  in_transit: 40,
  out_for_delivery: 50,
  delivery_failed: 50,
  rto_initiated: 60,
  rto_in_transit: 70,
  delivered: 90,
  rto_delivered: 95,
  lost: 98,
  cancelled: 99,
};

export const TERMINAL_TRACKING_STATUSES: ReadonlySet<TrackingStatus> = new Set<TrackingStatus>(['delivered', 'rto_delivered', 'lost', 'cancelled']);

/** Return-to-origin statuses (never a dispatch claim to the customer). */
export const RTO_TRACKING_STATUSES: ReadonlySet<TrackingStatus> = new Set<TrackingStatus>(['rto_initiated', 'rto_in_transit', 'rto_delivered']);

/** Statuses that prove the parcel left the seller towards the customer (dispatch evidence). */
export const DISPATCH_EVIDENCE_STATUSES: ReadonlySet<TrackingStatus> = new Set<TrackingStatus>([
  'picked_up', 'in_transit', 'out_for_delivery', 'delivery_failed', 'delivered',
]);

/** Shiprocket shipment_status_id / sr-status → normalised status (see the assumption above). */
export const SHIPROCKET_CODE_MAP: Readonly<Record<number, TrackingStatus>> = {
  6: 'in_transit', // Shipped
  7: 'delivered', // Delivered
  8: 'cancelled', // Canceled
  9: 'rto_initiated', // RTO Initiated
  10: 'rto_delivered', // RTO Delivered
  12: 'lost', // Lost
  14: 'rto_initiated', // RTO Acknowledged
  15: 'pickup_scheduled', // Pickup Rescheduled
  17: 'out_for_delivery', // Out For Delivery
  18: 'in_transit', // In Transit
  19: 'pickup_scheduled', // Out For Pickup
  21: 'delivery_failed', // Undelivered
  22: 'in_transit', // Delayed
  24: 'lost', // Destroyed
  25: 'lost', // Damaged
  27: 'pickup_scheduled', // Pickup Booked
  38: 'in_transit', // Reached at Destination Hub
  39: 'in_transit', // Misrouted
  40: 'rto_in_transit', // RTO NDR
  41: 'rto_in_transit', // RTO OFD
  42: 'picked_up', // Picked Up
  44: 'lost', // Disposed Off
  45: 'cancelled', // Cancelled before Dispatched
  46: 'rto_in_transit', // RTO In Transit
  48: 'in_transit', // Reached Warehouse
  50: 'in_transit', // In Flight
  51: 'picked_up', // Handover to Courier
  52: 'created', // Shipment Booked
  77: 'delivery_failed', // Issue Related to the Recipient
  78: 'rto_in_transit', // Reached Back at Seller City
};

/** Upper-cased, single-spaced label → normalised status (fallback when the code is missing or unknown). */
const LABEL_MAP: Readonly<Record<string, TrackingStatus>> = {
  'NEW': 'created',
  'SHIPMENT BOOKED': 'created',
  'AWB ASSIGNED': 'awb_assigned',
  'LABEL GENERATED': 'awb_assigned',
  'PICKUP SCHEDULED': 'pickup_scheduled',
  'PICKUP GENERATED': 'pickup_scheduled',
  'PICKUP QUEUED': 'pickup_scheduled',
  'PICKUP BOOKED': 'pickup_scheduled',
  'PICKUP RESCHEDULED': 'pickup_scheduled',
  'OUT FOR PICKUP': 'pickup_scheduled',
  'PICKED UP': 'picked_up',
  'HANDOVER TO COURIER': 'picked_up',
  'SHIPPED': 'in_transit',
  'IN TRANSIT': 'in_transit',
  'DELAYED': 'in_transit',
  'MISROUTED': 'in_transit',
  'REACHED AT DESTINATION HUB': 'in_transit',
  'REACHED WAREHOUSE': 'in_transit',
  'IN FLIGHT': 'in_transit',
  'OUT FOR DELIVERY': 'out_for_delivery',
  'UNDELIVERED': 'delivery_failed',
  'DELIVERED': 'delivered',
  'CANCELED': 'cancelled',
  'CANCELLED': 'cancelled',
  'RTO INITIATED': 'rto_initiated',
  'RTO ACKNOWLEDGED': 'rto_initiated',
  'RTO IN TRANSIT': 'rto_in_transit',
  'RTO IN INTRANSIT': 'rto_in_transit',
  'RTO NDR': 'rto_in_transit',
  'RTO OFD': 'rto_in_transit',
  'RTO DELIVERED': 'rto_delivered',
  'LOST': 'lost',
  'DAMAGED': 'lost',
  'DESTROYED': 'lost',
  'DISPOSED OFF': 'lost',
};

function codeOf(code: number | string | null | undefined): number | null {
  if (typeof code === 'number') return Number.isSafeInteger(code) ? code : null;
  if (typeof code === 'string' && /^\s*\d{1,4}\s*$/.test(code)) return Number(code.trim());
  return null;
}

function labelKey(label: string): string {
  return label.normalize('NFKC').replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim().toUpperCase();
}

/** From shipment_status_id / scan sr-status, the label as a fallback; 'unrecognised' when neither maps. */
export function normalizeShiprocket(code: number | string | null | undefined, label: string | null | undefined): TrackingStatus | 'unrecognised' {
  const n = codeOf(code);
  if (n !== null && Object.prototype.hasOwnProperty.call(SHIPROCKET_CODE_MAP, n)) return SHIPROCKET_CODE_MAP[n];
  if (typeof label === 'string' && label.length <= 80) {
    const key = labelKey(label);
    if (Object.prototype.hasOwnProperty.call(LABEL_MAP, key)) return LABEL_MAP[key];
  }
  return 'unrecognised';
}

const IST_OFFSET_MS = (5 * 60 + 30) * 60_000;
const DMY = /^(\d{2})[ /-](\d{2})[ /-](\d{4})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/;
const YMD = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/;

/** Both Shiprocket formats (`DD MM YYYY HH:mm:ss`, `YYYY-MM-DD HH:mm:ss`), read as Asia/Kolkata (no DST). */
export function parseShiprocketTime(value: string | null | undefined): Date | null {
  if (typeof value !== 'string' || value.length > 40) return null;
  const text = value.trim();
  let parts: [number, number, number, number, number, number] | null = null;
  const dmy = DMY.exec(text);
  if (dmy) parts = [Number(dmy[3]), Number(dmy[2]), Number(dmy[1]), Number(dmy[4]), Number(dmy[5]), Number(dmy[6] ?? 0)];
  const ymd = dmy ? null : YMD.exec(text);
  if (ymd) parts = [Number(ymd[1]), Number(ymd[2]), Number(ymd[3]), Number(ymd[4]), Number(ymd[5]), Number(ymd[6] ?? 0)];
  if (!parts) return null;
  const [y, mo, d, h, mi, s] = parts;
  if (y < 2000 || y > 2100 || mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59 || s > 59) return null;
  const utc = Date.UTC(y, mo - 1, d, h, mi, s);
  const check = new Date(utc);
  // Rejects impossible dates (31 Feb) that Date.UTC would roll over.
  if (check.getUTCFullYear() !== y || check.getUTCMonth() !== mo - 1 || check.getUTCDate() !== d) return null;
  return new Date(utc - IST_OFFSET_MS);
}

export function isTrackingStatus(value: unknown): value is TrackingStatus {
  return typeof value === 'string' && (TRACKING_STATUSES as readonly string[]).includes(value);
}

/** The resolutions an admin may pick for each kind. */
export function resolutionsFor(kind: ShipmentExceptionKind): readonly ShipmentExceptionResolution[] {
  if (kind === 'contradiction') return ['accept_correction', 'dismiss', 'manual'];
  // lost_or_damaged: after confirming with the courier, the admin frees the order's shipment slot to send again.
  if (kind === 'create_unknown' || kind === 'awb_unknown' || kind === 'lost_or_damaged') return ['recreate', 'dismiss', 'manual'];
  return ['dismiss', 'manual'];
}
