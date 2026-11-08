import { describe, expect, it } from 'vitest';
import { orderDue, orderSettlementPlan } from './settle';
import { allowedResolutions } from './exceptions';
import { stableUuid } from './ledger';

const order = (status: string, extra: Partial<{ total_minor: number | null; subtotal_minor: number; amount_paid_minor: number; currency: string;
  payment_method: string; paid_at: Date | null }> = {}) => ({
  status, currency: 'INR', total_minor: 10_000, subtotal_minor: 10_000, amount_paid_minor: 0, ...extra,
});
const pay = (amountMinor = 10_000, currency = 'INR') => ({ amountMinor, currency });

describe('orderSettlementPlan (design E9)', () => {
  it('credits exactly the amount due on an order still taking payment', () => {
    for (const status of ['new', 'confirmed', 'awaiting_payment']) expect(orderSettlementPlan(order(status), pay())).toBe('credit');
    expect(orderSettlementPlan(order('expired'), pay())).toBe('late');
  });

  it('computes the due at settle time from the order itself', () => {
    expect(orderDue(order('awaiting_payment', { amount_paid_minor: 4_000 }))).toBe(6_000);
    // A legacy cart without a total is due its subtotal.
    expect(orderDue(order('new', { total_minor: null, subtotal_minor: 2_500 }))).toBe(2_500);
    expect(orderSettlementPlan(order('awaiting_payment', { amount_paid_minor: 4_000 }), pay(6_000))).toBe('credit');
    expect(orderSettlementPlan(order('awaiting_payment', { amount_paid_minor: 4_000 }), pay(10_000))).toBe('amount_mismatch');
    expect(orderSettlementPlan(order('awaiting_payment'), pay(9_999))).toBe('amount_mismatch');
    expect(orderSettlementPlan(order('awaiting_payment', { amount_paid_minor: 10_000 }), pay())).toBe('duplicate_payment');
  });

  it('credits the cash of a cash-on-delivery order once shipped, but never twice', () => {
    for (const status of ['confirmed', 'dispatched', 'fulfilled'])
      expect(orderSettlementPlan(order(status, { payment_method: 'cod', paid_at: null }), pay())).toBe('credit');
    const paidAt = new Date('2026-11-14T00:00:00Z');
    expect(orderSettlementPlan(order('dispatched', { payment_method: 'cod', paid_at: paidAt, amount_paid_minor: 10_000 }), pay())).toBe('duplicate_payment');
    expect(orderSettlementPlan(order('dispatched', { payment_method: 'online', paid_at: null }), pay())).toBe('duplicate_payment');
    expect(orderSettlementPlan(order('dispatched', { payment_method: 'cod', paid_at: null }), pay(9_000))).toBe('amount_mismatch');
  });

  it('never credits a closed, paid or foreign-currency order', () => {
    expect(orderSettlementPlan(order('cancelled'), pay())).toBe('payment_on_closed_order');
    for (const status of ['paid', 'dispatched', 'fulfilled', 'payment_review']) expect(orderSettlementPlan(order(status), pay())).toBe('duplicate_payment');
    expect(orderSettlementPlan(order('awaiting_payment'), pay(10_000, 'USD'))).toBe('currency_mismatch');
  });
});

describe('exception resolutions', () => {
  it('closes held money only by refund, or restock for a late payment without stock', () => {
    expect(allowedResolutions('late_payment_no_stock')).toEqual(['refunded', 'restocked']);
    for (const kind of ['late_payment_slot_lost', 'payment_on_closed_order', 'duplicate_payment', 'amount_mismatch', 'currency_mismatch'] as const)
      expect(allowedResolutions(kind)).toEqual(['refunded']);
    for (const kind of ['merchant_changed', 'payment_unmatched', 'refund_unknown', 'refund_failed'] as const) expect(allowedResolutions(kind)).toEqual(['dismissed']);
  });
});

describe('stableUuid', () => {
  it('maps one request to one uuid-shaped id', () => {
    const id = stableUuid('refund:a:b:c');
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(stableUuid('refund:a:b:c')).toBe(id);
    expect(stableUuid('refund:a:b:d')).not.toBe(id);
  });
});
