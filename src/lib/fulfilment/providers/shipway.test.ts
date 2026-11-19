import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ShipmentError } from '../types';
import {
  createShipwayProvider, normalizeShipway, parseShipwayFound, parseShipwayPush, parseShipwayTracking, toShipwayOrder,
} from './shipway';
import type { CourierOrderInput } from './types';

const ACCOUNT = '11111111-1111-4111-8111-111111111111';
const LICENCE = 'shipway-licence-key-0123456789';
const ORDER: CourierOrderInput = {
  reference: 'bxabcdefghijkl', orderDate: '2026-11-15 10:00', pickup: '',
  customer: { name: 'Asha Rao', firstName: 'Asha', lastName: 'Rao', line1: '12 MG Road', line2: 'Flat 4', city: 'Bengaluru', state: 'Karnataka',
    postalCode: '560001', phone: '9876543210', email: 'asha@example.invalid' },
  items: [{ name: 'Tea', sku: 'TEA1', units: 2, sellingPrice: 100, discount: 0, tax: 5, hsn: null }],
  cod: false, total: 250, shippingCharges: 50, totalDiscount: 0, subTotal: 200, lengthCm: 10, breadthCm: 10, heightCm: 5, weightKg: 0.5,
};

const fetchMock = vi.fn<(url: string, init: RequestInit) => Promise<Response>>();
const reply = (body: unknown, status = 200) => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
const provider = (env: Record<string, string | undefined> = {}) => createShipwayProvider({
  fetch: fetchMock, loadSecrets: async () => ({ label: 'acme-user', secret: LICENCE, pickup: null }), env: () => env,
});
const bodyOf = (call: number) => JSON.parse(fetchMock.mock.calls[call][1].body as string) as Record<string, unknown>;
const headersOf = (call: number) => fetchMock.mock.calls[call][1].headers as Record<string, string>;
let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  fetchMock.mockReset();
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => errorSpy.mockRestore());

describe('Shipway status mapping', () => {
  it.each([
    ['Pickup Pending', 'pickup_scheduled'], ['Picked Up', 'picked_up'], ['In Transit', 'in_transit'], ['Out for Delivery', 'out_for_delivery'],
    ['Delivered', 'delivered'], ['NDR', 'delivery_failed'], ['RTO Initiated', 'rto_initiated'], ['RTO In-Transit', 'rto_in_transit'],
    ['RTO Delivered', 'rto_delivered'], ['Cancelled', 'cancelled'], ['Lost', 'lost'], ['AWB Assigned', 'awb_assigned'],
  ] as const)('%s -> %s', (label, expected) => expect(normalizeShipway(label)).toBe(expected));

  it('drops labels it does not know', () => {
    for (const label of ['Something else', '', null, 7, 'x'.repeat(200)]) expect(normalizeShipway(label)).toBe('unrecognised');
  });
});

describe('Shipway parsers', () => {
  const details = { status: 'Success', response: {
    order_id: 'bxabcdefghijkl', awbno: 'SWY123456', carrier_title: 'Blue Dart', current_status: 'In Transit', status_time: '2026-11-16 09:00:00',
    scan: [
      { status: 'Picked Up', time: '2026-11-15 18:00:00', location: 'Private depot' },
      { status: 'Mystery', time: '2026-11-15 19:00:00' },
      { status: 'In Transit', time: 'garbled' },
    ],
  } };

  it('reads scans as status, code and time only', () => {
    const events = parseShipwayTracking(details);
    expect(events.map((e) => e.status)).toEqual(['picked_up', 'in_transit']);
    expect(events[0]).toEqual({ status: 'picked_up', providerCode: 'picked_up', eventAt: new Date('2026-11-15T12:30:00.000Z') });
    expect(JSON.stringify(events)).not.toContain('Private depot');
  });

  it('finds the AWB once Shipway has one, and none before', () => {
    expect(parseShipwayFound(details, 'bxabcdefghijkl')).toEqual({ srOrderId: 'bxabcdefghijkl', srShipmentId: 'bxabcdefghijkl', awb: 'SWY123456', courier: 'Blue Dart' });
    expect(parseShipwayFound({ status: 'Success', response: { order_id: 'x', awbno: '' } }, 'x')?.awb).toBeNull();
    for (const body of [null, 'x', { status: 'Error', message: 'no order' }, []]) {
      expect(parseShipwayFound(body, 'x')).toBeNull();
      expect(parseShipwayTracking(body)).toEqual([]);
    }
  });

  it('reads a push result: ok, refused (duplicate flagged) or unclear', () => {
    expect(parseShipwayPush({ status: 'Success' })).toEqual({ kind: 'ok' });
    expect(parseShipwayPush({ status: 'Error', message: 'Order already exists' })).toEqual({ kind: 'refused', duplicate: true });
    expect(parseShipwayPush({ status: 'Error', message: 'Invalid pincode' })).toEqual({ kind: 'refused', duplicate: false });
    expect(parseShipwayPush({ ok: 1 })).toBeNull();
    expect(parseShipwayPush(null)).toBeNull();
  });

  it('builds the push body', () => {
    expect(toShipwayOrder(ORDER, 'acme-user', LICENCE)).toMatchObject({
      username: 'acme-user', password: LICENCE, order_id: 'bxabcdefghijkl', payment_type: 'P', order_total: 250, zipcode: '560001',
      address: '12 MG Road, Flat 4', weight: 500,
    });
    expect(toShipwayOrder({ ...ORDER, cod: true }, 'u', 'k').payment_type).toBe('C');
  });
});

