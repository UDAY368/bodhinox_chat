// Shiprocket as a CourierProvider (store Phase 5). A thin wrapper: every request, path and body is exactly what
// shipments.ts and tracking-job.ts sent before the interface existed. The response parsers moved here unchanged and
// are re-exported from shipments.ts / tracking-job.ts so existing imports keep working.
import { shiprocketCall, shiprocketDisabled } from '../shiprocket-client';
import { normalizeShiprocket, parseShiprocketTime } from '../status-map';
import type { TrackingEvent } from '../derive-tracking';
import {
  CourierError, type AwbOutcome, type CourierOrderInput, type CourierProvider, type FoundOrder,
} from './types';

const SR_ID = /^[0-9]{1,20}$/;
const AWB = /^[A-Za-z0-9-]{4,40}$/;
const MAX_SCANS = 500;

const srId = (v: unknown): string | null => {
  const s = typeof v === 'number' && Number.isSafeInteger(v) && v > 0 ? String(v) : typeof v === 'string' ? v.trim() : null;
  return s && SR_ID.test(s) ? s : null;
};
const awbOf = (v: unknown): string | null => {
  const s = typeof v === 'number' && Number.isSafeInteger(v) ? String(v) : typeof v === 'string' ? v.trim() : null;
  return s && AWB.test(s) ? s : null;
};
const courierOf = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim().slice(0, 80) : null);
/** Shiprocket ids are sent as numbers when they fit, else as the digit string. */
export const idValue = (id: string): number | string => (Number.isSafeInteger(Number(id)) ? Number(id) : id);

export function parseAdhocCreate(body: unknown): { srOrderId: string; srShipmentId: string } | null {
  const b = (body ?? {}) as Record<string, unknown>;
  const srOrderId = srId(b.order_id);
  const srShipmentId = srId(b.shipment_id);
  return srOrderId && srShipmentId ? { srOrderId, srShipmentId } : null;
}

/** assigned: AWB and courier; refused: Shiprocket answered 2xx with awb_assign_status 0; null: unclear. */
export function parseAwbAssign(body: unknown): AwbOutcome | null {
  const b = (body ?? {}) as Record<string, unknown>;
  const data = ((b.response as Record<string, unknown> | undefined)?.data ?? b.data ?? b) as Record<string, unknown>;
  const awb = awbOf(data?.awb_code) ?? awbOf(b.awb_code);
  if (awb) return { kind: 'assigned', awb, courier: courierOf(data?.courier_name) ?? courierOf(b.courier_name) };
  if (b.awb_assign_status === 0 || b.awb_assign_status === '0') return { kind: 'refused' };
  return null;
}

function shipmentsOf(entry: Record<string, unknown>): Record<string, unknown>[] {
  const s = entry.shipments;
  if (Array.isArray(s)) return s.filter((x): x is Record<string, unknown> => !!x && typeof x === 'object');
  return s && typeof s === 'object' ? [s as Record<string, unknown>] : [];
}

function toFound(entry: Record<string, unknown>): FoundOrder | null {
  const srOrderId = srId(entry.id) ?? srId(entry.order_id);
  if (!srOrderId) return null;
  const ship = shipmentsOf(entry)[0] ?? {};
  const awbData = (entry.awb_data ?? {}) as Record<string, unknown>;
  return {
    srOrderId,
    srShipmentId: srId(ship.id) ?? srId(entry.shipment_id),
    awb: awbOf(ship.awb) ?? awbOf(ship.awb_code) ?? awbOf(awbData.awb) ?? awbOf(entry.awb_code),
    courier: courierOf(ship.courier) ?? courierOf(ship.courier_name) ?? courierOf(entry.courier_name),
  };
}

/** The order with our reference as channel_order_id in a GET /orders?search= result (exact match only). */
export function findByReference(body: unknown, reference: string): FoundOrder | null {
  const data = (body as { data?: unknown } | null)?.data;
  const list = Array.isArray(data) ? data : [];
  for (const entry of list) {
    if (!entry || typeof entry !== 'object') continue;
    const e = entry as Record<string, unknown>;
    if (e.channel_order_id === reference) return toFound(e);
  }
  return null;
}

/** The order detail of GET /orders/show/<id>, only when it is the expected order. */
export function parseOrderShow(body: unknown, srOrderId: string): FoundOrder | null {
  const data = (body as { data?: unknown } | null)?.data;
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  const found = toFound(data as Record<string, unknown>);
  return found && found.srOrderId === srOrderId ? found : null;
}

/** The Shiprocket adhoc order body for a neutral order (the same JSON shipments.ts built before). */
export function toAdhocPayload(input: CourierOrderInput) {
  const c = input.customer;
  return {
    order_id: input.reference,
    order_date: input.orderDate,
    pickup_location: input.pickup,
    billing_customer_name: c.firstName,
    billing_last_name: c.lastName,
    billing_address: c.line1,
    billing_address_2: c.line2 ?? '',
    billing_city: c.city,
    billing_pincode: c.postalCode,
    billing_state: c.state,
    billing_country: 'India',
    billing_email: c.email,
    billing_phone: c.phone,
    shipping_is_billing: true,
    order_items: input.items.map((i) => ({
      name: i.name, sku: i.sku, units: i.units, selling_price: i.sellingPrice, discount: i.discount, tax: i.tax,
      ...(i.hsn ? { hsn: i.hsn } : {}),
    })),
    payment_method: input.cod ? 'COD' : 'Prepaid',
    shipping_charges: input.shippingCharges,
    total_discount: input.totalDiscount,
    sub_total: input.subTotal,
    length: input.lengthCm,
    breadth: input.breadthCm,
    height: input.heightCm,
    weight: input.weightKg,
  };
}

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => Boolean(v) && typeof v === 'object' && !Array.isArray(v);

