import { describe, expect, it } from 'vitest';

import {
  isTrackingStatus, normalizeShiprocket, parseShiprocketTime, resolutionsFor, SHIPROCKET_CODE_MAP, TERMINAL_TRACKING_STATUSES, TRACKING_RANK,
} from './status-map';
import { SHIPMENT_EXCEPTION_KINDS, TRACKING_STATUSES } from './types';

describe('normalizeShiprocket', () => {
  it.each([
    [7, null, 'delivered'],
    ['7', null, 'delivered'],
    [18, 'IN TRANSIT', 'in_transit'],
    [42, null, 'picked_up'],
    [17, null, 'out_for_delivery'],
    [21, null, 'delivery_failed'],
    [9, null, 'rto_initiated'],
    [46, null, 'rto_in_transit'],
    [10, null, 'rto_delivered'],
    [8, null, 'cancelled'],
    [12, null, 'lost'],
    [25, null, 'lost'],
  ] as const)('maps code %j (%j) to %s', (code, label, status) => {
    expect(normalizeShiprocket(code, label)).toBe(status);
  });

  it('prefers the code over the label and falls back to the label', () => {
    expect(normalizeShiprocket(7, 'IN TRANSIT')).toBe('delivered');
    expect(normalizeShiprocket(null, 'Out For Delivery')).toBe('out_for_delivery');
    expect(normalizeShiprocket(9999, 'rto_delivered')).toBe('rto_delivered');
    expect(normalizeShiprocket('', ' picked   up ')).toBe('picked_up');
  });

  it('never guesses: unknown, unmapped (NA), ambiguous and hostile values are unrecognised', () => {
    for (const [code, label] of [
      [null, null], [undefined, undefined], [999, 'NA'], [null, 'NA'], [20, 'PICKUP EXCEPTION'], [23, 'PARTIAL_DELIVERED'],
      [16, 'CANCELLATION REQUESTED'], [null, 'constructor'], [null, '__proto__'], ['7; DROP', null], [null, 'x'.repeat(200)], [7.5, null],
    ] as const) expect(normalizeShiprocket(code, label)).toBe('unrecognised');
  });

  it('only maps into the normalised set', () => {
    for (const status of Object.values(SHIPROCKET_CODE_MAP)) expect(TRACKING_STATUSES).toContain(status);
  });
});

describe('ranks', () => {
  it('orders the normalised set as designed, with four terminal states', () => {
    expect(Object.keys(TRACKING_RANK).sort()).toEqual([...TRACKING_STATUSES].sort());
    expect(TRACKING_RANK.created).toBeLessThan(TRACKING_RANK.awb_assigned);
    expect(TRACKING_RANK.picked_up).toBe(30);
    expect(TRACKING_RANK.out_for_delivery).toBe(TRACKING_RANK.delivery_failed);
    expect([...TERMINAL_TRACKING_STATUSES].sort()).toEqual(['cancelled', 'delivered', 'lost', 'rto_delivered']);
  });
});

describe('parseShiprocketTime (Asia/Kolkata, both formats)', () => {
  it('reads the push format DD MM YYYY HH:mm:ss as IST', () => {
    expect(parseShiprocketTime('23 05 2023 11:43:52')?.toISOString()).toBe('2023-05-23T06:13:52.000Z');
  });

  it('reads the scan format YYYY-MM-DD HH:mm:ss as IST, seconds optional', () => {
    expect(parseShiprocketTime('2023-05-23 00:10:00')?.toISOString()).toBe('2023-05-22T18:40:00.000Z');
    expect(parseShiprocketTime('2023-05-23 00:10')?.toISOString()).toBe('2023-05-22T18:40:00.000Z');
  });

  it('refuses anything else, including impossible dates', () => {
    for (const v of [null, undefined, '', 'yesterday', '2023-02-31 10:00:00', '31 02 2023 10:00:00', '2023-05-23T00:10:00Z',
      '2023-13-01 00:00:00', '1999-01-01 00:00:00', '2023-05-23 24:00:00', 'x'.repeat(100)])
      expect(parseShiprocketTime(v)).toBeNull();
  });
});

describe('exception helpers', () => {
  it('offers accept_correction for contradictions only and recreate for ambiguous creates and lost parcels only', () => {
    for (const kind of SHIPMENT_EXCEPTION_KINDS) {
      const options = resolutionsFor(kind);
      expect(options).toContain('dismiss');
      expect(options.includes('accept_correction')).toBe(kind === 'contradiction');
      expect(options.includes('recreate')).toBe(kind === 'create_unknown' || kind === 'awb_unknown' || kind === 'lost_or_damaged');
    }
    expect(isTrackingStatus('delivered')).toBe(true);
    expect(isTrackingStatus('unrecognised')).toBe(false);
  });
});
