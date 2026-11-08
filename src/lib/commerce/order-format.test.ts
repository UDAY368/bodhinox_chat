import { describe, expect, it } from 'vitest';
import {
  asOrderMessagePayload, canTransition, fillOrderPlaceholders, fulfilmentEvidence, isUnpaidCod, orderContentText, orderFlowVars, orderItemsSummary,
  nextStatuses, ORDER_STATUSES, ORDER_TRANSITIONS, parseInboundOrder, WORKER_ONLY_STATUSES,
} from './order-format';

const item = (over: Record<string, unknown> = {}) => ({ product_retailer_id: 'SKU-1', quantity: 2, item_price: 499.5, currency: 'INR', ...over });

describe('parseInboundOrder', () => {
  it('stores prices exactly in minor units and totals the cart', () => {
    const order = parseInboundOrder({ catalog_id: '123456', text: '  Gift wrap please ', product_items: [item(), item({ product_retailer_id: 'CAP', quantity: '1', item_price: '100' })] });
    expect(order).toEqual({
      catalog_id: '123456', currency: 'INR', subtotal_minor: 2 * 49950 + 10000, note: 'Gift wrap please',
      items: [
        { retailer_id: 'SKU-1', name: null, quantity: 2, unit_price_minor: 49950 },
        { retailer_id: 'CAP', name: null, quantity: 1, unit_price_minor: 10000 },
      ],
    });
  });

  it('accepts trailing zeros beyond the currency decimals and handles zero-decimal currencies', () => {
    expect(parseInboundOrder({ product_items: [item({ currency: 'JPY', item_price: '1200.00' })] })?.subtotal_minor).toBe(2400);
    expect(parseInboundOrder({ product_items: [item({ currency: 'jpy', item_price: 1200 })] })?.currency).toBe('JPY');
  });

  it.each([
    ['no items', { product_items: [] }],
    ['not an object', 'order'],
    ['mixed currencies', { product_items: [item(), item({ currency: 'USD' })] }],
    ['a fractional quantity', { product_items: [item({ quantity: 1.5 })] }],
    ['a zero quantity', { product_items: [item({ quantity: 0 })] }],
    ['a negative price', { product_items: [item({ item_price: -1 })] }],
    ['an exponent price', { product_items: [item({ item_price: '1e3' })] }],
    ['too many decimals', { product_items: [item({ item_price: '1.234' })] }],
    ['a bad currency', { product_items: [item({ currency: 'RUPEES' })] }],
    ['a missing retailer id', { product_items: [item({ product_retailer_id: '' })] }],
    ['a control character in the retailer id', { product_items: [item({ product_retailer_id: 'a\u0000b' })] }],
    ['more than 100 lines', { product_items: Array.from({ length: 101 }, () => item()) }],
    ['a total beyond a safe integer', { product_items: [item({ item_price: '90071992547409.91', quantity: 100000 })] }],
  ])('rejects %s', (_label, raw) => {
    expect(parseInboundOrder(raw)).toBeNull();
  });

  it('drops a catalog id that is not Meta-shaped and caps the note', () => {
    const order = parseInboundOrder({ catalog_id: 'x; drop', text: 'n'.repeat(5000), product_items: [item()] });
    expect(order?.catalog_id).toBeNull();
    expect(order?.note).toHaveLength(2000);
  });
});

describe('order text and variables', () => {
  const order = { order_id: 'b7c1c1a2-0000-4000-8000-000000000001', catalog_id: null, currency: 'INR', subtotal_minor: 109900, note: null,
    items: [{ retailer_id: 'SKU-1', name: 'Blue shirt', quantity: 2, unit_price_minor: 49950 }, { retailer_id: 'CAP', name: null, quantity: 1, unit_price_minor: 10000 }] };

  it('summarises items using the catalogue name or the retailer id', () => {
    expect(orderItemsSummary(order.items)).toBe('2 × Blue shirt, 1 × CAP');
    expect(orderItemsSummary(order.items, 10)).toHaveLength(10);
    expect(orderContentText(order)).toBe('[Order] 2 × Blue shirt, 1 × CAP — ₹1,099.00');
  });

  it('sets the order_received flow variables', () => {
    expect(orderFlowVars(order)).toEqual({
      order_id: order.order_id, order_total: '₹1,099.00', order_total_minor: '109900', order_currency: 'INR', order_items_count: '3', order_items: '2 × Blue shirt, 1 × CAP',
    });
  });

  it('reads a stored payload back and rejects malformed ones', () => {
    expect(asOrderMessagePayload(order)).toEqual(order);
    expect(asOrderMessagePayload({ ...order, subtotal_minor: 1.5 })).toBeNull();
    expect(asOrderMessagePayload({ ...order, currency: 'inr' })).toBeNull();
    expect(asOrderMessagePayload(null)).toBeNull();
  });

  it('fills known placeholders only', () => {
    expect(fillOrderPlaceholders('Thanks {{ customer_name }}! Total {{order_total}} {{unknown}}', { customer_name: 'Asha', order_total: '₹10.00' }))
      .toBe('Thanks Asha! Total ₹10.00 {{unknown}}');
  });
});

