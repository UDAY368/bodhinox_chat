import { describe, expect, it } from 'vitest';
import { canRecordPayment, selectableStatuses } from './order-detail';

describe('selectableStatuses', () => {
  it('never offers paid, and leaves dispatch, delivery and paid cancellation to their own actions', () => {
    expect(selectableStatuses({ status: 'new', priced_at: null })).toEqual(['confirmed', 'awaiting_payment', 'cancelled']);
    expect(selectableStatuses({ status: 'confirmed', priced_at: null })).toEqual(['awaiting_payment', 'cancelled']);
    expect(selectableStatuses({ status: 'awaiting_payment', priced_at: '2026-11-03T00:00:00Z' })).toEqual(['cancelled']);
    expect(selectableStatuses({ status: 'paid', priced_at: '2026-11-03T00:00:00Z' })).toEqual([]);
    expect(selectableStatuses({ status: 'dispatched', priced_at: '2026-11-03T00:00:00Z' })).toEqual([]);
    for (const status of ['new', 'confirmed', 'awaiting_payment', 'paid', 'dispatched'] as const)
      expect(selectableStatuses({ status, priced_at: null })).not.toContain('paid');
  });

  it('lets an unpaid cash-on-delivery order be cancelled from dispatched (parcel returned)', () => {
    const cod = { priced_at: '2026-11-14T00:00:00Z', payment_method: 'cod' as const, paid_at: null };
    expect(selectableStatuses({ ...cod, status: 'confirmed' })).toEqual(['cancelled']);
    expect(selectableStatuses({ ...cod, status: 'dispatched' })).toEqual(['cancelled']);
    expect(selectableStatuses({ ...cod, status: 'dispatched', paid_at: '2026-11-15T00:00:00Z' })).toEqual([]);
  });
});

describe('canRecordPayment', () => {
  const base = { priced_at: '2026-11-14T00:00:00Z', total_minor: 10_000, subtotal_minor: 10_000, amount_paid_minor: 0, paid_at: null };
  it('offers it while the order takes payment, and for an unpaid COD order after it ships', () => {
    expect(canRecordPayment({ ...base, status: 'awaiting_payment', payment_method: 'online' })).toBe(true);
    expect(canRecordPayment({ ...base, status: 'confirmed', payment_method: 'cod' })).toBe(true);
    expect(canRecordPayment({ ...base, status: 'fulfilled', payment_method: 'cod' })).toBe(true);
    expect(canRecordPayment({ ...base, status: 'dispatched', payment_method: 'online' })).toBe(false);
    expect(canRecordPayment({ ...base, status: 'fulfilled', payment_method: 'cod', paid_at: '2026-11-15T00:00:00Z', amount_paid_minor: 10_000 })).toBe(false);
  });
});
