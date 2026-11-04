import { describe, expect, it } from 'vitest';
import {
  flowOutcomeFor,
  flowPaymentReference,
  isStaleCreating,
  nextStatus,
  PaymentLinkError,
  paymentLinkMessageText,
  requestPaymentReference,
  statusForEvent,
  validateCreateInput,
} from './links';

const REFERENCE = /^[A-Za-z0-9_-]{16,40}$/;
const RUN = '11111111-1111-4111-8111-111111111111';
const ACCOUNT = '22222222-2222-4222-8222-222222222222';
const USER = '33333333-3333-4333-8333-333333333333';

describe('nextStatus', () => {
  it('never moves a paid link anywhere else', () => {
    for (const incoming of ['created', 'partially_paid', 'expired', 'cancelled', 'unknown'] as const) {
      expect(nextStatus('paid', incoming)).toBe('paid');
    }
  });
  it('lets a late payment win over an ended link', () => {
    expect(nextStatus('expired', 'paid')).toBe('paid');
    expect(nextStatus('cancelled', 'paid')).toBe('paid');
    expect(nextStatus('unknown', 'paid')).toBe('paid');
  });
  it('keeps an ended link ended for anything but paid', () => {
    expect(nextStatus('expired', 'created')).toBe('expired');
    expect(nextStatus('cancelled', 'partially_paid')).toBe('cancelled');
    expect(nextStatus('failed', 'created')).toBe('failed');
  });
  it('ignores an unknown provider status', () => {
    expect(nextStatus('created', 'unknown')).toBe('created');
    expect(nextStatus('unknown', 'unknown')).toBe('unknown');
  });
  it('follows the provider for open links', () => {
    expect(nextStatus('unknown', 'created')).toBe('created');
    expect(nextStatus('creating', 'created')).toBe('created');
    expect(nextStatus('created', 'expired')).toBe('expired');
    expect(nextStatus('created', 'partially_paid')).toBe('partially_paid');
  });
});

describe('statusForEvent', () => {
  it('maps the four payment-link events and ignores the rest', () => {
    expect(statusForEvent('payment_link.paid')).toBe('paid');
    expect(statusForEvent('payment_link.partially_paid')).toBe('partially_paid');
    expect(statusForEvent('payment_link.expired')).toBe('expired');
    expect(statusForEvent('payment_link.cancelled')).toBe('cancelled');
    expect(statusForEvent('payment.captured')).toBeNull();
    expect(statusForEvent('payment_link.created')).toBeNull();
  });
});

describe('references', () => {
  it('derives one valid reference per run, node and transition', () => {
    const a = flowPaymentReference(RUN, 'pay', 3);
    expect(a).toMatch(REFERENCE);
    expect(flowPaymentReference(RUN, 'pay', 3)).toBe(a);
    expect(flowPaymentReference(RUN, 'pay', 4)).not.toBe(a);
    expect(flowPaymentReference(RUN, 'other', 3)).not.toBe(a);
  });
  it('derives one valid reference per account, user and request id', () => {
    const a = requestPaymentReference(ACCOUNT, USER, 'req-1');
    expect(a).toMatch(REFERENCE);
    expect(requestPaymentReference(ACCOUNT, USER, 'req-1')).toBe(a);
    expect(requestPaymentReference(ACCOUNT, USER, 'req-2')).not.toBe(a);
    expect(requestPaymentReference(ACCOUNT, RUN, 'req-1')).not.toBe(a);
    // Flow and request references live in separate namespaces.
    expect(a.startsWith('in_')).toBe(true);
    expect(flowPaymentReference(RUN, 'pay', 0).startsWith('fl_')).toBe(true);
  });
});

