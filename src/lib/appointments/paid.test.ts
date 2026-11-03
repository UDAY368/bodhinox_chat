import { describe, expect, it } from 'vitest';
import { appointmentPaymentIntentKey, appointmentPaymentReference, paymentLinkApplies } from './paid';

const id = '0b9a5a49-1f8b-4b7e-9d3c-3e1f2a4b5c6d';

describe('appointment payment link keys', () => {
  it('derives one Razorpay reference per hold version, within the 16-40 character rule', () => {
    const v2 = appointmentPaymentReference(id, 2);
    expect(v2).toMatch(/^ap_[A-Za-z0-9_-]{32}$/);
    expect(appointmentPaymentReference(id, 2)).toBe(v2);
    expect(appointmentPaymentReference(id, 3)).not.toBe(v2);
    expect(appointmentPaymentIntentKey(id, 2)).toBe(`appt-plink:${id}:v2`);
  });
});

describe('paymentLinkApplies', () => {
  const now = new Date('2026-12-01T05:00:00Z');
  const held = { version: 2, status: 'held' as const, payment_status: 'pending' as const,
    hold_expires_at: new Date('2026-12-01T05:20:00Z'), contact_id: id };

  it('sends only for the queued version of a live, bound, unpaid hold', () => {
    expect(paymentLinkApplies(held, 2, now)).toBeNull();
    expect(paymentLinkApplies(held, 1, now)).toBe('stale_version');
    expect(paymentLinkApplies({ ...held, status: 'confirmed' }, 2, now)).toBe('stale_version');
    expect(paymentLinkApplies({ ...held, payment_status: 'paid' }, 2, now)).toBe('stale_version');
    expect(paymentLinkApplies({ ...held, hold_expires_at: now }, 2, now)).toBe('hold_expired');
    expect(paymentLinkApplies({ ...held, contact_id: null }, 2, now)).toBe('contact_missing');
  });
});
