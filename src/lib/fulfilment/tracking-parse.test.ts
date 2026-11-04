import { describe, expect, it, vi } from 'vitest';

// Pure parsers only: no database, no provider call.
vi.mock('@/lib/db/prisma', () => ({ getWorkerPrisma: () => { throw new Error('no database in unit tests'); } }));

import { minimiseShiprocketPush, parseTrackingResponse } from './tracking-job';

const AWB = '19041424751540';

const response = {
  tracking_data: {
    track_status: 1,
    shipment_status: 7,
    shipment_track: [{ awb_code: AWB, current_status: 'Delivered', delivered_date: '2023-05-24 15:20:00', destination: 'Pune', consignee_name: 'Asha' }],
    shipment_track_activities: [
      { date: '2023-05-24 15:20:00', status: 'DLVD', activity: 'Delivered to Asha', location: 'Pune', 'sr-status': '7', 'sr-status-label': 'DELIVERED' },
      { date: '2023-05-24 09:00:00', status: 'OFD', activity: 'Out for delivery', location: 'Pune', 'sr-status': 17, 'sr-status-label': 'OUT FOR DELIVERY' },
      { date: '2023-05-23 00:10:00', status: 'X-PPOM', activity: 'In transit', location: 'Mumbai', 'sr-status': '18', 'sr-status-label': 'IN TRANSIT' },
      { date: '2023-05-22 18:00:00', status: 'X', activity: 'Manifested', location: 'Mumbai', 'sr-status': 'NA', 'sr-status-label': 'NA' },
      { date: 'garbage', 'sr-status': '42', 'sr-status-label': 'PICKED UP' },
    ],
    track_url: 'https://shiprocket.co/tracking/19041424751540',
  },
};

describe('parseTrackingResponse', () => {
  it('keeps status, provider code and IST time only; drops NA and undated scans', () => {
    const events = parseTrackingResponse(response, AWB);
    expect(events).toEqual([
      { status: 'delivered', providerCode: '7', eventAt: new Date('2023-05-24T09:50:00.000Z') },
      { status: 'out_for_delivery', providerCode: '17', eventAt: new Date('2023-05-24T03:30:00.000Z') },
      { status: 'in_transit', providerCode: '18', eventAt: new Date('2023-05-22T18:40:00.000Z') },
      // The delivered_date entry duplicates the delivered scan (same code and time; the fold deduplicates it).
      { status: 'delivered', providerCode: '7', eventAt: new Date('2023-05-24T09:50:00.000Z') },
    ]);
    expect(JSON.stringify(events)).not.toMatch(/Asha|Pune|Mumbai|Delivered to/);
  });

  it('reads the AWB-keyed and array shapes and ignores anything else', () => {
    expect(parseTrackingResponse({ [AWB]: response }, AWB)).toHaveLength(4);
    expect(parseTrackingResponse([{ [AWB]: response }], AWB)).toHaveLength(4);
    for (const body of [null, 'x', 42, {}, { tracking_data: 'x' }, { other: response }, { tracking_data: { shipment_track_activities: 'x' } }])
      expect(parseTrackingResponse(body, AWB)).toEqual([]);
  });

  it('uses a label code when the scan has no numeric sr-status', () => {
    const events = parseTrackingResponse({ tracking_data: { shipment_track_activities: [{ date: '2023-05-23 10:00:00', 'sr-status-label': 'Picked Up' }] } }, AWB);
    expect(events).toEqual([{ status: 'picked_up', providerCode: 'label_picked_up', eventAt: new Date('2023-05-23T04:30:00.000Z') }]);
  });
});

describe('minimiseShiprocketPush', () => {
  it('keeps awb, the shipment status code and the timestamp only', () => {
    const push = {
      awb: AWB, courier_name: 'Delhivery', current_status: 'IN TRANSIT', current_status_id: 20, shipment_status: 'IN TRANSIT',
      shipment_status_id: 18, current_timestamp: '23 05 2023 11:43:52', order_id: '1373900_150876814', sr_order_id: 348456385,
      awb_assigned_date: '2023-05-19 11:59:16', pickup_scheduled_date: '2023-05-19 11:59:17', etd: '2023-05-23 15:40:19',
      scans: [{ date: '2023-05-19 11:59:16', status: 'X-UCI', activity: 'Manifested', location: 'Mumbai_Chndivli_PC (Maharashtra)', 'sr-status': '5' }],
      is_return: 0, channel_id: 3422553, pod_status: '', pod: 'Not Available', customer_name: 'Asha', customer_phone: '9999999999',
    };
    expect(minimiseShiprocketPush(push)).toEqual({ awb: AWB, code: '18', ts: '23 05 2023 11:43:52' });
  });

  it('falls back to current_status_id and refuses a bad AWB', () => {
    expect(minimiseShiprocketPush({ awb: 12345678, current_status_id: '6' })).toEqual({ awb: '12345678', code: '6', ts: null });
    for (const body of [null, [], 'x', {}, { awb: 'a b' }, { awb: '<script>' }, { awb: 'x'.repeat(41) }])
      expect(minimiseShiprocketPush(body)).toBeNull();
    expect(minimiseShiprocketPush({ awb: AWB, shipment_status_id: 'DROP', current_timestamp: '<b>' })).toEqual({ awb: AWB, code: null, ts: null });
  });
});
