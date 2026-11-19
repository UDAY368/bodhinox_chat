import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ShipmentError } from '../types';
import {
  createDelhiveryProvider, normalizeDelhivery, parseDelhiveryCreate, parseDelhiveryFound, parseDelhiveryTracking, parseWaybill, pickupBody,
  toDelhiveryShipment,
} from './delhivery';
import { CourierError, type CourierOrderInput } from './types';

const ACCOUNT = '11111111-1111-4111-8111-111111111111';
const TOKEN = 'delhivery-secret-token-0123456789';
const ORDER: CourierOrderInput = {
  reference: 'bxabcdefghijkl', orderDate: '2026-11-15 10:00', pickup: 'Main Warehouse',
  customer: { name: 'Asha Rao', firstName: 'Asha', lastName: 'Rao', line1: '12 MG Road', line2: null, city: 'Bengaluru', state: 'Karnataka',
    postalCode: '560001', phone: '9876543210', email: 'asha@example.invalid' },
  items: [{ name: 'Tea', sku: 'TEA1', units: 2, sellingPrice: 100, discount: 0, tax: 5, hsn: '0902' }],
  cod: true, total: 250, shippingCharges: 50, totalDiscount: 0, subTotal: 200, lengthCm: 10, breadthCm: 10, heightCm: 5, weightKg: 0.5,
};

const fetchMock = vi.fn<(url: string, init: RequestInit) => Promise<Response>>();
const reply = (body: unknown, status = 200) => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
const provider = (env: Record<string, string | undefined> = {}) => createDelhiveryProvider({
  fetch: fetchMock,
  loadSecrets: async () => ({ label: 'Acme Retail', secret: TOKEN, pickup: 'Main Warehouse' }),
  env: () => env,
  now: () => new Date('2026-11-15T05:00:00Z'),
});
const headersOf = (call: number) => fetchMock.mock.calls[call][1].headers as Record<string, string>;
let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  fetchMock.mockReset();
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => errorSpy.mockRestore());

describe('Delhivery status mapping', () => {
  it.each([
    ['UD', 'Manifested', undefined, 'awb_assigned'],
    ['UD', 'In Transit', undefined, 'in_transit'],
    ['UD', 'Dispatched', undefined, 'out_for_delivery'],
    ['UD', 'Pending', 'Consignee unavailable', 'delivery_failed'],
    ['UD', 'Pending', 'Awaiting next hub', 'in_transit'],
    ['PP', 'Pickup pending', undefined, 'pickup_scheduled'],
    ['PU', 'Picked up', undefined, 'picked_up'],
    ['PU', 'Not picked', undefined, 'pickup_scheduled'],
    ['DL', 'Delivered', undefined, 'delivered'],
    ['DL', 'RTO delivered', undefined, 'rto_delivered'],
    ['RT', 'In Transit', undefined, 'rto_in_transit'],
    ['RT', 'RTO initiated', undefined, 'rto_initiated'],
    ['CN', 'Cancelled', undefined, 'cancelled'],
    ['UD', 'Shipment lost', undefined, 'lost'],
  ] as const)('%s %s -> %s', (type, scan, instructions, expected) => {
    expect(normalizeDelhivery(type, scan, instructions)).toBe(expected);
  });

  it('drops anything it cannot place, so an unknown scan never moves an order', () => {
    for (const [type, scan] of [['XX', 'Something odd'], ['DL', 'Hold'], [null, null], [5, 'x']] as const) {
      expect(normalizeDelhivery(type, scan)).toBe('unrecognised');
    }
  });
});