describe('validateCreateInput', () => {
  const now = Date.parse('2026-11-02T10:00:00Z');
  const ok = { amountMinor: 49_900, currency: 'INR', description: 'Order 1', expireBy: new Date(now + 60 * 60_000) };
  const code = (input: Partial<typeof ok>) => {
    try {
      validateCreateInput({ ...ok, ...input }, now);
      return null;
    } catch (error) {
      return error instanceof PaymentLinkError ? error.code : 'other';
    }
  };
  it('accepts a normal link', () => expect(code({})).toBeNull());
  it('refuses a zero, negative, fractional or unsafe amount', () => {
    expect(code({ amountMinor: 0 })).toBe('invalid_amount');
    expect(code({ amountMinor: -1 })).toBe('invalid_amount');
    expect(code({ amountMinor: 1.5 })).toBe('invalid_amount');
    expect(code({ amountMinor: Number.MAX_SAFE_INTEGER + 2 })).toBe('invalid_amount');
  });
  it('refuses a bad currency and a long description', () => {
    expect(code({ currency: 'rupees' })).toBe('invalid_currency');
    expect(code({ description: 'x'.repeat(2049) })).toBe('invalid_description');
  });
  it('refuses an expiry Razorpay would reject', () => {
    expect(code({ expireBy: new Date(now + 5 * 60_000) })).toBe('invalid_expiry');
    expect(code({ expireBy: new Date(now + 400 * 24 * 60 * 60_000) })).toBe('invalid_expiry');
  });
  it('gives each error an HTTP status', () => {
    expect(new PaymentLinkError('not_connected').status).toBe(409);
    expect(new PaymentLinkError('invalid_amount').status).toBe(400);
    expect(new PaymentLinkError('provider_unreachable').status).toBe(502);
  });
});

describe('helpers', () => {
  it('puts the link under the message', () => {
    expect(paymentLinkMessageText('Pay here:', 'https://rzp.io/l/x')).toBe('Pay here:\nhttps://rzp.io/l/x');
    expect(paymentLinkMessageText('  ', 'https://rzp.io/l/x')).toBe('https://rzp.io/l/x');
    expect(paymentLinkMessageText(null, 'https://rzp.io/l/x')).toBe('https://rzp.io/l/x');
  });
  it('maps link statuses to flow outcomes; open links have none', () => {
    expect(flowOutcomeFor('paid')).toBe('paid');
    expect(flowOutcomeFor('expired')).toBe('expired');
    expect(flowOutcomeFor('cancelled')).toBe('expired');
    expect(flowOutcomeFor('failed')).toBe('failed');
    for (const open of ['creating', 'created', 'partially_paid', 'unknown'] as const) expect(flowOutcomeFor(open)).toBeNull();
  });
  it('treats only an old creating row as abandoned', () => {
    const now = Date.parse('2026-11-02T10:00:00Z');
    expect(isStaleCreating({ status: 'creating', updated_at: new Date(now - 3 * 60_000) }, now)).toBe(true);
    expect(isStaleCreating({ status: 'creating', updated_at: new Date(now - 30_000) }, now)).toBe(false);
    expect(isStaleCreating({ status: 'unknown', updated_at: new Date(now - 3 * 60_000) }, now)).toBe(false);
  });
});

describe('paymentLinkErrorFromInstagram (Phase 11)', () => {
  it('maps every Instagram refusal to a fixed payment-link code', async () => {
    const { paymentLinkErrorFromInstagram } = await import('./links');
    const { INSTAGRAM_ERROR_CODES, InstagramError } = await import('@/lib/instagram/errors');
    const expected: Record<string, string> = {
      instagram_window_closed: 'window_closed', contact_blocked: 'contact_blocked', invalid_request: 'invalid_message', not_found: 'no_address',
    };
    for (const code of INSTAGRAM_ERROR_CODES) {
      const mapped = paymentLinkErrorFromInstagram(new InstagramError(code));
      expect(mapped).toBeInstanceOf(PaymentLinkError);
      expect((mapped as PaymentLinkError).code).toBe(expected[code] ?? 'number_unavailable');
    }
  });
  it('passes anything else through unchanged', async () => {
    const { paymentLinkErrorFromInstagram } = await import('./links');
    const error = new Error('boom');
    expect(paymentLinkErrorFromInstagram(error)).toBe(error);
  });
});
