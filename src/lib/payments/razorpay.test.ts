import { createHmac } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  cancelPaymentLink,
  createPaymentLink,
  fetchPaymentLink,
  fetchPaymentLinkByReference,
  keyMode,
  newReferenceId,
  parsePaymentLinkEvent,
  RazorpayError,
  testCredentials,
  verifyWebhookSignature,
} from './razorpay';

const json = (body: unknown, status = 200) => ({ ok: status < 400, status, json: async () => body }) as Response;
const creds = { keyId: 'rzp_test_ABCDEF123456', keySecret: 'SECRET-VALUE' };
const reference = 'ref_abcdefghijklmnop1234';
const linkBody = { id: 'plink_Abc123', short_url: 'https://rzp.io/i/x', status: 'created', amount: 50000, amount_paid: 0, currency: 'INR', reference_id: reference, expire_by: 0 };
afterEach(() => vi.unstubAllGlobals());

describe('createPaymentLink', () => {
  it('posts the link with Basic auth and our reference id, and returns it', async () => {
    const fetch = vi.fn(async () => json(linkBody));
    vi.stubGlobal('fetch', fetch);
    const expireBy = new Date(Date.now() + 3_600_000);
    const result = await createPaymentLink({
      ...creds, amountMinor: 50000, currency: 'INR', description: 'Order 42', referenceId: reference,
      customer: { name: 'Asha', contact: '+919800000000', email: '' }, expireBy, notes: { order: '42' },
    });
    expect(result).toEqual({ outcome: 'created', link: {
      id: 'plink_Abc123', shortUrl: 'https://rzp.io/i/x', status: 'created', amountMinor: 50000, amountPaidMinor: 0,
      currency: 'INR', referenceId: reference, expireBy: null,
    } });
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.razorpay.com/v1/payment_links');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>).Authorization).toBe(`Basic ${Buffer.from('rzp_test_ABCDEF123456:SECRET-VALUE').toString('base64')}`);
    const body = JSON.parse(String(init.body));
    expect(body).toMatchObject({
      amount: 50000, currency: 'INR', reference_id: reference, accept_partial: false, description: 'Order 42',
      customer: { name: 'Asha', contact: '+919800000000' }, notify: { sms: false, email: false },
      expire_by: Math.floor(expireBy.getTime() / 1000), notes: { order: '42' },
    });
    expect(body.customer.email).toBeUndefined();
  });

  it('treats timeouts, network errors and 5xx as unknown, never as failed', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new DOMException('timed out', 'TimeoutError'); }));
    expect(await createPaymentLink({ ...creds, amountMinor: 100, currency: 'INR', referenceId: reference })).toEqual({ outcome: 'unknown' });
    vi.stubGlobal('fetch', vi.fn(async () => json({ error: {} }, 502)));
    expect(await createPaymentLink({ ...creds, amountMinor: 100, currency: 'INR', referenceId: reference })).toEqual({ outcome: 'unknown' });
    vi.stubGlobal('fetch', vi.fn(async () => json(null)));
    expect(await createPaymentLink({ ...creds, amountMinor: 100, currency: 'INR', referenceId: reference })).toEqual({ outcome: 'unknown' });
  });

  it('classifies definite rejections', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ error: { code: 'BAD_REQUEST_ERROR', description: 'Authentication failed' } }, 401)));
    expect(await createPaymentLink({ ...creds, amountMinor: 100, currency: 'INR', referenceId: reference })).toEqual({ outcome: 'rejected', reason: 'auth', httpStatus: 401 });
    vi.stubGlobal('fetch', vi.fn(async () => json({ error: { code: 'BAD_REQUEST_ERROR', description: 'Payment Link with this reference_id already exists' } }, 400)));
    expect(await createPaymentLink({ ...creds, amountMinor: 100, currency: 'INR', referenceId: reference })).toEqual({ outcome: 'rejected', reason: 'duplicate_reference', httpStatus: 400 });
    vi.stubGlobal('fetch', vi.fn(async () => json({ error: { description: 'amount too small' } }, 400)));
    expect(await createPaymentLink({ ...creds, amountMinor: 100, currency: 'INR', referenceId: reference })).toMatchObject({ outcome: 'rejected', reason: 'invalid_request' });
  });

  it('refuses bad input before calling Razorpay', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const ok = { ...creds, amountMinor: 100, currency: 'INR', referenceId: reference };
    for (const bad of [{ amountMinor: 0 }, { amountMinor: 1.5 }, { currency: 'inr' }, { referenceId: 'short' },
      { expireBy: new Date(Date.now() + 60_000) }, { keySecret: '' }, { description: 'x'.repeat(2049) }]) {
      await expect(createPaymentLink({ ...ok, ...bad })).rejects.toBeInstanceOf(RazorpayError);
    }
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('reading and cancelling links', () => {
  it('fetches by id and by reference for reconciliation', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(json({ ...linkBody, status: 'paid', amount_paid: 50000 }))
      .mockResolvedValueOnce(json({ payment_links: [linkBody] }))
      .mockResolvedValueOnce(json({ payment_links: [] }));
    vi.stubGlobal('fetch', fetch);
    expect(await fetchPaymentLink({ ...creds, id: 'plink_Abc123' })).toMatchObject({ status: 'paid', amountPaidMinor: 50000 });
    expect((await fetchPaymentLinkByReference({ ...creds, referenceId: reference }))?.id).toBe('plink_Abc123');
    expect(fetch.mock.calls[1][0]).toBe(`https://api.razorpay.com/v1/payment_links?reference_id=${reference}`);
    expect(await fetchPaymentLinkByReference({ ...creds, referenceId: reference })).toBeNull();
    await expect(fetchPaymentLink({ ...creds, id: '../x' })).rejects.toMatchObject({ reason: 'invalid_request' });
  });

  it('cancels and surfaces errors as RazorpayError', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(json({ ...linkBody, status: 'cancelled' })).mockResolvedValueOnce(json({}, 404));
    vi.stubGlobal('fetch', fetch);
    expect((await cancelPaymentLink({ ...creds, id: 'plink_Abc123' })).status).toBe('cancelled');
    expect(fetch.mock.calls[0][0]).toBe('https://api.razorpay.com/v1/payment_links/plink_Abc123/cancel');
    await expect(cancelPaymentLink({ ...creds, id: 'plink_Abc123' })).rejects.toMatchObject({ reason: 'not_found' });
  });

  it('tests credentials without echoing provider text', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ payment_links: [] })));
    expect(await testCredentials(creds)).toEqual({ ok: true });
    vi.stubGlobal('fetch', vi.fn(async () => json({ error: { description: 'bad key' } }, 401)));
    expect(await testCredentials(creds)).toEqual({ ok: false, reason: 'auth' });
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('fetch failed'); }));
    expect(await testCredentials(creds)).toEqual({ ok: false, reason: 'unreachable' });
  });
});