describe('status transitions', () => {
  it('keeps fulfilled and cancelled final and never allows a no-op or backwards move to new', () => {
    expect(ORDER_TRANSITIONS.fulfilled).toEqual([]);
    expect(ORDER_TRANSITIONS.cancelled).toEqual([]);
    for (const from of ORDER_STATUSES) {
      expect(canTransition(from, from)).toBe(false);
      expect(canTransition(from, 'new')).toBe(false);
    }
    expect(canTransition('paid', 'awaiting_payment')).toBe(false);
  });

  it('never lets staff set a worker-only status (no manual "paid")', () => {
    for (const from of ORDER_STATUSES)
      for (const to of WORKER_ONLY_STATUSES) expect(canTransition(from, to)).toBe(false);
    for (const from of ['payment_review', 'expired', 'fulfilled', 'cancelled'] as const) expect(nextStatuses(from)).toEqual([]);
  });

  it('dispatches and delivers a priced order only after payment; legacy orders keep confirmed -> fulfilled', () => {
    expect(canTransition('paid', 'dispatched', { priced: true })).toBe(true);
    expect(canTransition('dispatched', 'fulfilled', { priced: true })).toBe(true);
    expect(canTransition('confirmed', 'fulfilled', { priced: true })).toBe(false);
    expect(canTransition('new', 'awaiting_payment', { priced: true })).toBe(false);
    expect(canTransition('confirmed', 'fulfilled')).toBe(true);
    expect(canTransition('awaiting_payment', 'cancelled', { priced: true })).toBe(true);
    expect(nextStatuses('confirmed', { priced: true })).toEqual(['cancelled']);
  });

  it('ships an unpaid cash-on-delivery order before payment and cancels a refused parcel (return to origin)', () => {
    const cod = { priced: true, unpaidCod: true };
    expect(nextStatuses('confirmed', cod)).toEqual(['dispatched', 'fulfilled', 'cancelled']);
    expect(nextStatuses('dispatched', cod)).toEqual(['fulfilled', 'cancelled']);
    // Not for online orders, a paid COD order, or a COD order moved back to awaiting payment.
    expect(canTransition('confirmed', 'dispatched', { priced: true })).toBe(false);
    expect(canTransition('dispatched', 'cancelled', { priced: true })).toBe(false);
    expect(nextStatuses('dispatched', { priced: true })).toEqual(['fulfilled']);
    expect(canTransition('confirmed', 'awaiting_payment', cod)).toBe(false);
    expect(isUnpaidCod({ payment_method: 'cod', paid_at: null })).toBe(true);
    expect(isUnpaidCod({ payment_method: 'cod', paid_at: '2026-11-14T00:00:00Z' })).toBe(false);
    expect(isUnpaidCod({ payment_method: 'online', paid_at: null })).toBe(false);
  });
});

describe('fulfilmentEvidence (Phase 9 evidence label)', () => {
  const ship = (dispatched: string | null, delivered: string | null) => ({ provider_dispatched_at: dispatched, provider_delivered_at: delivered });
  it('is provider only when Shiprocket confirmed that step, staff when a member recorded it, unknown otherwise', () => {
    expect(fulfilmentEvidence({ status: 'fulfilled', fulfilment_recorded: true }, ship('2026-11-01T00:00:00Z', '2026-11-02T00:00:00Z'))).toBe('provider');
    expect(fulfilmentEvidence({ status: 'fulfilled', fulfilment_recorded: true }, ship('2026-11-01T00:00:00Z', null))).toBe('staff');
    expect(fulfilmentEvidence({ status: 'fulfilled', fulfilment_recorded: false }, null)).toBe('unknown');
    expect(fulfilmentEvidence({ status: 'dispatched', fulfilment_recorded: false }, ship('2026-11-01T00:00:00Z', null))).toBe('provider');
    expect(fulfilmentEvidence({ status: 'dispatched', fulfilment_recorded: true }, ship(null, null))).toBe('staff');
  });
  it('is null before dispatch', () => {
    for (const status of ['new', 'paid', 'cancelled', 'awaiting_payment'] as const)
      expect(fulfilmentEvidence({ status, fulfilment_recorded: true }, ship('2026-11-01T00:00:00Z', '2026-11-02T00:00:00Z'))).toBeNull();
  });
});
