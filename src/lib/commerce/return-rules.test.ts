import { describe, expect, it } from 'vitest';
import { buyerReturnEligibility, exchangeMap, lineStandings, parseBuyerReturn, returnWindowOpen } from './return-rules';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const V = '33333333-3333-4333-8333-333333333333';
const REQ = '44444444-4444-4444-8444-444444444444';
const NOW = new Date('2026-12-10T12:00:00Z');
const day = (n: number) => new Date(NOW.getTime() - n * 86_400_000);

describe('return window and eligibility', () => {
  const facts = { enabled: true, status: 'fulfilled', unpaidCod: false, deliveredAt: day(3), windowDays: 7, now: NOW };
  it('is open within the window and at its last moment, closed after', () => {
    expect(buyerReturnEligibility(facts)).toBeNull();
    expect(buyerReturnEligibility({ ...facts, deliveredAt: day(7) })).toBeNull();
    expect(buyerReturnEligibility({ ...facts, deliveredAt: new Date(NOW.getTime() - 7 * 86_400_000 - 1) })).toBe('return_window_closed');
    expect(buyerReturnEligibility({ ...facts, deliveredAt: day(30) })).toBe('return_window_closed');
  });
  it('a window of 0 days means no returns once delivered, but a parcel still in transit is open', () => {
    expect(buyerReturnEligibility({ ...facts, windowDays: 0 })).toBe('return_window_closed');
    expect(buyerReturnEligibility({ ...facts, status: 'dispatched', deliveredAt: null, windowDays: 0 })).toBeNull();
    expect(returnWindowOpen(null, 0, NOW)).toBe(true);
  });
  it('is refused when the shop does not offer it, the order has not left, or it is unpaid cash on delivery', () => {
    expect(buyerReturnEligibility({ ...facts, enabled: false })).toBe('returns_unavailable');
    for (const status of ['awaiting_payment', 'paid', 'confirmed', 'cancelled', 'expired', 'new']) {
      expect(buyerReturnEligibility({ ...facts, status, deliveredAt: null })).toBe('returns_unavailable');
    }
    expect(buyerReturnEligibility({ ...facts, status: 'dispatched', deliveredAt: null, unpaidCod: true })).toBe('returns_unavailable');
  });
});

describe('one open request per order line', () => {
  const ordered = [{ id: A, quantity: 3 }, { id: B, quantity: 1 }];
  it('an untouched line is fully available', () => {
    expect(lineStandings(ordered, []).get(A)).toEqual({ ordered: 3, remaining: 3, open: false });
  });
  it('an open request (requested, received or inspected) holds the line and its units', () => {
    for (const status of ['requested', 'received', 'inspected']) {
      expect(lineStandings(ordered, [{ status, items: [{ order_item_id: A, qty: 2 }] }]).get(A)).toEqual({ ordered: 3, remaining: 1, open: true });
    }
  });
  it('a closed return keeps its units taken but no longer holds the line; a rejected one frees everything', () => {
    expect(lineStandings(ordered, [{ status: 'closed', items: [{ order_item_id: A, qty: 2 }] }]).get(A)).toEqual({ ordered: 3, remaining: 1, open: false });
    expect(lineStandings(ordered, [{ status: 'rejected', items: [{ order_item_id: A, qty: 3 }] }]).get(A)).toEqual({ ordered: 3, remaining: 3, open: false });
  });
  it('requests on other lines and unknown lines do not matter', () => {
    const s = lineStandings(ordered, [{ status: 'requested', items: [{ order_item_id: B, qty: 1 }, { order_item_id: '55555555-5555-4555-8555-555555555555', qty: 9 }] }]);
    expect(s.get(A)!.open).toBe(false);
    expect(s.get(B)).toEqual({ ordered: 1, remaining: 0, open: true });
  });
});

describe('parseBuyerReturn', () => {
  const body = { clientRequestId: REQ, reason: 'damaged', note: ' arrived broken ', lines: [{ order_item_id: A, qty: 1 }, { order_item_id: B, qty: 2, exchange_variant_id: V }] };
  it('accepts a request and normalises it', () => {
    const parsed = parseBuyerReturn(body);
    expect(parsed).toEqual({
      clientRequestId: REQ, reason: 'damaged', note: 'arrived broken',
      lines: [{ order_item_id: A, qty: 1, exchange_variant_id: null }, { order_item_id: B, qty: 2, exchange_variant_id: V }],
    });
    expect(exchangeMap(parsed.lines)).toEqual({ [B]: V });
    expect(exchangeMap([{ order_item_id: A, qty: 1, exchange_variant_id: null }])).toBeNull();
  });
  it.each([
    ['no request id', { ...body, clientRequestId: 'nope' }],
    ['an unknown reason', { ...body, reason: 'because' }],
    ['no lines', { ...body, lines: [] }],
    ['a repeated line', { ...body, lines: [{ order_item_id: A, qty: 1 }, { order_item_id: A, qty: 1 }] }],
    ['a zero quantity', { ...body, lines: [{ order_item_id: A, qty: 0 }] }],
    ['a fractional quantity', { ...body, lines: [{ order_item_id: A, qty: 1.5 }] }],
    ['a bad exchange id', { ...body, lines: [{ order_item_id: A, qty: 1, exchange_variant_id: 'x' }] }],
    ['a long note', { ...body, note: 'x'.repeat(301) }],
    ['too many lines', { ...body, lines: Array.from({ length: 51 }, (_, i) => ({ order_item_id: `${String(i).padStart(8, '0')}-1111-4111-8111-111111111111`, qty: 1 })) }],
  ])('refuses %s', (_name, input) => {
    expect(() => parseBuyerReturn(input)).toThrow(expect.objectContaining({ code: 'invalid' }));
  });
});
