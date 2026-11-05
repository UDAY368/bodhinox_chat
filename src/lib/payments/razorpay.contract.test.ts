import { createHmac } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fixtureBody, fixtureFetch, loadProviderFixture } from '@/test/fixtures/providers';
import {
  createPaymentLink, createRefund, fetchPayment, fetchPaymentLink, isCaptured, listRefunds, parsePaymentLinkEvent, parseRefundEvent,
  RazorpayError, verifyWebhookSignature,
} from './razorpay';

// Outbound and inbound contract for tenant Razorpay (design 1.4, P1): docs-derived
// responses replayed through the real client. Not verified against Razorpay.
const fx = (name: string) => loadProviderFixture('razorpay', name);
const CREDS = { keyId: 'rzp_test_FixtureKey01', keySecret: 'test-only-secret' };
const AUTH = `Basic ${Buffer.from(`${CREDS.keyId}:${CREDS.keySecret}`).toString('base64')}`;

function stub(...names: string[]) {
  const fetch = fixtureFetch(names.map(fx));
  vi.stubGlobal('fetch', fetch);
  return fetch;
}
function expectRequest(call: { url: string; method: string; headers: Record<string, string>; body: unknown }, name: string) {
  const req = fx(name).request!;
  expect(call.method).toBe(req.method);
  expect(call.url).toBe(`https://api.razorpay.com${req.path}`);
  expect(call.headers.authorization).toBe(AUTH);
  if (req.body !== undefined) expect(call.body).toMatchObject(req.body as object);
}

describe('[PAY-01] [PAY-02] [COM-05] Razorpay payment links, payments and refunds contract (docs-derived)', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('creates a link as documented, without Razorpay notifications, and reads it', async () => {
    const fetch = stub('payment-link-create');
    const result = await createPaymentLink({ ...CREDS, amountMinor: 49900, currency: 'INR', referenceId: 'co_fixturereference00000000000001' });
    expect(result).toEqual({ outcome: 'created', link: expect.objectContaining({ id: 'plink_FixtureLink001', status: 'created', amountMinor: 49900, referenceId: 'co_fixturereference00000000000001', shortUrl: 'https://rzp.io/i/fixture1' }) });
    expectRequest(fetch.calls[0], 'payment-link-create');
  });

  it('reads a paid link with its payments, and a captured payment', async () => {
    stub('payment-link-fetch-paid', 'payment-fetch-captured');
    const link = await fetchPaymentLink({ ...CREDS, id: 'plink_FixtureLink001' });
    expect(link).toMatchObject({ status: 'paid', amountPaidMinor: 49900, payments: [{ paymentId: 'pay_FixturePay0001', amountMinor: 49900, status: 'captured' }] });
    const payment = await fetchPayment({ ...CREDS, id: 'pay_FixturePay0001' });
    expect(payment).toEqual({ id: 'pay_FixturePay0001', amountMinor: 49900, currency: 'INR', status: 'captured', captured: true, method: 'upi', amountRefundedMinor: 0, createdAt: 1762336900 });
    expect(isCaptured(payment)).toBe(true);
    // Customer details in the response are never carried into our types.
    expect(JSON.stringify(payment)).not.toMatch(/example\.com|9800000301|fixture@upi/);
  });

  it('maps a duplicate reference to duplicate_reference, 4xx to a definite rejection and 5xx to unknown', async () => {
    const args = { ...CREDS, amountMinor: 49900, currency: 'INR', referenceId: 'co_fixturereference00000000000001' };
    stub('payment-link-duplicate-reference');
    expect(await createPaymentLink(args)).toEqual({ outcome: 'rejected', reason: 'duplicate_reference', httpStatus: 400 });
    stub('error-400');
    expect(await createPaymentLink(args)).toEqual({ outcome: 'rejected', reason: 'invalid_request', httpStatus: 400 });
    stub('error-401');
    expect(await createPaymentLink(args)).toEqual({ outcome: 'rejected', reason: 'auth', httpStatus: 401 });
    // A 5xx may have created the link: never a rejection, never retried blindly.
    stub('error-500');
    expect(await createPaymentLink(args)).toEqual({ outcome: 'unknown' });
    stub('error-500');
    await expect(fetchPayment({ ...CREDS, id: 'pay_FixturePay0001' })).rejects.toMatchObject({ reason: 'unknown', httpStatus: 500 });
    stub('error-401');
    await expect(fetchPaymentLink({ ...CREDS, id: 'plink_FixtureLink001' })).rejects.toBeInstanceOf(RazorpayError);
  });

  it('creates a refund carrying our id and attempt, and lists ours and dashboard refunds', async () => {
    const fetch = stub('refund-create', 'refunds-list');
    const created = await createRefund({ ...CREDS, paymentId: 'pay_FixturePay0001', amountMinor: 10000, refundId: '22222222-2222-4222-8222-222222222222', attempt: 1 });
    expect(created).toEqual({ outcome: 'created', refund: { id: 'rfnd_FixtureRef0001', paymentId: 'pay_FixturePay0001', amountMinor: 10000, currency: 'INR', status: 'pending',
      bodhinoxRefundId: '22222222-2222-4222-8222-222222222222', attempt: 1 } });
    expectRequest(fetch.calls[0], 'refund-create');
    const list = await listRefunds({ ...CREDS, paymentId: 'pay_FixturePay0001' });
    expectRequest(fetch.calls[1], 'refunds-list');
    expect(list.map((r) => [r.id, r.status, r.bodhinoxRefundId])).toEqual([
      ['rfnd_FixtureRef0001', 'processed', '22222222-2222-4222-8222-222222222222'], ['rfnd_FixtureDash001', 'pending', null]]);
  });

  it('verifies and parses the documented webhook payloads without customer details', () => {
    const secret = 'test-only-webhook-secret';
    for (const name of ['webhook-payment-link-paid', 'webhook-refund-processed']) {
      const raw = JSON.stringify(fixtureBody(fx(name)));
      expect(verifyWebhookSignature(raw, createHmac('sha256', secret).update(raw).digest('hex'), secret)).toBe(true);
      expect(verifyWebhookSignature(raw, createHmac('sha256', 'other').update(raw).digest('hex'), secret)).toBe(false);
    }
    const paid = parsePaymentLinkEvent(fixtureBody(fx('webhook-payment-link-paid')));
    expect(paid).toMatchObject({ event: 'payment_link.paid', paymentLinkId: 'plink_FixtureLink001', referenceId: 'co_fixturereference00000000000001', paymentId: 'pay_FixturePay0001', providerAccountId: 'acc_FixtureMerchant1' });
    expect(JSON.stringify(paid)).not.toMatch(/example\.com|9800000301/);
    expect(parseRefundEvent(fixtureBody(fx('webhook-refund-processed')))).toMatchObject({ event: 'refund.processed', refundId: 'rfnd_FixtureRef0001', paymentId: 'pay_FixturePay0001', status: 'processed', amountMinor: 10000 });
  });
});
