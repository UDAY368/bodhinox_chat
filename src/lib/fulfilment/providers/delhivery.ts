// Delhivery as a CourierProvider (store Phase 5, more couriers).
//
// NOT TESTED AGAINST THE LIVE DELHIVERY API YET. Written from Delhivery's public B2C / One API documentation; every
// path, field name and response shape below is an assumption until a real account has run it. Responses are parsed
// defensively: anything unexpected is "unclear" (reconciled or surfaced), never "success".
//
//   auth        Authorization: Token <api token>
//   waybill     GET  /waybill/api/bulk/json/?count=1
//   create      POST /api/cmu/create.json   (form body: format=json&data=<json>)
//   tracking    GET  /api/v1/packages/json/?waybill=<awb> or ?ref_ids=<our reference>
//   pickup      POST /fm/request/new/       (one pickup request per warehouse and day)
//   cancel      POST /api/p/edit            ({ waybill, cancellation: "true" })
//   label       GET  /api/p/packing_slip?wbns=<awb>&pdf=true
//   test        GET  /c/api/pin-codes/json/?filter_codes=110001 (a bad token answers 401)
//
// The waybill is the AWB: Delhivery has no wallet-charging "assign AWB" step, so assignAwb returns the waybill taken
// at create time without a request. The shipment row keeps the waybill as sr_order_id and sr_shipment_id.
// The token is the account's own API token, stored encrypted like the Shiprocket password and never logged.
import { leaseFetch } from '@/lib/jobs/lease';
import type { TrackingEvent } from '../derive-tracking';
import { parseShiprocketTime } from '../status-map';
import { ShipmentError, type TrackingStatus } from '../types';
import { courierRequest, isObject, slug } from './http';
import {
  CourierError, type AwbOutcome, type CourierOrderInput, type CourierProvider, type FetchLike, type FoundOrder, type ShipmentRef,
} from './types';

export const DELHIVERY_API_BASE = 'https://track.delhivery.com';
const WAYBILL = /^[A-Za-z0-9-]{4,40}$/;
const MAX_SCANS = 500;
const PREFIX = 'delhivery';

export interface ProviderSecrets {
  label: string;
  secret: string;
  pickup: string | null;
}
/** Loads the workspace's live connection secrets (throws ShipmentError not_connected, or CourierError auth when it needs reconnecting). */
export type SecretsLoader = (accountId: string) => Promise<ProviderSecrets>;

export interface ProviderDeps {
  fetch: FetchLike;
  loadSecrets: SecretsLoader;
  env: () => Record<string, string | undefined>;
  now: () => Date;
}

export const delhiveryDisabled = (env: Record<string, string | undefined> = process.env): boolean => env.DELHIVERY_DISABLED?.trim() === 'true';

type Body = { kind: 'json' | 'form'; text: string };

// ---------------------------------------------------------------- status mapping

/**
 * Delhivery scan -> normalised status. ScanType: UD undelivered / in progress, DL delivered, RT return, PP pickup
 * pending, PU picked up, CN cancelled. Anything not clearly one of ours is 'unrecognised' and dropped: an unknown
 * scan can never move an order.
 */
export function normalizeDelhivery(scanType: unknown, scan: unknown, instructions?: unknown): TrackingStatus | 'unrecognised' {
  const type = typeof scanType === 'string' ? scanType.trim().toUpperCase() : '';
  const text = `${typeof scan === 'string' ? scan : ''} ${typeof instructions === 'string' ? instructions : ''}`.toLowerCase();
  if (/\b(lost|damaged|destroyed|shortage|misplaced)\b/.test(text)) return 'lost';
  if (type === 'CN' || /\bcancel/.test(text)) return 'cancelled';
  if (type === 'DL') return /\b(rto|return)/.test(text) ? 'rto_delivered' : /deliver/.test(text) ? 'delivered' : 'unrecognised';
  if (type === 'RT') return /(initiat|mark|accept|dispos)/.test(text) ? 'rto_initiated' : 'rto_in_transit';
  if (type === 'PP') return 'pickup_scheduled';
  if (type === 'PU') return /\b(not picked|pickup (failed|pending|rescheduled))/.test(text) ? 'pickup_scheduled' : 'picked_up';
  if (type === 'UD' || type === '') {
    if (/manifest/.test(text)) return 'awb_assigned';
    if (/(out for delivery|dispatched)/.test(text)) return 'out_for_delivery';
    if (/(not available|refus|undeliver|attempt|ndr|consignee unavailable|address)/.test(text)) return 'delivery_failed';
    if (/(in transit|reached|received|forward|shipped|bagged|picked|pending|connected)/.test(text)) return 'in_transit';
  }
  return 'unrecognised';
}

