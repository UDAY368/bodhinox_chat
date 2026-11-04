/**
 * Phase 9 courier contracts (design §1-§2). Pure: no server-only imports.
 * The CHECK lists in prisma/migrations/20261108100500_courier_shipping mirror
 * these unions.
 */
import type { TenantContext } from '@/lib/db/tenant';

export const COURIER_PROVIDERS = ['shiprocket'] as const;
export type CourierProvider = (typeof COURIER_PROVIDERS)[number];

export const COURIER_CONNECTION_STATUSES = ['active', 'token_invalid', 'disconnected'] as const;
export type CourierConnectionStatus = (typeof COURIER_CONNECTION_STATUSES)[number];

export const SHIPMENT_CREATE_STATES = ['creating', 'created', 'unknown', 'failed', 'cancelled'] as const;
export type ShipmentCreateState = (typeof SHIPMENT_CREATE_STATES)[number];
export const SHIPMENT_AWB_STATES = ['none', 'assigning', 'assigned', 'unknown', 'failed'] as const;
export type ShipmentAwbState = (typeof SHIPMENT_AWB_STATES)[number];

/** Normalised tracking statuses (rank and terminality live in status-map.ts). */
export const TRACKING_STATUSES = [
  'created', 'awb_assigned', 'pickup_scheduled', 'picked_up', 'in_transit', 'out_for_delivery', 'delivery_failed',
  'rto_initiated', 'rto_in_transit', 'delivered', 'lost', 'rto_delivered', 'cancelled',
] as const;
export type TrackingStatus = (typeof TRACKING_STATUSES)[number];

export const TRACKING_EVENT_SOURCES = ['refetch', 'poll', 'create'] as const;
export type TrackingEventSource = (typeof TRACKING_EVENT_SOURCES)[number];

export const SHIPMENT_EXCEPTION_KINDS = [
  'contradiction', 'create_unknown', 'awb_unknown', 'rto', 'lost_or_damaged', 'stale_tracking', 'order_conflict',
] as const;
export type ShipmentExceptionKind = (typeof SHIPMENT_EXCEPTION_KINDS)[number];
export const SHIPMENT_EXCEPTION_RESOLUTIONS = ['accept_correction', 'dismiss', 'recreate', 'manual'] as const;
export type ShipmentExceptionResolution = (typeof SHIPMENT_EXCEPTION_RESOLUTIONS)[number];

export const ORDER_NOTICE_TEMPLATE_KINDS = ['dispatched', 'delivered', 'feedback', 'repeat_purchase'] as const;
export type OrderNoticeTemplateKind = (typeof ORDER_NOTICE_TEMPLATE_KINDS)[number];

/** Job types (routed by src/lib/jobs/handlers.ts). */
export const CREATE_SHIPMENT_JOB = 'commerce.create_shipment';
export const SHIPMENT_TRACK_JOB = 'commerce.shipment_track';
export const FULFILMENT_SWEEP_JOB = 'fulfilment.sweep';

export interface ShipmentJobPayload {
  shipmentId: string;
}
export interface FulfilmentJobMeta {
  attempts: number;
  maxAttempts: number;
}

/** A signed-in member acting through a fulfilment service (route checked role and permission). */
export type FulfilmentActor = TenantContext & { userId: string };

/** Package dimensions and weight for a shipment (cm, grams). */
export interface ShipmentDims {
  length_cm: number;
  breadth_cm: number;
  height_cm: number;
  weight_grams: number;
}

/** Code-only refusals; the UI translates them (Validation.shipments.*). */
export const SHIPMENT_ERROR_CODES = [
  'not_connected', 'not_configured', 'auth', 'provider_unreachable', 'order_not_paid', 'shipment_exists',
  'refund_in_flight', 'shipment_live', 'address_incomplete', 'wrong_category', 'not_found', 'conflict', 'invalid',
  'throttled', 'feature_unavailable', 'not_implemented',
] as const;
export type ShipmentErrorCode = (typeof SHIPMENT_ERROR_CODES)[number];

const STATUS: Record<ShipmentErrorCode, number> = {
  not_connected: 503,
  not_configured: 503,
  auth: 400,
  provider_unreachable: 502,
  order_not_paid: 409,
  shipment_exists: 409,
  refund_in_flight: 409,
  shipment_live: 409,
  address_incomplete: 409,
  wrong_category: 422,
  not_found: 404,
  conflict: 409,
  invalid: 400,
  throttled: 429,
  feature_unavailable: 402,
  not_implemented: 501,
};

export class ShipmentError extends Error {
  readonly status: number;
  constructor(readonly code: ShipmentErrorCode) {
    super(code);
    this.name = 'ShipmentError';
    this.status = STATUS[code];
  }
}

/** The app-readable shipment row (no claim token). */
export interface OrderShipmentView {
  id: string;
  order_id: string;
  reference: string;
  create_state: ShipmentCreateState;
  awb_state: ShipmentAwbState;
  awb: string | null;
  courier_name: string | null;
  tracking_status: TrackingStatus | null;
  tracking_rank: number | null;
  tracking_event_at: string | null;
  provider_dispatched_at: string | null;
  provider_delivered_at: string | null;
  last_error_code: string | null;
  length_cm: number;
  breadth_cm: number;
  height_cm: number;
  weight_grams: number;
  created_at: string;
}

/** The public view of a workspace's Shiprocket connection (never a secret or the webhook token). */
export interface CourierConnectionDto {
  connected: boolean;
  status: CourierConnectionStatus | null;
  api_email: string | null;
  pickup_location: string | null;
  default_length_cm: number | null;
  default_breadth_cm: number | null;
  default_height_cm: number | null;
  default_weight_grams: number | null;
  last_error_code: string | null;
  connected_at: string | null;
  webhook_token_set: boolean;
  /** The tracking webhook URL to paste into Shiprocket (/api/fulfilment/tracking/<accountId>). */
  webhook_url: string | null;
}

/**
 * The customer-facing tracking page for a Shiprocket AWB, or null for a value
 * that is not an AWB. The one place this URL form is defined (server notices,
 * shipment card). Assumption (not confirmed in Shiprocket's API docs): the
 * public page is https://shiprocket.co/tracking/<awb>.
 */
export function shipmentTrackingUrl(awb: string | null | undefined): string | null {
  return typeof awb === 'string' && /^[A-Za-z0-9-]{4,40}$/.test(awb) ? `https://shiprocket.co/tracking/${awb}` : null;
}
