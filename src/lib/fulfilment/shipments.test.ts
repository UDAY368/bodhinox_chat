import { describe, expect, it } from 'vitest';
import { parsePickupLocations, validDims } from './connection';
import {
  findByReference, newShipmentReference, parseAdhocCreate, parseAwbAssign, parseOrderShow, shippableAddress,
} from './shipments';

const ADDRESS = { name: 'Asha Rao', phone: '+91 98765 43210', line1: '12 MG Road', line2: null, city: 'Bengaluru', state: 'Karnataka',
  state_code: 'KA', postal_code: '560001', country: 'IN', instructions: null };

describe('shipment references', () => {
  it('fit the database CHECK and do not repeat', () => {
    const refs = new Set(Array.from({ length: 500 }, () => newShipmentReference()));
    expect(refs.size).toBe(500);
    for (const r of refs) expect(r).toMatch(/^bx[a-z0-9]{12}$/);
  });
});

describe('shippableAddress', () => {
  it('accepts an Indian address with state, PIN and a mobile number', () => {
    expect(shippableAddress(ADDRESS)).toMatchObject({ phone: '9876543210', state: 'Karnataka', postal_code: '560001', country: 'IN' });
    expect(shippableAddress({ ...ADDRESS, phone: '09876543210' })?.phone).toBe('9876543210');
  });
  it('refuses anything that cannot ship within India', () => {
    for (const bad of [null, 'x', [], { ...ADDRESS, country: 'US' }, { ...ADDRESS, state: '' }, { ...ADDRESS, state: null },
      { ...ADDRESS, postal_code: '12345' }, { ...ADDRESS, phone: '12345' }, { ...ADDRESS, line1: '' }, { ...ADDRESS, city: null }]) {
      expect(shippableAddress(bad)).toBeNull();
    }
  });
});

describe('Shiprocket response parsers', () => {
  it('reads the adhoc create ids only when both are numeric', () => {
    expect(parseAdhocCreate({ order_id: 123, shipment_id: '456' })).toEqual({ srOrderId: '123', srShipmentId: '456' });
    expect(parseAdhocCreate({ order_id: 123 })).toBeNull();
    expect(parseAdhocCreate({ order_id: 'abc', shipment_id: 1 })).toBeNull();
    expect(parseAdhocCreate(null)).toBeNull();
  });

  it('reads an AWB, an explicit refusal, or nothing', () => {
    expect(parseAwbAssign({ awb_assign_status: 1, response: { data: { awb_code: '1234567890', courier_name: 'Delhivery' } } }))
      .toEqual({ kind: 'assigned', awb: '1234567890', courier: 'Delhivery' });
    expect(parseAwbAssign({ awb_assign_status: 0, response: { data: { awb_assign_error: 'x' } } })).toEqual({ kind: 'refused' });
    expect(parseAwbAssign({ status: 'ok' })).toBeNull();
    expect(parseAwbAssign({ response: { data: { awb_code: 'bad awb!' } } })).toBeNull();
  });

  it('adopts only the exact reference, never a near match', () => {
    const body = { data: [
      { id: 1, channel_order_id: 'bxaaaaaaaaaaaab', shipments: [{ id: 2 }] },
      { id: 3, channel_order_id: 'bxaaaaaaaaaaaa', shipments: [{ id: 4, awb: 'AWB1234' , courier: 'Bluedart' }] },
    ] };
    expect(findByReference(body, 'bxaaaaaaaaaaaa')).toEqual({ srOrderId: '3', srShipmentId: '4', awb: 'AWB1234', courier: 'Bluedart' });
    expect(findByReference(body, 'bxzzzzzzzzzzzz')).toBeNull();
    expect(findByReference({ data: 'nope' }, 'bxaaaaaaaaaaaa')).toBeNull();
  });

  it('reads an order detail only for the expected order', () => {
    const body = { data: { id: 77, shipments: { id: 78, awb: 'SR123456' }, awb_data: {} } };
    expect(parseOrderShow(body, '77')).toMatchObject({ srShipmentId: '78', awb: 'SR123456' });
    expect(parseOrderShow(body, '76')).toBeNull();
    expect(parseOrderShow({ data: { id: 77, awb_data: { awb: 'X9876' } } }, '77')?.awb).toBe('X9876');
  });

  it('lists pickup location names', () => {
    expect(parsePickupLocations({ data: { shipping_address: [{ pickup_location: 'Primary' }, { pickup_location: 'Primary' }, { other: 1 }, null] } }))
      .toEqual(['Primary']);
    expect(parsePickupLocations({})).toEqual([]);
  });
});

describe('validDims', () => {
  it('rounds centimetres to one decimal and requires integer grams', () => {
    expect(validDims({ length_cm: 10.04, breadth_cm: 5, height_cm: 300, weight_grams: 1 }, true))
      .toEqual({ length_cm: 10, breadth_cm: 5, height_cm: 300, weight_grams: 1 });
    expect(validDims({}, false)).toEqual({});
    for (const bad of [{ length_cm: 0 }, { length_cm: 301 }, { weight_grams: 1.5 }, { weight_grams: 100001 }, { height_cm: Number.NaN },
      { length_cm: 0.01 }]) {
      expect(() => validDims(bad, false)).toThrow();
    }
    expect(() => validDims({ length_cm: 1 }, true)).toThrow();
  });
});