function eventOf(scanType: unknown, scan: unknown, instructions: unknown, at: unknown): TrackingEvent | null {
  const status = normalizeDelhivery(scanType, scan, instructions);
  if (status === 'unrecognised' || typeof at !== 'string') return null;
  const eventAt = parseShiprocketTime(at.trim().replace(/\.\d+$/, '').replace(/Z$/, ''));
  const code = [slug(scanType, 4), slug(scan, 30)].filter(Boolean).join('_').slice(0, 40);
  return eventAt && code ? { status, providerCode: code, eventAt } : null;
}

/** The normalised scans of a /api/v1/packages/json response (status, provider code and time only: no location or instructions survive). */
export function parseDelhiveryTracking(body: unknown): TrackingEvent[] {
  const data = isObject(body) && Array.isArray(body.ShipmentData) ? body.ShipmentData : [];
  const shipment = isObject(data[0]) && isObject(data[0].Shipment) ? data[0].Shipment : null;
  if (!shipment) return [];
  const events: TrackingEvent[] = [];
  const scans = Array.isArray(shipment.Scans) ? shipment.Scans.slice(0, MAX_SCANS) : [];
  for (const entry of scans) {
    const d = isObject(entry) && isObject(entry.ScanDetail) ? entry.ScanDetail : null;
    if (!d) continue;
    const event = eventOf(d.ScanType, d.Scan, d.Instructions, d.ScanDateTime ?? d.StatusDateTime);
    if (event) events.push(event);
  }
  const current = isObject(shipment.Status) ? shipment.Status : null;
  if (current) {
    const event = eventOf(current.StatusType, current.Status, current.Instructions, current.StatusDateTime);
    if (event) events.push(event);
  }
  return events;
}

/** Waybill and the courier name from a tracking body, or null when Delhivery does not know the package. */
export function parseDelhiveryFound(body: unknown): FoundOrder | null {
  const data = isObject(body) && Array.isArray(body.ShipmentData) ? body.ShipmentData : [];
  const shipment = isObject(data[0]) && isObject(data[0].Shipment) ? data[0].Shipment : null;
  const raw = shipment?.AWB ?? shipment?.Waybill;
  const awb = typeof raw === 'string' || typeof raw === 'number' ? String(raw).trim() : '';
  return WAYBILL.test(awb) ? { srOrderId: awb, srShipmentId: awb, awb, courier: 'Delhivery' } : null;
}

// ---------------------------------------------------------------- request building

/** The `data` JSON of cmu/create.json for a neutral order. */
export function toDelhiveryShipment(input: CourierOrderInput, waybill: string) {
  const c = input.customer;
  return {
    shipments: [{
      name: c.name,
      add: [c.line1, c.line2].filter(Boolean).join(', '),
      pin: c.postalCode,
      city: c.city,
      state: c.state,
      country: 'India',
      phone: c.phone,
      order: input.reference,
      payment_mode: input.cod ? 'COD' : 'Prepaid',
      cod_amount: input.cod ? input.total : 0,
      total_amount: input.total,
      products_desc: input.items.map((i) => `${i.name} x${i.units}`).join(', ').slice(0, 200),
      hsn_code: input.items.find((i) => i.hsn)?.hsn ?? '',
      quantity: input.items.reduce((n, i) => n + i.units, 0),
      waybill,
      weight: Math.round(input.weightKg * 1000),
      shipment_length: input.lengthCm,
      shipment_width: input.breadthCm,
      shipment_height: input.heightCm,
      shipping_mode: 'Surface',
      address_type: 'home',
    }],
    pickup_location: { name: input.pickup },
  };
}

