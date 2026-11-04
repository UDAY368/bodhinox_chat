import { describe, expect, it } from 'vitest';

import { deriveTracking, type TrackingEvent } from './derive-tracking';
import type { TrackingStatus } from './types';

const t0 = Date.UTC(2026, 10, 1, 4, 0, 0);
const at = (hour: number) => new Date(t0 + hour * 3_600_000);
const ev = (status: TrackingStatus, hour: number, code: string = status): TrackingEvent => ({ status, providerCode: code, eventAt: at(hour) });

/** Deterministic Fisher-Yates with a seeded LCG (reproducible permutations). */
function shuffled<T>(items: readonly T[], seed: number): T[] {
  const out = [...items];
  let s = seed;
  for (let i = out.length - 1; i > 0; i--) {
    s = (s * 1_103_515_245 + 12_345) % 2_147_483_648;
    const j = s % (i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

describe('deriveTracking', () => {
  it('is empty for no events', () => {
    expect(deriveTracking([])).toEqual({
      status: null, rank: 0, eventAt: null, firstDispatchAt: null, deliveredAt: null, contradictions: [], rto: false, lost: false,
    });
  });

  it('advances along a normal journey and records dispatch and delivery times', () => {
    const d = deriveTracking([ev('awb_assigned', 0), ev('pickup_scheduled', 1), ev('picked_up', 2), ev('in_transit', 5), ev('out_for_delivery', 20), ev('delivered', 23)]);
    expect(d).toMatchObject({ status: 'delivered', rank: 90, firstDispatchAt: at(2), deliveredAt: at(23), eventAt: at(23), contradictions: [], rto: false, lost: false });
  });

  it.each([
    ['a late in_transit after out_for_delivery is ignored', [ev('out_for_delivery', 5), ev('in_transit', 6)], 'out_for_delivery'],
    ['equal rank 50: the later of out_for_delivery / delivery_failed wins', [ev('out_for_delivery', 5), ev('delivery_failed', 6)], 'delivery_failed'],
    ['equal rank 50 the other way round', [ev('delivery_failed', 5), ev('out_for_delivery', 6)], 'out_for_delivery'],
    ['RTO advances past transit', [ev('in_transit', 1), ev('rto_initiated', 2), ev('rto_in_transit', 3)], 'rto_in_transit'],
    ['RTO delivered is terminal', [ev('rto_in_transit', 3), ev('rto_delivered', 4)], 'rto_delivered'],
  ] as const)('%s', (_name, events, status) => {
    expect(deriveTracking(events).status).toBe(status);
  });

  it('a terminal state followed by anything different stays terminal and records a contradiction', () => {
    const d = deriveTracking([ev('in_transit', 1), ev('delivered', 5), ev('rto_initiated', 6), ev('in_transit', 7), ev('delivered', 8, 'again')]);
    expect(d.status).toBe('delivered');
    expect(d.contradictions).toEqual(['rto_initiated', 'in_transit']);
    expect(d.rto).toBe(false);
    expect(d.deliveredAt).toEqual(at(5));
  });

  it('the draft counterexample converges: rto_initiated@t7 arriving before delivered@t6 gives delivered + contradiction', () => {
    const pushes = [ev('in_transit', 1), ev('rto_initiated', 7), ev('delivered', 6)];
    const d = deriveTracking(pushes);
    expect(d.status).toBe('delivered');
    expect(d.contradictions).toEqual(['rto_initiated']);
    expect(deriveTracking([...pushes].reverse())).toEqual(d);
  });

  it('deduplicates repeated scans and drops invalid input', () => {
    const d = deriveTracking([
      ev('delivered', 5), ev('delivered', 5), ev('delivered', 5),
      { status: 'unrecognised' as TrackingStatus, providerCode: 'x', eventAt: at(9) },
      { status: 'in_transit', providerCode: 'y', eventAt: new Date(Number.NaN) },
    ]);
    expect(d).toMatchObject({ status: 'delivered', contradictions: [] });
  });

  it('flags lost, and does not treat RTO or lost as dispatch evidence on their own', () => {
    expect(deriveTracking([ev('awb_assigned', 0), ev('lost', 3)])).toMatchObject({ status: 'lost', lost: true, firstDispatchAt: null });
    expect(deriveTracking([ev('rto_initiated', 3)])).toMatchObject({ rto: true, firstDispatchAt: null });
  });

  it('an accepted correction leaves the terminal state for exactly that status, and later scans continue from it', () => {
    const events = [ev('delivered', 5), ev('rto_in_transit', 6), ev('rto_delivered', 9)];
    expect(deriveTracking(events)).toMatchObject({ status: 'delivered', contradictions: ['rto_in_transit', 'rto_delivered'] });
    expect(deriveTracking(events, { acceptedCorrections: new Set<TrackingStatus>(['rto_in_transit']) }))
      .toMatchObject({ status: 'rto_delivered', contradictions: [], rto: true, deliveredAt: at(5) });
  });

  it('8 scans in 20 random permutations (with duplicates) give an identical result', () => {
    const scans = [ev('awb_assigned', 0), ev('pickup_scheduled', 1), ev('picked_up', 2), ev('in_transit', 4), ev('in_transit', 9, 'transit2'),
      ev('out_for_delivery', 20), ev('delivered', 23), ev('rto_initiated', 30)];
    const expected = deriveTracking(scans);
    expect(expected).toMatchObject({ status: 'delivered', contradictions: ['rto_initiated'], firstDispatchAt: at(2) });
    for (let seed = 1; seed <= 20; seed++) {
      const permuted = shuffled([...scans, ...scans.slice(0, seed % 4)], seed);
      expect(deriveTracking(permuted)).toEqual(expected);
    }
  });

  it('same-instant scans fold in rank order, whatever the arrival order', () => {
    const a = deriveTracking([ev('delivered', 5), ev('out_for_delivery', 5)]);
    const b = deriveTracking([ev('out_for_delivery', 5), ev('delivered', 5)]);
    expect(a).toEqual(b);
    expect(a).toMatchObject({ status: 'delivered', contradictions: [] });
  });
});