function trackingData(body: unknown, awb: string): Json | null {
  if (Array.isArray(body)) {
    for (const item of body.slice(0, 5)) {
      const found = trackingData(item, awb);
      if (found) return found;
    }
    return null;
  }
  if (!isObject(body)) return null;
  if (isObject(body.tracking_data)) return body.tracking_data;
  const keyed = body[awb];
  if (isObject(keyed) && isObject(keyed.tracking_data)) return keyed.tracking_data;
  return null;
}

function providerCode(code: unknown, label: unknown): string | null {
  if (typeof code === 'number' && Number.isSafeInteger(code)) return String(code);
  if (typeof code === 'string' && /^\d{1,4}$/.test(code.trim())) return code.trim();
  if (typeof label === 'string') {
    const slug = label.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
    if (slug) return `label_${slug}`.slice(0, 40);
  }
  return null;
}

function scan(code: unknown, label: unknown, at: unknown): TrackingEvent | null {
  const status = normalizeShiprocket(typeof code === 'number' || typeof code === 'string' ? code : null, typeof label === 'string' ? label : null);
  if (status === 'unrecognised') return null;
  const eventAt = parseShiprocketTime(typeof at === 'string' ? at : null);
  const pc = providerCode(code, label);
  return eventAt && pc ? { status, providerCode: pc, eventAt } : null;
}

/**
 * The normalised scans in a Shiprocket tracking response (status, provider code, time only: no location, activity
 * text or customer field survives). Unmapped ("NA") and undated scans are dropped.
 */
export function parseTrackingResponse(body: unknown, awb: string): TrackingEvent[] {
  const data = trackingData(body, awb);
  if (!data) return [];
  const events: TrackingEvent[] = [];
  const activities = Array.isArray(data.shipment_track_activities) ? data.shipment_track_activities.slice(0, MAX_SCANS) : [];
  for (const a of activities) {
    if (!isObject(a)) continue;
    const event = scan(a['sr-status'], a['sr-status-label'] ?? a.status, a.date);
    if (event) events.push(event);
  }
  // The delivery itself, when Shiprocket reports it with a date but no scan for it yet.
  const track = Array.isArray(data.shipment_track) && isObject(data.shipment_track[0]) ? data.shipment_track[0] : null;
  if (track && typeof track.delivered_date === 'string') {
    const event = scan(data.shipment_status, track.current_status, track.delivered_date);
    if (event?.status === 'delivered') events.push(event);
  }
  return events;
}

const needId = (v: string | null): string => {
  if (!v) throw new CourierError('rejected', null, 'invalid', 'shiprocket');
  return v;
};

export const shiprocketProvider: CourierProvider = {
  id: 'shiprocket',
  name: 'Shiprocket',
  testedLive: true,
  requiresPickup: true,
  disabled: () => shiprocketDisabled(),
  async testConnection(credentials) {
    const { shiprocketLogin, shiprocketRequest } = await import('../shiprocket-client');
    const { parsePickupLocations } = await import('../connection');
    const login = await shiprocketLogin(credentials.label, credentials.secret);
    return { pickupLocations: parsePickupLocations(await shiprocketRequest(login.token, 'GET', '/settings/company/pickup')) };
  },
  async create(accountId, input) {
    return parseAdhocCreate(await shiprocketCall(accountId, 'POST', '/orders/create/adhoc', toAdhocPayload(input)));
  },
  async assignAwb(accountId, ref) {
    return parseAwbAssign(await shiprocketCall(accountId, 'POST', '/courier/assign/awb', { shipment_id: idValue(needId(ref.srShipmentId)) }));
  },
  async findByReference(accountId, reference) {
    return findByReference(await shiprocketCall(accountId, 'GET', `/orders?search=${encodeURIComponent(reference)}`), reference);
  },
  async showOrder(accountId, ref) {
    if (!ref.srOrderId) return null;
    return parseOrderShow(await shiprocketCall(accountId, 'GET', `/orders/show/${ref.srOrderId}`), ref.srOrderId);
  },
  async cancel(accountId, ref) {
    await shiprocketCall(accountId, 'POST', '/orders/cancel', { ids: [idValue(needId(ref.srOrderId))] });
  },
  async labelUrl(accountId, ref) {
    const body = await shiprocketCall(accountId, 'POST', '/courier/generate/label', { shipment_id: [idValue(needId(ref.srShipmentId))] });
    const url = (body as { label_url?: unknown } | null)?.label_url;
    return typeof url === 'string' ? url : null;
  },
  async requestPickup(accountId, ref) {
    await shiprocketCall(accountId, 'POST', '/courier/generate/pickup', { shipment_id: [idValue(needId(ref.srShipmentId))] });
  },
  async track(accountId, ref) {
    return parseTrackingResponse(await shiprocketCall(accountId, 'GET', `/courier/track/awb/${encodeURIComponent(ref.awb)}`), ref.awb);
  },
};