/** A waybill from the bulk-waybill answer: a bare string, a JSON string, or { waybill: [...] } / { wbn }. */
export function parseWaybill(text: string, json: unknown): string | null {
  const candidates: unknown[] = [];
  if (typeof json === 'string') candidates.push(json);
  if (isObject(json)) candidates.push(json.waybill, json.wbn, Array.isArray(json.waybills) ? json.waybills[0] : null);
  if (Array.isArray(json)) candidates.push(json[0]);
  candidates.push(text.replace(/^"|"$/g, ''));
  for (const c of candidates) {
    const first = Array.isArray(c) ? c[0] : c;
    const s = typeof first === 'string' || typeof first === 'number' ? String(first).trim().split(',')[0].trim() : '';
    if (WAYBILL.test(s)) return s;
  }
  return null;
}

/** The result of cmu/create.json: the package's waybill, a definite refusal, a duplicate, or null when unclear. */
export function parseDelhiveryCreate(body: unknown, reference: string):
  { kind: 'created'; waybill: string } | { kind: 'refused'; duplicate: boolean } | null {
  if (!isObject(body)) return null;
  const packages = Array.isArray(body.packages) ? body.packages : [];
  const pkg = packages.find((p) => isObject(p) && (p.refnum === reference || p.client_order_id === reference)) ?? packages[0];
  if (isObject(pkg)) {
    const status = typeof pkg.status === 'string' ? pkg.status.toLowerCase() : '';
    const raw = pkg.waybill;
    const waybill = typeof raw === 'string' || typeof raw === 'number' ? String(raw).trim() : '';
    if (status === 'success' && WAYBILL.test(waybill)) return { kind: 'created', waybill };
    if (status === 'fail' || status === 'failed' || body.success === false) {
      const remarks = JSON.stringify(pkg.remarks ?? body.rmk ?? '').toLowerCase();
      return { kind: 'refused', duplicate: /(duplicate|already|exist)/.test(remarks) };
    }
  }
  if (body.success === false) return { kind: 'refused', duplicate: /(duplicate|already)/.test(JSON.stringify(body.rmk ?? '').toLowerCase()) };
  return null;
}

/** A pickup request for `date` (YYYYMMDD) in Asia/Kolkata: tomorrow, 10:00, one package. */
export function pickupBody(warehouse: string, now: Date) {
  const ist = new Date(now.getTime() + 330 * 60_000 + 24 * 3_600_000);
  return {
    pickup_time: '10:00:00', pickup_date: ist.toISOString().slice(0, 10).replace(/-/g, ''), pickup_location: warehouse,
    expected_package_count: 1,
  };
}

// ---------------------------------------------------------------- the provider

const notFound = (): never => { throw new CourierError('rejected', null, 'invalid', PREFIX); };
const need = (v: string | null): string => v ?? notFound();

