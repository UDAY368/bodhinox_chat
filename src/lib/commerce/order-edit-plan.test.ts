import { describe, expect, it } from 'vitest';
import { allocateRefund, diffOrderLines, paymentDifference, planShipmentItems, shipmentCoverage } from './order-edit-plan';
import { editBalanceReference, editBalanceReferences } from './order-edit-reference';
import { canTransition, isOrderStatus, nextStatuses } from './order-format';
import { buildOrderTimeline } from './order-tracking-timeline';

const V1 = '11111111-1111-4111-8111-111111111111';
const V2 = '22222222-2222-4222-8222-222222222222';
const V3 = '33333333-3333-4333-8333-333333333333';
const line = (id: string, variantId: string | null, quantity: number, shipped = 0) => ({ id, variantId, quantity, shipped });

describe('diffOrderLines', () => {
  const existing = [line('a', V1, 2), line('b', V2, 1)];

  it('reports quantity changes, added and removed lines with their stock delta', () => {
    const diff = diffOrderLines(existing, [{ variantId: V1, qty: 5 }, { variantId: V3, qty: 2 }]);
    expect(diff).toMatchObject({ ok: true });
    if (!diff.ok) return;
    expect(diff.changes).toEqual([
      { variantId: V1, itemId: 'a', before: 2, after: 5, delta: 3 },
      { variantId: V2, itemId: 'b', before: 1, after: 0, delta: -1 },
      { variantId: V3, itemId: null, before: 0, after: 2, delta: 2 },
    ]);
    expect(diff.lines).toEqual([{ variantId: V1, qty: 5 }, { variantId: V3, qty: 2 }]);
  });

  it('refuses an edit that changes nothing, an empty order and malformed lines', () => {
    expect(diffOrderLines(existing, [{ variantId: V2, qty: 1 }, { variantId: V1, qty: 2 }])).toEqual({ ok: false, code: 'no_change' });
    expect(diffOrderLines(existing, [])).toEqual({ ok: false, code: 'cart_empty' });
    expect(diffOrderLines(existing, [{ variantId: V1, qty: 0 }])).toMatchObject({ ok: false, code: 'invalid' });
    expect(diffOrderLines(existing, [{ variantId: V1, qty: 1.5 }])).toMatchObject({ ok: false, code: 'invalid' });
    expect(diffOrderLines(existing, [{ variantId: 'x', qty: 1 }])).toMatchObject({ ok: false, code: 'invalid' });
    expect(diffOrderLines(existing, [{ variantId: V1, qty: 1 }, { variantId: V1, qty: 1 }])).toMatchObject({ ok: false, code: 'invalid' });
    expect(diffOrderLines(existing, [{ variantId: V1, qty: 100 }])).toMatchObject({ ok: false, code: 'invalid' });
  });

  it('never takes a line below what already shipped', () => {
    const shipped = [line('a', V1, 3, 2), line('b', V2, 1, 0)];
    expect(diffOrderLines(shipped, [{ variantId: V1, qty: 1 }, { variantId: V2, qty: 1 }])).toEqual({ ok: false, code: 'below_shipped', variantId: V1 });
    expect(diffOrderLines(shipped, [{ variantId: V2, qty: 1 }])).toEqual({ ok: false, code: 'below_shipped', variantId: V1 });
    expect(diffOrderLines(shipped, [{ variantId: V1, qty: 2 }])).toMatchObject({ ok: true });
  });

  it('refuses an order with a line that has no catalogue variant', () => {
    expect(diffOrderLines([line('a', null, 1)], [{ variantId: V1, qty: 1 }])).toEqual({ ok: false, code: 'not_editable' });
  });
});

describe('paymentDifference', () => {
  it('changes only the total while nothing is paid (unpaid online or cash on delivery)', () => {
    expect(paymentDifference({ paidNetMinor: 0, totalAfterMinor: 50_000 })).toEqual({ action: 'none', differenceMinor: 0 });
  });
  it('collects the rest when a paid order costs more', () => {
    expect(paymentDifference({ paidNetMinor: 100_000, totalAfterMinor: 129_900 })).toEqual({ action: 'collect', differenceMinor: 29_900 });
  });
  it('refunds the surplus when a paid order costs less', () => {
    expect(paymentDifference({ paidNetMinor: 100_000, totalAfterMinor: 40_000 })).toEqual({ action: 'refund', differenceMinor: 60_000 });
  });
  it('does nothing when the total equals what was paid', () => {
    expect(paymentDifference({ paidNetMinor: 100_000, totalAfterMinor: 100_000 })).toEqual({ action: 'none', differenceMinor: 0 });
  });
});

describe('allocateRefund', () => {
  const payments = [{ id: 'p1', refundableMinor: 300, gateway: true }, { id: 'p2', refundableMinor: 500, gateway: false }];
  it('takes from each payment in turn, up to what it can still refund', () => {
    expect(allocateRefund(payments, 200)).toEqual({ ok: true, parts: [{ paymentId: 'p1', amountMinor: 200, gateway: true }] });
    expect(allocateRefund(payments, 450)).toEqual({ ok: true, parts: [
      { paymentId: 'p1', amountMinor: 300, gateway: true }, { paymentId: 'p2', amountMinor: 150, gateway: false }] });
  });
  it('refuses more than the payments hold', () => {
    expect(allocateRefund(payments, 801)).toEqual({ ok: false, code: 'amount_exceeds' });
  });
});