describe('webhooks', () => {
  const secret = 'whsec-test';
  const raw = JSON.stringify({ event: 'payment_link.paid', payload: { payment_link: { entity: { ...linkBody, status: 'paid', amount_paid: 50000, customer: { contact: '+91' } } } } });
  const sign = (body: string, key = secret) => createHmac('sha256', key).update(body).digest('hex');

  it('verifies the HMAC of the exact raw body', () => {
    expect(verifyWebhookSignature(raw, sign(raw), secret)).toBe(true);
    expect(verifyWebhookSignature(Buffer.from(raw), sign(raw).toUpperCase(), secret)).toBe(true);
    expect(verifyWebhookSignature(raw + ' ', sign(raw), secret)).toBe(false);
    expect(verifyWebhookSignature(raw, sign(raw, 'other'), secret)).toBe(false);
    expect(verifyWebhookSignature(raw, sign(raw).slice(0, 10), secret)).toBe(false);
    expect(verifyWebhookSignature(raw, null, secret)).toBe(false);
    expect(verifyWebhookSignature(raw, sign(raw), '')).toBe(false);
  });

  it('parses only payment-link events, without customer details', () => {
    expect(parsePaymentLinkEvent(JSON.parse(raw))).toEqual({
      event: 'payment_link.paid', paymentLinkId: 'plink_Abc123', referenceId: reference, status: 'paid', amountPaidMinor: 50000,
    });
    expect(parsePaymentLinkEvent({ event: 'payment.captured', payload: {} })).toBeNull();
    expect(parsePaymentLinkEvent(null)).toBeNull();
  });
});

it('makes references that fit the database and reads key modes', () => {
  const ref = newReferenceId();
  expect(ref).toMatch(/^[A-Za-z0-9_-]{16,40}$/);
  expect(newReferenceId()).not.toBe(ref);
  expect(keyMode('rzp_test_ABCDEF123456')).toBe('test');
  expect(keyMode('rzp_live_ABCDEF123456')).toBe('live');
  expect(keyMode('nope')).toBeNull();
});