export function createDelhiveryProvider(overrides: Partial<ProviderDeps> = {}): CourierProvider {
  const deps: ProviderDeps = {
    fetch: (url, init) => leaseFetch(url, init),
    loadSecrets: defaultLoader,
    env: () => process.env,
    now: () => new Date(),
    ...overrides,
  };
  const call = (token: string, method: 'GET' | 'POST', path: string, body?: Body) =>
    courierRequest(deps.fetch, PREFIX, `${DELHIVERY_API_BASE}${path}`, {
      method,
      headers: {
        Accept: 'application/json', Authorization: `Token ${token}`,
        ...(body ? { 'Content-Type': body.kind === 'json' ? 'application/json' : 'application/x-www-form-urlencoded' } : {}),
      },
      body: body?.text,
    });
  const guard = async (accountId: string) => {
    if (delhiveryDisabled(deps.env())) throw new ShipmentError('not_configured');
    return deps.loadSecrets(accountId);
  };
  const track = async (token: string, query: string): Promise<unknown> => (await call(token, 'GET', `/api/v1/packages/json/?${query}`)).json;

  return {
    id: 'delhivery',
    name: 'Delhivery',
    testedLive: false,
    requiresPickup: true,
    disabled: () => delhiveryDisabled(deps.env()),
    async testConnection(credentials) {
      if (delhiveryDisabled(deps.env())) throw new ShipmentError('not_configured');
      // The pin-code lookup needs only a valid token; the warehouse (pickup) name is typed by the admin (Delhivery has no list call).
      await call(credentials.secret, 'GET', '/c/api/pin-codes/json/?filter_codes=110001');
      return { pickupLocations: [] };
    },
    async create(accountId, input) {
      const s = await guard(accountId);
      let waybill: string | null;
      try {
        const res = await call(s.secret, 'GET', '/waybill/api/bulk/json/?count=1');
        waybill = parseWaybill(res.text, res.json);
      } catch (error) {
        // Nothing was created yet: an ambiguous answer here only means "try again later".
        if (error instanceof CourierError && error.kind === 'unknown') throw new CourierError('unavailable', error.status, error.code, PREFIX);
        throw error;
      }
      if (!waybill) throw new CourierError('unavailable', null, 'no_waybill', PREFIX);
      const form = `format=json&data=${encodeURIComponent(JSON.stringify(toDelhiveryShipment(input, waybill)))}`;
      const res = await call(s.secret, 'POST', '/api/cmu/create.json', { kind: 'form', text: form });
      const parsed = parseDelhiveryCreate(res.json, input.reference);
      if (parsed?.kind === 'created') return { srOrderId: parsed.waybill, srShipmentId: parsed.waybill };
      if (parsed?.kind === 'refused') throw new CourierError('rejected', 200, parsed.duplicate ? 'duplicate_order' : 'provider_rejected', PREFIX);
      return null;
    },
    async assignAwb(accountId, ref): Promise<AwbOutcome | null> {
      await guard(accountId);
      // The waybill was fetched and sent at create time: there is nothing to assign or charge.
      return ref.srShipmentId && WAYBILL.test(ref.srShipmentId) ? { kind: 'assigned', awb: ref.srShipmentId, courier: 'Delhivery' } : null;
    },
    async findByReference(accountId, reference) {
      const s = await guard(accountId);
      return parseDelhiveryFound(await track(s.secret, `ref_ids=${encodeURIComponent(reference)}`));
    },
    async showOrder(accountId, ref: ShipmentRef) {
      const s = await guard(accountId);
      return parseDelhiveryFound(await track(s.secret, `waybill=${encodeURIComponent(need(ref.srOrderId))}`));
    },
    async cancel(accountId, ref) {
      const s = await guard(accountId);
      const res = await call(s.secret, 'POST', '/api/p/edit', { kind: 'json', text: JSON.stringify({ waybill: need(ref.srOrderId), cancellation: 'true' }) });
      if (isObject(res.json) && res.json.status === false) throw new CourierError('rejected', 200, 'provider_rejected', PREFIX);
    },
    async labelUrl(accountId, ref) {
      const s = await guard(accountId);
      const res = await call(s.secret, 'GET', `/api/p/packing_slip?wbns=${encodeURIComponent(need(ref.srShipmentId))}&pdf=true`);
      const first = isObject(res.json) && Array.isArray(res.json.packages) ? res.json.packages[0] : null;
      const url = isObject(first) ? first.pdf_download_link : null;
      return typeof url === 'string' ? url : null;
    },
    async requestPickup(accountId) {
      const s = await guard(accountId);
      if (!s.pickup) throw new CourierError('rejected', null, 'no_pickup_location', PREFIX);
      const res = await call(s.secret, 'POST', '/fm/request/new/', { kind: 'json', text: JSON.stringify(pickupBody(s.pickup, deps.now())) });
      if (isObject(res.json) && (res.json.error || res.json.success === false)) throw new CourierError('rejected', 200, 'provider_rejected', PREFIX);
    },
    async track(accountId, ref) {
      const s = await guard(accountId);
      return parseDelhiveryTracking(await track(s.secret, `waybill=${encodeURIComponent(ref.awb)}`));
    },
  };
}

async function defaultLoader(accountId: string): Promise<ProviderSecrets> {
  const { loadProviderSecrets } = await import('../provider-connection');
  return loadProviderSecrets(accountId, 'delhivery');
}

export const delhiveryProvider: CourierProvider = createDelhiveryProvider();
