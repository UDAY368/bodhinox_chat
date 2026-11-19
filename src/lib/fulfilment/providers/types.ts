// Courier provider interface (store Phase 5, more couriers). Pure types: no server-only imports.
//
// shipments.ts, tracking-job.ts and the sweep talk to a courier only through CourierProvider, picked from the
// shipment row's `provider` column. Shiprocket is wrapped without changing what it sends (providers/shiprocket.ts);
// Delhivery and Shipway are NOT TESTED AGAINST THE LIVE API YET (providers/delhivery.ts, providers/shipway.ts).
import type { TrackingEvent } from '../derive-tracking';

export const COURIER_PROVIDER_IDS = ['shiprocket', 'delhivery', 'shipway'] as const;
export type CourierProviderId = (typeof COURIER_PROVIDER_IDS)[number];
/** The providers whose credentials are managed by the generic connection routes (Shiprocket has its own). */
export const SECRET_COURIER_IDS = ['delhivery', 'shipway'] as const;
export type SecretCourierId = (typeof SECRET_COURIER_IDS)[number];

export const isCourierProviderId = (v: unknown): v is CourierProviderId => typeof v === 'string' && (COURIER_PROVIDER_IDS as readonly string[]).includes(v);
export const isSecretCourierId = (v: unknown): v is SecretCourierId => typeof v === 'string' && (SECRET_COURIER_IDS as readonly string[]).includes(v);

/**
 * rejected: a definite 4xx; unknown: 5xx, timeout or network (outcome ambiguous); auth: 401/403; throttled: 429;
 * unavailable: a login step failed ambiguously, so the business request was never sent (retry later).
 */
export type CourierErrorKind = 'rejected' | 'unknown' | 'auth' | 'throttled' | 'unavailable';

/** A provider failure. Carries a kind and a log-safe code only, never a provider message, secret or address. */
export class CourierError extends Error {
  constructor(
    readonly kind: CourierErrorKind,
    readonly status: number | null,
    readonly code: string | null,
    prefix = 'courier',
  ) {
    super(`${prefix}_${kind}`);
    this.name = 'CourierError';
  }
}

/** The order handed to a courier, in plain units (rupees, kg, cm). Each adapter maps it to its own wire format. */
export interface CourierOrderInput {
  reference: string;
  orderDate: string; // Asia/Kolkata `YYYY-MM-DD HH:mm`
  pickup: string;
  customer: {
    name: string; firstName: string; lastName: string; line1: string; line2: string | null; city: string; state: string;
    postalCode: string; phone: string; email: string;
  };
  items: { name: string; sku: string; units: number; sellingPrice: number; discount: number; tax: number; hsn: string | null }[];
  cod: boolean;
  /** Rupees. For COD this is what the courier collects. */
  total: number;
  shippingCharges: number;
  totalDiscount: number;
  subTotal: number;
  lengthCm: number;
  breadthCm: number;
  heightCm: number;
  weightKg: number;
}

/** The provider ids kept on the shipment row (numeric for Shiprocket; Delhivery keeps the waybill, Shipway our reference). */
export interface ShipmentRef {
  reference: string;
  srOrderId: string | null;
  srShipmentId: string | null;
  awb: string | null;
}

export interface FoundOrder {
  srOrderId: string;
  srShipmentId: string | null;
  awb: string | null;
  courier: string | null;
}

export type AwbOutcome = { kind: 'assigned'; awb: string; courier: string | null } | { kind: 'refused' };

export interface CourierCredentialsInput {
  /** Shiprocket: API email. Delhivery: client / account name. Shipway: username. */
  label: string;
  /** Shiprocket: password. Delhivery: API token. Shipway: license key. */
  secret: string;
}

export interface CourierProvider {
  readonly id: CourierProviderId;
  readonly name: string;
  /** false for the two adapters written from public docs only. */
  readonly testedLive: boolean;
  /** Whether the connection needs a pickup location / warehouse name (Shipway books the carrier itself). */
  readonly requiresPickup: boolean;
  /** The deployment kill switch (SHIPROCKET_DISABLED, DELHIVERY_DISABLED, SHIPWAY_DISABLED = "true"). */
  disabled(): boolean;
  /** Checks the credentials with the courier (nothing saved). Returns pickup / warehouse names when the courier lists them. */
  testConnection(credentials: CourierCredentialsInput): Promise<{ pickupLocations: string[] }>;
  /** Creates the order at the courier. null: a 2xx that did not carry what we need (treated as ambiguous, then reconciled). */
  create(accountId: string, input: CourierOrderInput): Promise<{ srOrderId: string; srShipmentId: string } | null>;
  /** Assigns the AWB. Never repeated after an ambiguous outcome (it may spend money). null: unclear. */
  assignAwb(accountId: string, ref: ShipmentRef): Promise<AwbOutcome | null>;
  findByReference(accountId: string, reference: string): Promise<FoundOrder | null>;
  showOrder(accountId: string, ref: ShipmentRef): Promise<FoundOrder | null>;
  cancel(accountId: string, ref: ShipmentRef): Promise<void>;
  /** A short-lived https label URL, or null when the courier did not return one. */
  labelUrl(accountId: string, ref: ShipmentRef): Promise<string | null>;
  requestPickup(accountId: string, ref: ShipmentRef): Promise<void>;
  /** Normalised scans (status, provider code, time only). */
  track(accountId: string, ref: { awb: string }): Promise<TrackingEvent[]>;
}

/** An injectable fetch for adapter unit tests. */
export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;
