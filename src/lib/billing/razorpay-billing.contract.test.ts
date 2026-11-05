import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { fixtureBody, fixtureFetch, loadProviderFixture, type ProviderFixture } from '@/test/fixtures/providers';
import { RazorpayBilling } from './razorpay-billing';

// Outbound and inbound contract for platform subscription billing (design 1.4, P1):
// docs-derived responses replayed through the real RazorpayBilling client.
const fx = (name: string) => loadProviderFixture('razorpay-billing', name);
const err = (name: string) => loadProviderFixture('razorpay', name);
const CONFIG = { keyId: 'rzp_test_FixtureBill', keySecret: 'test-only-secret', webhookSecret: 'test-only-webhook' };
const AUTH = `Basic ${Buffer.from(`${CONFIG.keyId}:${CONFIG.keySecret}`).toString('base64')}`;

function client(...responses: ProviderFixture[]) {
  const fetch = fixtureFetch(responses);
  return { provider: new RazorpayBilling(CONFIG, fetch as unknown as typeof globalThis.fetch), fetch };
}
function expectRequest(call: { url: string; method: string; headers: Record<string, string>; body: unknown }, fixture: ProviderFixture) {
  expect(call.method).toBe(fixture.request!.method);
  expect(call.url).toBe(`https://api.razorpay.com${fixture.request!.path}`);
  expect(call.headers.authorization).toBe(AUTH);
  if (fixture.request!.body !== undefined) expect(call.body).toMatchObject(fixture.request!.body as object);
}

describe('[BIL-02] Razorpay subscription billing contract (docs-derived)', () => {
  it('creates a customer (reusing one for the same email) and a subscription carrying our notes', async () => {
    const { provider, fetch } = client(fx('customer-create'), fx('subscription-create'));
    expect(await provider.createCustomer({ name: 'Fixture Pvt Ltd', email: 'billing@example.com', gstin: null, notes: {} }))
      .toEqual({ outcome: 'ok', value: { id: 'cust_FixtureCust001' } });
    expectRequest(fetch.calls[0], fx('customer-create'));
    const notes = { account_id: '11111111-1111-4111-8111-111111111111', intent_id: '33333333-3333-4333-8333-333333333333' };
    const sub = await provider.createSubscription({ planId: 'plan_FixturePlan001', customerId: 'cust_FixtureCust001', notes });
    expect(sub).toMatchObject({ outcome: 'ok', value: { id: 'sub_FixtureSub00001', state: 'created', status: 'incomplete', shortUrl: 'https://rzp.io/i/fixturesub', notes } });
    expectRequest(fetch.calls[1], fx('subscription-create'));
  });

  it('reads an active subscription and a scheduled cancel', async () => {
    const { provider, fetch } = client(fx('subscription-fetch-active'), fx('subscription-cancel'));
    const sub = await provider.fetchSubscription('sub_FixtureSub00001');
    expect(sub).toMatchObject({ outcome: 'ok', value: { state: 'active', status: 'active', currentStart: new Date(1762336800_000), currentEnd: new Date(1765015200_000) } });
    expectRequest(fetch.calls[0], fx('subscription-fetch-active'));
    expect(await provider.cancelSubscription({ id: 'sub_FixtureSub00001', atPeriodEnd: true })).toMatchObject({ outcome: 'ok', value: { hasScheduledChanges: true } });
    expectRequest(fetch.calls[1], fx('subscription-cancel'));
  });

  it('maps 400 and 401 to definite rejections and 5xx to unknown', async () => {
    expect(await client(err('error-400')).provider.fetchSubscription('sub_FixtureSub00001')).toEqual({ outcome: 'rejected', reason: 'invalid_request', httpStatus: 400 });
    expect(await client(err('error-401')).provider.fetchSubscription('sub_FixtureSub00001')).toEqual({ outcome: 'rejected', reason: 'auth', httpStatus: 401 });
    expect(await client(err('error-500')).provider.createCustomer({ name: 'Fixture', email: 'billing@example.com', gstin: null, notes: {} })).toEqual({ outcome: 'unknown' });
  });

  it('verifies and parses the documented subscription.charged payload, ids and amounts only', () => {
    const { provider } = client();
    const body = fixtureBody(fx('webhook-subscription-charged'));
    const raw = JSON.stringify(body);
    expect(provider.verifyWebhook(raw, createHmac('sha256', CONFIG.webhookSecret).update(raw).digest('hex'))).toBe(true);
    expect(provider.verifyWebhook(raw, createHmac('sha256', 'other').update(raw).digest('hex'))).toBe(false);
    const event = provider.parseWebhook(body);
    expect(event).toMatchObject({ type: 'subscription.charged', subscriptionId: 'sub_FixtureSub00001', state: 'active', planId: 'plan_FixturePlan001',
      paymentId: 'pay_FixtureBill0001', invoiceId: 'inv_FixtureInv0001', amountMinor: 118000, currency: 'INR' });
    expect(JSON.stringify(event)).not.toMatch(/example\.com|9800000302/);
  });
});