describe('planShipmentItems', () => {
  const lines = [{ id: 'a', quantity: 3, shipped: 0 }, { id: 'b', quantity: 1, shipped: 0 }];

  it('takes everything that remains when no items are named (the single-shipment path)', () => {
    expect(planShipmentItems(lines)).toEqual({ ok: true, complete: true, items: [{ orderItemId: 'a', quantity: 3 }, { orderItemId: 'b', quantity: 1 }] });
    expect(planShipmentItems([{ id: 'a', quantity: 3, shipped: 2 }, { id: 'b', quantity: 1, shipped: 1 }]))
      .toEqual({ ok: true, complete: true, items: [{ orderItemId: 'a', quantity: 1 }] });
  });

  it('accepts a subset and says whether the order is then fully in shipments', () => {
    expect(planShipmentItems(lines, [{ orderItemId: 'a', quantity: 2 }])).toEqual({ ok: true, complete: false, items: [{ orderItemId: 'a', quantity: 2 }] });
    expect(planShipmentItems([{ id: 'a', quantity: 3, shipped: 2 }, { id: 'b', quantity: 1, shipped: 1 }], [{ orderItemId: 'a', quantity: 1 }]))
      .toMatchObject({ ok: true, complete: true });
  });

  it('never ships more of a line than was ordered across all live shipments', () => {
    expect(planShipmentItems(lines, [{ orderItemId: 'a', quantity: 4 }])).toEqual({ ok: false, code: 'over_shipped', orderItemId: 'a' });
    expect(planShipmentItems([{ id: 'a', quantity: 3, shipped: 2 }], [{ orderItemId: 'a', quantity: 2 }])).toEqual({ ok: false, code: 'over_shipped', orderItemId: 'a' });
  });

  it('refuses nothing to ship, unknown lines, repeated lines and bad quantities', () => {
    expect(planShipmentItems([{ id: 'a', quantity: 1, shipped: 1 }])).toEqual({ ok: false, code: 'nothing_to_ship' });
    expect(planShipmentItems(lines, [])).toEqual({ ok: false, code: 'nothing_to_ship' });
    expect(planShipmentItems(lines, [{ orderItemId: 'zz', quantity: 1 }])).toMatchObject({ ok: false, code: 'invalid' });
    expect(planShipmentItems(lines, [{ orderItemId: 'a', quantity: 1 }, { orderItemId: 'a', quantity: 1 }])).toMatchObject({ ok: false, code: 'invalid' });
    expect(planShipmentItems(lines, [{ orderItemId: 'a', quantity: 0 }])).toMatchObject({ ok: false, code: 'invalid' });
    expect(planShipmentItems(lines, [{ orderItemId: 'a', quantity: 1.5 }])).toMatchObject({ ok: false, code: 'invalid' });
  });
});

describe('shipmentCoverage', () => {
  const lines = [{ id: 'a', quantity: 2 }, { id: 'b', quantity: 1 }];
  const parcel = (items: Array<[string, number]> | null, dispatched: boolean, delivered = false) =>
    ({ dispatched, delivered, items: items ? items.map(([orderItemId, quantity]) => ({ orderItemId, quantity })) : null });

  it('is none until a parcel leaves, partial while lines remain, dispatched when all left, delivered when all arrived', () => {
    expect(shipmentCoverage(lines, [parcel([['a', 2]], false)])).toBe('none');
    expect(shipmentCoverage(lines, [parcel([['a', 2]], true)])).toBe('partial');
    expect(shipmentCoverage(lines, [parcel([['a', 2]], true), parcel([['b', 1]], false)])).toBe('partial');
    expect(shipmentCoverage(lines, [parcel([['a', 2]], true), parcel([['b', 1]], true)])).toBe('dispatched');
    expect(shipmentCoverage(lines, [parcel([['a', 2]], true, true), parcel([['b', 1]], true)])).toBe('dispatched');
    expect(shipmentCoverage(lines, [parcel([['a', 1]], true, true), parcel([['a', 1], ['b', 1]], true, true)])).toBe('delivered');
  });

  it('treats a shipment with no item rows as the whole order', () => {
    expect(shipmentCoverage(lines, [parcel(null, true)])).toBe('dispatched');
    expect(shipmentCoverage(lines, [parcel(null, true, true)])).toBe('delivered');
  });
});

describe('partially shipped status', () => {
  it('is a status staff cannot set by hand, and from it only the rest can be recorded as dispatched', () => {
    expect(isOrderStatus('partially_shipped')).toBe(true);
    expect(canTransition('paid', 'partially_shipped')).toBe(false);
    expect(canTransition('confirmed', 'partially_shipped', { unpaidCod: true })).toBe(false);
    expect(nextStatuses('partially_shipped')).toEqual(['dispatched']);
  });

  it('shows the buyer the order as shipped, never delivered from one parcel', () => {
    const steps = buildOrderTimeline({ status: 'partially_shipped', createdAt: new Date('2026-11-01T00:00:00Z'), shipmentStatus: 'delivered' });
    expect(steps.map((s) => `${s.key}:${s.state}`)).toEqual(['placed:done', 'confirmed:done', 'shipped:current', 'out_for_delivery:upcoming', 'delivered:upcoming']);
  });
});

describe('balance link references', () => {
  it('are stable per edit and attempt, distinct across them, and in the checkout reference family', () => {
    const id = '44444444-4444-4444-8444-444444444444';
    expect(editBalanceReference(id, 1)).toBe(editBalanceReference(id, 1));
    expect(new Set(editBalanceReferences(id)).size).toBe(5);
    expect(editBalanceReference(id, 1)).not.toBe(editBalanceReference(V1, 1));
    for (const ref of editBalanceReferences(id)) expect(ref).toMatch(/^co_[A-Za-z0-9_-]{16,40}$/);
  });
});