describe('Delhivery parsers', () => {
  const tracking = { ShipmentData: [{ Shipment: {
    AWB: '1234567890123',
    Status: { Status: 'Delivered', StatusType: 'DL', StatusDateTime: '2026-11-18T14:05:00.123', Instructions: 'Delivered to consignee' },
    Scans: [
      { ScanDetail: { ScanType: 'UD', Scan: 'Manifested', ScanDateTime: '2026-11-15T10:00:00.000', ScannedLocation: 'Secret place', Instructions: 'x' } },
      { ScanDetail: { ScanType: 'PU', Scan: 'Picked up', ScanDateTime: '2026-11-16T09:00:00' } },
      { ScanDetail: { ScanType: 'ZZ', Scan: 'Mystery', ScanDateTime: '2026-11-16T10:00:00' } },
      { ScanDetail: { ScanType: 'UD', Scan: 'In Transit', ScanDateTime: 'not a date' } },
    ],
  } }] };

  it('reads scans as status, code and time only and reads IST', () => {
    const events = parseDelhiveryTracking(tracking);
    expect(events.map((e) => e.status)).toEqual(['awb_assigned', 'picked_up', 'delivered']);
    expect(events[0]).toEqual({ status: 'awb_assigned', providerCode: 'ud_manifested', eventAt: new Date('2026-11-15T04:30:00.000Z') });
    expect(JSON.stringify(events)).not.toMatch(/Secret place|Instructions/);
  });

  it('answers nothing for an unexpected shape', () => {
    for (const body of [null, 'x', [], {}, { ShipmentData: [] }, { ShipmentData: [{}] }, { Error: 'not found' }]) {
      expect(parseDelhiveryTracking(body)).toEqual([]);
      expect(parseDelhiveryFound(body)).toBeNull();
    }
  });

  it('finds the waybill of a tracked package', () => {
    expect(parseDelhiveryFound(tracking)).toEqual({ srOrderId: '1234567890123', srShipmentId: '1234567890123', awb: '1234567890123', courier: 'Delhivery' });
    expect(parseDelhiveryFound({ ShipmentData: [{ Shipment: { AWB: 'no spaces allowed' } }] })).toBeNull();
  });

  it('reads a waybill from the shapes Delhivery is known to answer', () => {
    expect(parseWaybill('1234567890123', null)).toBe('1234567890123');
    expect(parseWaybill('"1234567890123"', '1234567890123')).toBe('1234567890123');
    expect(parseWaybill('', { waybill: ['1234567890123'] })).toBe('1234567890123');
    expect(parseWaybill('', { wbn: 1234567890123 })).toBe('1234567890123');
    expect(parseWaybill('<html>error</html>', null)).toBeNull();
  });

  it('reads a create result: created, refused (duplicate flagged) or unclear', () => {
    const ok = { success: true, packages: [{ status: 'Success', waybill: '1234567890123', refnum: 'bxabcdefghijkl' }] };
    expect(parseDelhiveryCreate(ok, 'bxabcdefghijkl')).toEqual({ kind: 'created', waybill: '1234567890123' });
    expect(parseDelhiveryCreate({ success: false, packages: [{ status: 'Fail', remarks: ['Duplicate order id'] }] }, 'x')).toEqual({ kind: 'refused', duplicate: true });
    expect(parseDelhiveryCreate({ success: false, rmk: 'Invalid pin' }, 'x')).toEqual({ kind: 'refused', duplicate: false });
    expect(parseDelhiveryCreate({ packages: [{ status: 'Success' }] }, 'x')).toBeNull();
    expect(parseDelhiveryCreate('nope', 'x')).toBeNull();
  });

  it('builds the create body and a next-day pickup request', () => {
    const body = toDelhiveryShipment(ORDER, '1234567890123');
    expect(body.pickup_location).toEqual({ name: 'Main Warehouse' });
    expect(body.shipments[0]).toMatchObject({ order: 'bxabcdefghijkl', waybill: '1234567890123', payment_mode: 'COD', cod_amount: 250, pin: '560001', weight: 500 });
    expect(pickupBody('Main Warehouse', new Date('2026-11-15T05:00:00Z'))).toEqual({
      pickup_time: '10:00:00', pickup_date: '20261116', pickup_location: 'Main Warehouse', expected_package_count: 1,
    });
    expect(toDelhiveryShipment({ ...ORDER, cod: false }, 'w').shipments[0]).toMatchObject({ payment_mode: 'Prepaid', cod_amount: 0 });
  });
});

