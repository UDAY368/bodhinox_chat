// Shipway as a CourierProvider (store Phase 5, more couriers).
//
// NOT TESTED AGAINST THE LIVE SHIPWAY API YET. Written from Shipway's public API documentation; every path, field
// name and response shape below is an assumption until a real account has run it. Responses are parsed defensively:
// anything unexpected is "unclear" (reconciled or surfaced), never "success".
//
//   auth      username + license key: sent as HTTP Basic and, as Shipway's JSON bodies expect, as username/password fields
//   test      POST https://shipway.in/api/authenticateUser
//   push      POST https://shipway.in/api/PushOrderData          (our reference is the Shipway order_id)
//   track     POST https://shipway.in/api/getOrderShipmentDetails (by order_id; carries the AWB once Shipway assigned a carrier)
//
// Shipway assigns the carrier and AWB on its side after a push, so assignAwb only looks the AWB up: while there is
// none yet the answer is "unclear" and the shipment is reconciled later (the create job retries, then the sweep).
// The shipment row keeps our reference as sr_order_id and sr_shipment_id. Cancel and label are not wired (Shipway's
// panel does them) and answer not_implemented; a pickup request is a no-op (the carrier is booked in Shipway).
import { leaseFetch } from '@/lib/jobs/lease';
import type { TrackingEvent } from '../derive-tracking';
import { parseShiprocketTime } from '../status-map';
import { ShipmentError, type TrackingStatus } from '../types';
import type { ProviderDeps, ProviderSecrets } from './delhivery';
import { courierRequest, isObject, slug } from './http';
import { CourierError, type CourierOrderInput, type CourierProvider, type FoundOrder } from './types';

export const SHIPWAY_API_BASE = 'https://shipway.in/api';
const AWB = /^[A-Za-z0-9-]{4,40}$/;
const MAX_SCANS = 500;
const PREFIX = 'shipway';

export const shipwayDisabled = (env: Record<string, string | undefined> = process.env): boolean => env.SHIPWAY_DISABLED?.trim() === 'true';

const basic = (username: string, key: string): string => `Basic ${Buffer.from(`${username}:${key}`, 'utf8').toString('base64')}`;

// ---------------------------------------------------------------- status mapping

const LABELS: Readonly<Record<string, TrackingStatus>> = {
  'ORDER PLACED': 'created', 'PENDING': 'created', 'NEW': 'created', 'AWB ASSIGNED': 'awb_assigned', 'AWB GENERATED': 'awb_assigned',
  'PICKUP PENDING': 'pickup_scheduled', 'PENDING PICKUP': 'pickup_scheduled', 'PICKUP SCHEDULED': 'pickup_scheduled',
  'OUT FOR PICKUP': 'pickup_scheduled', 'PICKED UP': 'picked_up', 'PICKUP DONE': 'picked_up', 'SHIPPED': 'in_transit',
  'IN TRANSIT': 'in_transit', 'INTRANSIT': 'in_transit', 'REACHED AT DESTINATION': 'in_transit', 'OUT FOR DELIVERY': 'out_for_delivery',
  'DELIVERED': 'delivered', 'UNDELIVERED': 'delivery_failed', 'DELIVERY FAILED': 'delivery_failed', 'NDR': 'delivery_failed',
  'RTO INITIATED': 'rto_initiated', 'RTO IN TRANSIT': 'rto_in_transit', 'RTO INTRANSIT': 'rto_in_transit',
  'RTO DELIVERED': 'rto_delivered', 'RETURNED': 'rto_delivered', 'CANCELLED': 'cancelled', 'CANCELED': 'cancelled',
  'LOST': 'lost', 'DAMAGED': 'lost',
};

/** Shipway's status label -> normalised status; 'unrecognised' (dropped) for anything else. */
export function normalizeShipway(label: unknown): TrackingStatus | 'unrecognised' {
  if (typeof label !== 'string' || label.length > 80) return 'unrecognised';
  const key = label.normalize('NFKC').replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim().toUpperCase();
  return Object.prototype.hasOwnProperty.call(LABELS, key) ? LABELS[key] : 'unrecognised';
}

function eventOf(label: unknown, at: unknown): TrackingEvent | null {
  const status = normalizeShipway(label);
  if (status === 'unrecognised' || typeof at !== 'string') return null;
  const eventAt = parseShiprocketTime(at.trim().replace(/\.\d+$/, '').replace(/Z$/, ''));
  const code = slug(label, 40);
  return eventAt && code ? { status, providerCode: code, eventAt } : null;
}

function detail(body: unknown): Record<string, unknown> | null {
  if (!isObject(body)) return null;
  if (typeof body.status === 'string' && /^(error|fail)/i.test(body.status)) return null;
  const r = body.response ?? body.data ?? body;
  const one = Array.isArray(r) ? r[0] : r;
  return isObject(one) ? one : null;
}

/** The normalised scans of a getOrderShipmentDetails body (status, provider code and time only). */
export function parseShipwayTracking(body: unknown): TrackingEvent[] {
  const d = detail(body);
  if (!d) return [];
  const list = [d.scan, d.scans, d.tracking, d.shipment_track].find((v) => Array.isArray(v)) as unknown[] | undefined;
  const events: TrackingEvent[] = [];
  for (const entry of (list ?? []).slice(0, MAX_SCANS)) {
    if (!isObject(entry)) continue;
    const event = eventOf(entry.status ?? entry.activity ?? entry.current_status, entry.time ?? entry.date ?? entry.timestamp ?? entry.datetime);
    if (event) events.push(event);
  }
  const current = eventOf(d.current_status ?? d.shipment_status, d.status_time ?? d.last_update ?? d.updated_at);
  if (current) events.push(current);
  return events;
}