describe('Shipway provider requests', () => {
  it('pushes the order with the account credentials as basic auth', async () => {
    fetchMock.mockResolvedValueOnce(reply({ status: 'Success' }));
    await expect(provider().create(ACCOUNT, ORDER)).resolves.toEqual({ srOrderId: ORDER.reference, srShipmentId: ORDER.reference });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://shipway.in/api/PushOrderData');
    expect(init).toMatchObject({ method: 'POST', redirect: 'error' });
    expect(headersOf(0).Authorization).toBe(`Basic ${Buffer.from(`acme-user:${LICENCE}`).toString('base64')}`);
    expect(bodyOf(0)).toMatchObject({ username: 'acme-user', order_id: ORDER.reference });
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('classifies failures of the push', async () => {
    const run = (next: Response | Error) => {
      fetchMock.mockReset();
      if (next instanceof Error) fetchMock.mockRejectedValueOnce(next); else fetchMock.mockResolvedValueOnce(next);
      return provider().create(ACCOUNT, ORDER).catch((e: unknown) => e);
    };
    expect(await run(reply({}, 401))).toMatchObject({ kind: 'auth' });
    expect(await run(reply({}, 429))).toMatchObject({ kind: 'throttled' });
    expect(await run(reply({}, 400))).toMatchObject({ kind: 'rejected', code: 'http_400' });
    expect(await run(reply({}, 500))).toMatchObject({ kind: 'unknown' });
    expect(await run(new DOMException('timeout', 'TimeoutError'))).toMatchObject({ kind: 'unknown', code: 'network' });
    expect(await run(reply({ status: 'Error', message: 'Order already exists' }))).toMatchObject({ kind: 'rejected', code: 'duplicate_order' });
    expect(await run(reply({ status: 'Error', message: 'Bad pin' }))).toMatchObject({ kind: 'rejected', code: 'provider_rejected' });
    expect(await run(reply('garbage'))).toBeNull();
  });

  it('looks the AWB up by order; no AWB yet is "unclear", not a failure', async () => {
    const ref = { reference: ORDER.reference, srOrderId: ORDER.reference, srShipmentId: ORDER.reference, awb: null };
    fetchMock.mockResolvedValueOnce(reply({ status: 'Success', response: { awbno: 'SWY123456', carrier_title: 'Blue Dart' } }));
    await expect(provider().assignAwb(ACCOUNT, ref)).resolves.toEqual({ kind: 'assigned', awb: 'SWY123456', courier: 'Blue Dart' });
    expect(fetchMock.mock.calls[0][0]).toBe('https://shipway.in/api/getOrderShipmentDetails');
    expect(bodyOf(0)).toMatchObject({ order_id: ORDER.reference });
    fetchMock.mockResolvedValueOnce(reply({ status: 'Success', response: { awbno: '' } }));
    await expect(provider().assignAwb(ACCOUNT, ref)).resolves.toBeNull();
    fetchMock.mockResolvedValueOnce(reply({ status: 'Error', message: 'unknown order' }));
    await expect(provider().findByReference(ACCOUNT, ORDER.reference)).resolves.toBeNull();
  });

  it('tracks by AWB', async () => {
    fetchMock.mockResolvedValueOnce(reply({ status: 'Success', response: { scan: [{ status: 'Delivered', time: '2026-11-18 14:05:00' }] } }));
    expect((await provider().track(ACCOUNT, { awb: 'SWY123456' })).map((e) => e.status)).toEqual(['delivered']);
    expect(bodyOf(0)).toMatchObject({ awb: 'SWY123456' });
  });

  it('does not wire cancel or label (not_implemented) and a pickup request is a no-op', async () => {
    const ref = { reference: ORDER.reference, srOrderId: ORDER.reference, srShipmentId: ORDER.reference, awb: 'SWY123456' };
    await expect(provider().cancel(ACCOUNT, ref)).rejects.toMatchObject({ code: 'not_implemented' });
    await expect(provider().labelUrl(ACCOUNT, ref)).rejects.toMatchObject({ code: 'not_implemented' });
    await expect(provider().requestPickup(ACCOUNT, ref)).resolves.toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('tests the connection: an explicit success is required, a 200 without it is bad details', async () => {
    fetchMock.mockResolvedValueOnce(reply({ status: 'Success' }));
    await expect(provider().testConnection({ label: 'u', secret: 'candidate-key-123' })).resolves.toEqual({ pickupLocations: [] });
    expect(fetchMock.mock.calls[0][0]).toBe('https://shipway.in/api/authenticateUser');
    fetchMock.mockResolvedValueOnce(reply({ status: 'Error', message: 'Invalid login' }));
    await expect(provider().testConnection({ label: 'u', secret: 'candidate-key-123' })).rejects.toMatchObject({ kind: 'auth' });
  });

  it('makes no request when switched off, and never logs the licence key', async () => {
    const off = provider({ SHIPWAY_DISABLED: 'true' });
    expect(off.disabled()).toBe(true);
    await expect(off.create(ACCOUNT, ORDER)).rejects.toBeInstanceOf(ShipmentError);
    await expect(off.track(ACCOUNT, { awb: 'SWY123456' })).rejects.toMatchObject({ code: 'not_configured' });
    expect(fetchMock).not.toHaveBeenCalled();
    fetchMock.mockResolvedValueOnce(reply({ message: 'secret detail' }, 500));
    await provider().track(ACCOUNT, { awb: 'SWY123456' }).catch(() => undefined);
    const logged = JSON.stringify(errorSpy.mock.calls);
    expect(logged).not.toContain(LICENCE);
    expect(logged).not.toContain('secret detail');
  });
});