describe('Delhivery provider requests', () => {
  it('creates: fetches a waybill, then posts the manifest form with the token header', async () => {
    fetchMock.mockResolvedValueOnce(reply({ waybill: ['1234567890123'] }));
    fetchMock.mockResolvedValueOnce(reply({ success: true, packages: [{ status: 'Success', waybill: '1234567890123', refnum: ORDER.reference }] }));
    await expect(provider().create(ACCOUNT, ORDER)).resolves.toEqual({ srOrderId: '1234567890123', srShipmentId: '1234567890123' });
    expect(fetchMock.mock.calls[0][0]).toBe('https://track.delhivery.com/waybill/api/bulk/json/?count=1');
    expect(headersOf(0).Authorization).toBe(`Token ${TOKEN}`);
    const [url, init] = fetchMock.mock.calls[1];
    expect(url).toBe('https://track.delhivery.com/api/cmu/create.json');
    expect(init).toMatchObject({ method: 'POST', redirect: 'error' });
    expect(headersOf(1)['Content-Type']).toBe('application/x-www-form-urlencoded');
    const form = new URLSearchParams(init.body as string);
    expect(form.get('format')).toBe('json');
    expect(JSON.parse(form.get('data')!).shipments[0].order).toBe(ORDER.reference);
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('classifies create failures; a failed waybill fetch is "try later", never an ambiguous create', async () => {
    fetchMock.mockResolvedValueOnce(reply('', 503));
    await expect(provider().create(ACCOUNT, ORDER)).rejects.toMatchObject({ kind: 'unavailable' });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const afterWaybill = (next: Response | Error) => {
      fetchMock.mockReset();
      fetchMock.mockResolvedValueOnce(reply({ waybill: '1234567890123' }));
      if (next instanceof Error) fetchMock.mockRejectedValueOnce(next); else fetchMock.mockResolvedValueOnce(next);
      return provider().create(ACCOUNT, ORDER).catch((e: unknown) => e);
    };
    expect(await afterWaybill(reply({}, 401))).toMatchObject({ kind: 'auth' });
    expect(await afterWaybill(reply({}, 429))).toMatchObject({ kind: 'throttled' });
    expect(await afterWaybill(reply({}, 422))).toMatchObject({ kind: 'rejected', code: 'http_422' });
    expect(await afterWaybill(reply({}, 502))).toMatchObject({ kind: 'unknown', code: 'http_502' });
    expect(await afterWaybill(new DOMException('timeout', 'TimeoutError'))).toMatchObject({ kind: 'unknown', code: 'network' });
    expect(await afterWaybill(reply({ success: false, packages: [{ status: 'Fail', remarks: ['Duplicate order'] }] })))
      .toMatchObject({ kind: 'rejected', code: 'duplicate_order' });
    expect(await afterWaybill(reply('<html>oops</html>'))).toBeNull();
  });

  it('assigns the AWB without any request (the waybill was taken at create time)', async () => {
    const ref = { reference: ORDER.reference, srOrderId: '1234567890123', srShipmentId: '1234567890123', awb: null };
    await expect(provider().assignAwb(ACCOUNT, ref)).resolves.toEqual({ kind: 'assigned', awb: '1234567890123', courier: 'Delhivery' });
    await expect(provider().assignAwb(ACCOUNT, { ...ref, srShipmentId: null })).resolves.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('tracks by waybill and reconciles by our reference', async () => {
    fetchMock.mockImplementation(async () => reply({ ShipmentData: [{ Shipment: { AWB: '1234567890123', Status: { Status: 'In Transit', StatusType: 'UD', StatusDateTime: '2026-11-16T08:00:00' }, Scans: [] } }] }));
    expect((await provider().track(ACCOUNT, { awb: '1234567890123' })).map((e) => e.status)).toEqual(['in_transit']);
    expect(fetchMock.mock.calls[0][0]).toBe('https://track.delhivery.com/api/v1/packages/json/?waybill=1234567890123');
    expect(headersOf(0).Authorization).toBe(`Token ${TOKEN}`);
    await expect(provider().findByReference(ACCOUNT, 'bxabcdefghijkl')).resolves.toMatchObject({ awb: '1234567890123' });
    expect(fetchMock.mock.calls[1][0]).toBe('https://track.delhivery.com/api/v1/packages/json/?ref_ids=bxabcdefghijkl');
    fetchMock.mockImplementation(async () => reply({ Error: 'no such package' }));
    await expect(provider().findByReference(ACCOUNT, 'bxzzzzzzzzzzzz')).resolves.toBeNull();
  });

  it('cancels, fetches a label link and requests a pickup', async () => {
    const ref = { reference: ORDER.reference, srOrderId: '1234567890123', srShipmentId: '1234567890123', awb: '1234567890123' };
    fetchMock.mockResolvedValueOnce(reply({ status: true }));
    await provider().cancel(ACCOUNT, ref);
    expect(fetchMock.mock.calls[0][0]).toBe('https://track.delhivery.com/api/p/edit');
    expect(JSON.parse(fetchMock.mock.calls[0][1].body as string)).toEqual({ waybill: '1234567890123', cancellation: 'true' });
    fetchMock.mockResolvedValueOnce(reply({ status: false }));
    await expect(provider().cancel(ACCOUNT, ref)).rejects.toMatchObject({ kind: 'rejected' });

    fetchMock.mockResolvedValueOnce(reply({ packages: [{ pdf_download_link: 'https://cdn.example.invalid/slip.pdf' }] }));
    await expect(provider().labelUrl(ACCOUNT, ref)).resolves.toBe('https://cdn.example.invalid/slip.pdf');
    fetchMock.mockResolvedValueOnce(reply({ packages: [] }));
    await expect(provider().labelUrl(ACCOUNT, ref)).resolves.toBeNull();

    fetchMock.mockResolvedValueOnce(reply({ pickup_id: 77 }));
    await provider().requestPickup(ACCOUNT, ref);
    const pickupCall = fetchMock.mock.calls.at(-1)!;
    expect(pickupCall[0]).toBe('https://track.delhivery.com/fm/request/new/');
    expect(JSON.parse(pickupCall[1].body as string)).toMatchObject({ pickup_location: 'Main Warehouse', expected_package_count: 1 });
  });

  it('tests the connection with the typed credentials and says a bad token is auth', async () => {
    fetchMock.mockResolvedValueOnce(reply([]));
    await expect(provider().testConnection({ label: 'x', secret: 'candidate-token-123' })).resolves.toEqual({ pickupLocations: [] });
    expect(headersOf(0).Authorization).toBe('Token candidate-token-123');
    fetchMock.mockResolvedValueOnce(reply({}, 401));
    await expect(provider().testConnection({ label: 'x', secret: 'bad-token-123456' })).rejects.toBeInstanceOf(CourierError);
  });

  it('makes no request when switched off, and never logs the token', async () => {
    const off = provider({ DELHIVERY_DISABLED: 'true' });
    expect(off.disabled()).toBe(true);
    await expect(off.create(ACCOUNT, ORDER)).rejects.toBeInstanceOf(ShipmentError);
    await expect(off.track(ACCOUNT, { awb: '1234567890123' })).rejects.toMatchObject({ code: 'not_configured' });
    await expect(off.testConnection({ label: 'x', secret: 'abcdefgh' })).rejects.toMatchObject({ code: 'not_configured' });
    expect(fetchMock).not.toHaveBeenCalled();

    fetchMock.mockResolvedValueOnce(reply({ message: 'secret detail' }, 500));
    await provider().track(ACCOUNT, { awb: '1234567890123' }).catch(() => undefined);
    const logged = JSON.stringify(errorSpy.mock.calls);
    expect(logged).not.toContain(TOKEN);
    expect(logged).not.toContain('secret detail');
  });
});