/** The AWB and carrier of an order from a getOrderShipmentDetails body, or null when it is unknown or has no AWB yet. */
export function parseShipwayFound(body: unknown, reference: string): FoundOrder | null {
  const d = detail(body);
  if (!d) return null;
  const raw = d.awbno ?? d.awb ?? d.awb_number;
  const awb = typeof raw === 'string' || typeof raw === 'number' ? String(raw).trim() : '';
  const carrier = d.carrier_title ?? d.carrier ?? d.courier;
  return {
    srOrderId: reference, srShipmentId: reference, awb: AWB.test(awb) ? awb : null,
    courier: typeof carrier === 'string' && carrier.trim() ? carrier.trim().slice(0, 80) : null,
  };
}

/** The PushOrderData body for a neutral order. */
export function toShipwayOrder(input: CourierOrderInput, username: string, key: string) {
  const c = input.customer;
  return {
    username, password: key,
    order_id: input.reference,
    order_date: input.orderDate,
    first_name: c.firstName,
    last_name: c.lastName,
    address: [c.line1, c.line2].filter(Boolean).join(', '),
    city: c.city,
    state: c.state,
    country: 'India',
    zipcode: c.postalCode,
    phone: c.phone,
    email: c.email,
    payment_type: input.cod ? 'C' : 'P',
    order_total: input.total,
    shipping_charges: input.shippingCharges,
    discount: input.totalDiscount,
    weight: Math.round(input.weightKg * 1000),
    box_length: input.lengthCm,
    box_breadth: input.breadthCm,
    box_height: input.heightCm,
    products: input.items.map((i) => ({ product: i.name, price: i.sellingPrice, quantity: i.units, sku: i.sku })),
  };
}

/** ok: Shipway took the order; refused: a definite refusal (duplicate flagged); null: unclear. */
export function parseShipwayPush(body: unknown): { kind: 'ok' } | { kind: 'refused'; duplicate: boolean } | null {
  if (!isObject(body) || typeof body.status !== 'string') return null;
  if (/^success/i.test(body.status)) return { kind: 'ok' };
  if (/^(error|fail)/i.test(body.status)) {
    return { kind: 'refused', duplicate: /(duplicate|already|exist)/i.test(typeof body.message === 'string' ? body.message : '') };
  }
  return null;
}

// ---------------------------------------------------------------- the provider

export function createShipwayProvider(overrides: Partial<ProviderDeps> = {}): CourierProvider {
  const deps: ProviderDeps = {
    fetch: (url, init) => leaseFetch(url, init),
    loadSecrets: defaultLoader,
    env: () => process.env,
    now: () => new Date(),
    ...overrides,
  };
  const post = (s: Pick<ProviderSecrets, 'label' | 'secret'>, path: string, body: Record<string, unknown>) =>
    courierRequest(deps.fetch, PREFIX, `${SHIPWAY_API_BASE}${path}`, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json', Authorization: basic(s.label, s.secret) },
      body: JSON.stringify({ username: s.label, password: s.secret, ...body }),
    });
  const guard = async (accountId: string) => {
    if (shipwayDisabled(deps.env())) throw new ShipmentError('not_configured');
    return deps.loadSecrets(accountId);
  };
  const lookup = async (accountId: string, reference: string) => {
    const s = await guard(accountId);
    return (await post(s, '/getOrderShipmentDetails', { order_id: reference })).json;
  };

  return {
    id: 'shipway',
    name: 'Shipway',
    testedLive: false,
    requiresPickup: false,
    disabled: () => shipwayDisabled(deps.env()),
    async testConnection(credentials) {
      if (shipwayDisabled(deps.env())) throw new ShipmentError('not_configured');
      const res = await post(credentials, '/authenticateUser', {});
      // A 200 that is not an explicit success (Shipway answers bad details in the body) is "bad details".
      if (!isObject(res.json) || typeof res.json.status !== 'string' || !/^success/i.test(res.json.status)) throw new CourierError('auth', res.status, 'auth', PREFIX);
      return { pickupLocations: [] };
    },
    async create(accountId, input) {
      const s = await guard(accountId);
      const res = await post(s, '/PushOrderData', toShipwayOrder(input, s.label, s.secret));
      const parsed = parseShipwayPush(res.json);
      if (parsed?.kind === 'ok') return { srOrderId: input.reference, srShipmentId: input.reference };
      if (parsed?.kind === 'refused') throw new CourierError('rejected', 200, parsed.duplicate ? 'duplicate_order' : 'provider_rejected', PREFIX);
      return null;
    },
    async assignAwb(accountId, ref) {
      const found = parseShipwayFound(await lookup(accountId, ref.reference), ref.reference);
      return found?.awb ? { kind: 'assigned', awb: found.awb, courier: found.courier } : null;
    },
    async findByReference(accountId, reference) {
      return parseShipwayFound(await lookup(accountId, reference), reference);
    },
    async showOrder(accountId, ref) {
      return parseShipwayFound(await lookup(accountId, ref.reference), ref.reference);
    },
    async cancel() {
      throw new ShipmentError('not_implemented');
    },
    async labelUrl() {
      throw new ShipmentError('not_implemented');
    },
    async requestPickup() {
      // The carrier and its pickup are arranged inside Shipway after the push.
    },
    async track(accountId, ref) {
      // By AWB (an assumption: the endpoint is documented by order id; both are accepted by this adapter's parser).
      const s = await guard(accountId);
      return parseShipwayTracking((await post(s, '/getOrderShipmentDetails', { awb: ref.awb })).json);
    },
  };
}

async function defaultLoader(accountId: string): Promise<ProviderSecrets> {
  const { loadProviderSecrets } = await import('../provider-connection');
  return loadProviderSecrets(accountId, 'shipway');
}

export const shipwayProvider: CourierProvider = createShipwayProvider();
