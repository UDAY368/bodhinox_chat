import { describe, expect, it } from 'vitest';
import { selectableStatuses } from './order-detail';

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
});
