import { describe, expect, it } from 'vitest';
import { createRejectedDefinitely } from './send-payment-link-dialog';

describe('createRejectedDefinitely (R5)', () => {
  it('gets a new request id when nothing was created', () => {
    expect(createRejectedDefinitely(400)).toBe(true);
    expect(createRejectedDefinitely(404, 'target_not_found')).toBe(true);
  });

  it('gets a new request id when Razorpay definitely refused the create (row already failed)', () => {
    expect(createRejectedDefinitely(502, 'provider_rejected')).toBe(true);
    expect(createRejectedDefinitely(502, 'provider_auth')).toBe(true);
  });

  it('keeps the request id when the outcome is unknown, so a retry reconciles instead of creating', () => {
    expect(createRejectedDefinitely(502)).toBe(false);
    expect(createRejectedDefinitely(502, 'provider_unreachable')).toBe(false);
    expect(createRejectedDefinitely(500)).toBe(false);
    expect(createRejectedDefinitely(409, 'reference_conflict')).toBe(false);
    expect(createRejectedDefinitely(429)).toBe(false);
  });
});
