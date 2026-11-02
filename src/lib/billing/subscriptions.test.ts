import { describe, expect, it } from 'vitest';
import { HANDLED_EVENTS, storedEvent } from './subscriptions';

describe('storedEvent', () => {
  it('keeps ids, amounts and the workspace/intent hints only', () => {
    const stored = storedEvent({
      type: 'subscription.charged', subscriptionId: 'sub_1', state: 'active', planId: 'plan_1', paymentId: 'pay_1', invoiceId: 'inv_1',
      amountMinor: 118000, currency: 'INR', currentStart: null, currentEnd: null, createdAt: 1,
      notes: { account_id: '11111111-1111-4111-8111-111111111111', intent_id: 'not-a-uuid', customer_note: 'free text from someone' },
    });
    expect(stored).toEqual({
      type: 'subscription.charged', subscriptionId: 'sub_1', paymentId: 'pay_1', invoiceId: 'inv_1', amountMinor: 118000, currency: 'INR',
      accountHint: '11111111-1111-4111-8111-111111111111', intentHint: null,
    });
  });

  it('acts on the subscription lifecycle and paid invoices only', () => {
    for (const e of ['subscription.activated', 'subscription.charged', 'subscription.pending', 'subscription.halted', 'subscription.cancelled',
      'subscription.completed', 'subscription.paused', 'subscription.resumed', 'invoice.paid', 'payment.failed'])
      expect(HANDLED_EVENTS.has(e)).toBe(true);
    expect(HANDLED_EVENTS.has('invoice.expired')).toBe(false);
  });
});
