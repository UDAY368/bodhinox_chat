import { createHmac } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { toSubscriptionStatus } from './provider';
import { billingConfigured, getBillingProvider, RazorpayBilling } from './razorpay-billing';

const config = { keyId: 'rzp_test_platform1', keySecret: 'platform-secret', webhookSecret: 'hook-secret' };
const sub = { id: 'sub_ABC', plan_id: 'plan_P1', customer_id: 'cust_C1', status: 'active', current_start: 1_790_000_000, current_end: 1_792_600_000, notes: { intent_id: 'i1', account_id: 'a' } };
const REF = '3f2c1b4a-9d8e-4c7b-a6f5-0e1d2c3b4a59';
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

function provider(...responses: (Response | Error)[]) {
  const fetchMock = vi.fn(async () => {
    const next = responses.shift();
    if (!next || next instanceof Error) throw next ?? new Error('no response');
    return next;
  });
  return { rp: new RazorpayBilling(config, fetchMock as unknown as typeof fetch), fetchMock };
}

describe('billing configuration', () => {
  it('is off until all three platform variables are set', () => {
    const env = { BILLING_RAZORPAY_KEY_ID: 'k', BILLING_RAZORPAY_KEY_SECRET: 's', BILLING_RAZORPAY_WEBHOOK_SECRET: 'w' };
    expect(billingConfigured(env)).toBe(true);
    expect(billingConfigured({ ...env, BILLING_RAZORPAY_WEBHOOK_SECRET: ' ' })).toBe(false);
    expect(getBillingProvider({})).toBeNull();
    expect(getBillingProvider(env)?.name).toBe('razorpay');
  });
});

describe('RazorpayBilling calls', () => {
  it('creates a subscription with Basic auth, no Razorpay emails and a trial start', async () => {
    const { rp, fetchMock } = provider(json(200, { ...sub, status: 'created', short_url: 'https://rzp.io/i/x' }));
    const result = await rp.createSubscription({ planId: 'plan_P1', customerId: 'cust_C1', trialDays: 14, notes: { intent_id: 'i1' } });
    expect(result).toMatchObject({ outcome: 'ok', value: { id: 'sub_ABC', state: 'created', status: 'incomplete', shortUrl: 'https://rzp.io/i/x' } });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.razorpay.com/v1/subscriptions');
    expect((init.headers as Record<string, string>).Authorization).toBe(`Basic ${Buffer.from('rzp_test_platform1:platform-secret').toString('base64')}`);
    const body = JSON.parse(init.body as string);
    expect(body).toMatchObject({ plan_id: 'plan_P1', customer_id: 'cust_C1', total_count: 120, customer_notify: 0, notes: { intent_id: 'i1' } });
    expect(body.start_at).toBeGreaterThan(Date.now() / 1000 + 13 * 86_400);
  });

  it('reports timeouts, network errors and 5xx as unknown, never retrying', async () => {
    for (const failure of [new DOMException('t', 'TimeoutError'), new TypeError('network'), json(502, {})]) {
      const { rp, fetchMock } = provider(failure);
      expect(await rp.createSubscription({ planId: 'plan_P1', customerId: 'cust_C1', notes: { intent_id: 'i1' } })).toEqual({ outcome: 'unknown' });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    }
  });

  it('reports 4xx as rejected without provider text', async () => {
    const { rp } = provider(json(401, { error: { description: 'secret detail' } }));
    expect(await rp.fetchSubscription('sub_ABC')).toEqual({ outcome: 'rejected', reason: 'auth', httpStatus: 401 });
    const bad = provider(json(400, {}));
    expect(await bad.rp.cancelSubscription({ id: 'sub_ABC', atPeriodEnd: true })).toEqual({ outcome: 'rejected', reason: 'invalid_request', httpStatus: 400 });
  });

  it('validates input before any request', async () => {
    const { rp, fetchMock } = provider();
    expect((await rp.fetchSubscription('../customers')).outcome).toBe('rejected');
    expect((await rp.createSubscription({ planId: 'plan_P1', customerId: 'cust_C1', notes: {} })).outcome).toBe('rejected');
    expect((await rp.changePlan({ id: 'sub_ABC', newPlanId: 'bad', at: 'now' })).outcome).toBe('rejected');
    expect((await rp.createAddon({ subscriptionId: 'sub_ABC', name: 'Seats', amountMinor: 0, currency: 'INR', quantity: 1, reference: REF })).outcome).toBe('rejected');
    expect((await rp.createAddon({ subscriptionId: 'sub_ABC', name: 'Seats', amountMinor: 100, currency: 'INR', quantity: 1, reference: 'free text' })).outcome).toBe('rejected');
    expect((await rp.findAddon({ reference: '../x', createdAfter: new Date() })).outcome).toBe('rejected');
    expect((await rp.createCustomer({ name: 'A', email: 'not-an-email' })).outcome).toBe('rejected');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('sends cancel, plan change, add-on and customer requests in Razorpay form', async () => {
    const { rp, fetchMock } = provider(json(200, sub), json(200, { ...sub, has_scheduled_changes: true }), json(200, { id: 'ao_1' }), json(200, { id: 'cust_C1' }));
    await rp.cancelSubscription({ id: 'sub_ABC', atPeriodEnd: true });
    expect(await rp.changePlan({ id: 'sub_ABC', newPlanId: 'plan_P2', at: 'period_end' })).toMatchObject({ value: { hasScheduledChanges: true } });
    expect(await rp.createAddon({ subscriptionId: 'sub_ABC', name: 'Seats', amountMinor: 50_000, currency: 'INR', quantity: 2, reference: REF })).toEqual({ outcome: 'ok', value: { id: 'ao_1' } });
    expect(await rp.createCustomer({ name: 'Acme', email: 'billing@acme.example', gstin: '27AAPFU0939F1ZV' })).toEqual({ outcome: 'ok', value: { id: 'cust_C1' } });
    const calls = fetchMock.mock.calls as unknown as [string, RequestInit][];
    expect(calls.map(([u, i]) => `${i.method} ${u.replace('https://api.razorpay.com/v1', '')}`)).toEqual([
      'POST /subscriptions/sub_ABC/cancel', 'PATCH /subscriptions/sub_ABC', 'POST /subscriptions/sub_ABC/addons', 'POST /customers',
    ]);
    expect(JSON.parse(calls[0][1].body as string)).toEqual({ cancel_at_cycle_end: 1 });
    expect(JSON.parse(calls[1][1].body as string)).toMatchObject({ plan_id: 'plan_P2', schedule_change_at: 'cycle_end' });
    expect(JSON.parse(calls[2][1].body as string)).toEqual({ item: { name: 'Seats', amount: 50_000, currency: 'INR', description: `bodhinox_addon:${REF}` }, quantity: 2 });
    expect(JSON.parse(calls[3][1].body as string)).toMatchObject({ fail_existing: '0', gstin: '27AAPFU0939F1ZV' });
  });

  it('finds a subscription by intent id for reconciliation', async () => {
    const page = Array.from({ length: 100 }, (_, i) => ({ ...sub, id: `sub_X${i}`, notes: { intent_id: `other${i}` } }));
    const { rp, fetchMock } = provider(json(200, { items: page }), json(200, { items: [sub] }));
    expect(await rp.findSubscription({ planId: 'plan_P1', intentId: 'i1', createdAfter: new Date() })).toMatchObject({ outcome: 'ok', value: { id: 'sub_ABC' } });
    expect((fetchMock.mock.calls[1] as unknown as [string])[0]).toContain('skip=100');
    const none = provider(json(200, { items: [] }));
    expect(await none.rp.findSubscription({ planId: 'plan_P1', intentId: 'i1', createdAfter: new Date() })).toEqual({ outcome: 'ok', value: null });
  });

  it('finds an add-on by the reference in its item description, paging, and stays unknown past the search window (audit finding 53)', async () => {
    const addon = (id: string, description: string | null) => ({ id, entity: 'addon', item: { name: 'Seats', amount: 100, currency: 'INR', description }, quantity: 1 });
    const page = Array.from({ length: 100 }, (_, i) => addon(`ao_X${i}`, i % 2 ? null : `bodhinox_addon:other${i}`));
    const { rp, fetchMock } = provider(json(200, { items: page }), json(200, { items: [addon('ao_MINE', `bodhinox_addon:${REF}`)] }));
    const after = new Date('2026-11-10T10:00:00Z');
    expect(await rp.findAddon({ reference: REF, createdAfter: after })).toEqual({ outcome: 'ok', value: { id: 'ao_MINE' } });
    const urls = (fetchMock.mock.calls as unknown as [string][]).map(([u]) => u.replace('https://api.razorpay.com/v1', ''));
    expect(urls).toEqual([`/addons?from=${after.getTime() / 1000 - 300}&count=100&skip=0`, `/addons?from=${after.getTime() / 1000 - 300}&count=100&skip=100`]);
    // A short page without it: Razorpay has no such add-on.
    expect(await provider(json(200, { items: [addon('ao_1', null)] })).rp.findAddon({ reference: REF, createdAfter: after })).toEqual({ outcome: 'ok', value: null });
    // Five full pages without it: too many to be sure, so the outcome stays unknown (never "absent", which would fail the row).
    const full = Array.from({ length: 5 }, () => json(200, { items: page }));
    expect(await provider(...full).rp.findAddon({ reference: REF, createdAfter: after })).toEqual({ outcome: 'unknown' });
    // A provider error is unknown too.
    expect(await provider(json(500, {})).rp.findAddon({ reference: REF, createdAfter: after })).toEqual({ outcome: 'unknown' });
    // A page without an items array is unknown, never "absent" (absent fails the row an hour on).
    expect(await provider(json(200, { entity: 'collection' })).rp.findAddon({ reference: REF, createdAfter: after })).toEqual({ outcome: 'unknown' });
  });
});

describe('webhooks', () => {
  const rp = new RazorpayBilling(config, vi.fn() as unknown as typeof fetch);
  it('verifies the HMAC of the raw body', () => {
    const raw = JSON.stringify({ event: 'subscription.charged' });
    const sig = createHmac('sha256', 'hook-secret').update(raw).digest('hex');
    expect(rp.verifyWebhook(raw, sig)).toBe(true);
    expect(rp.verifyWebhook(raw + ' ', sig)).toBe(false);
    expect(rp.verifyWebhook(raw, null)).toBe(false);
    expect(rp.verifyWebhook(raw, createHmac('sha256', 'other').update(raw).digest('hex'))).toBe(false);
  });
  it('keeps only billing fields from an event', () => {
    const event = rp.parseWebhook({
      event: 'subscription.charged', created_at: 1_790_000_100,
      payload: {
        subscription: { entity: sub },
        payment: { entity: { id: 'pay_1', amount: 117_882, currency: 'INR', invoice_id: 'inv_1', email: 'buyer@example.com', card: { last4: '1111' } } },
      },
    });
    expect(event).toEqual({
      type: 'subscription.charged', subscriptionId: 'sub_ABC', state: 'active', planId: 'plan_P1', paymentId: 'pay_1', invoiceId: 'inv_1',
      amountMinor: 117_882, currency: 'INR', currentStart: new Date(1_790_000_000_000), currentEnd: new Date(1_792_600_000_000),
      notes: { intent_id: 'i1', account_id: 'a' }, createdAt: 1_790_000_100,
    });
    expect(JSON.stringify(event)).not.toContain('buyer@example.com');
    expect(rp.parseWebhook({ event: 'payment_link.paid', payload: {} })).toBeNull();
  });
  it('maps payment.failed to its subscription only when the payment names one', () => {
    const failed = (entity: Record<string, unknown>) => rp.parseWebhook({ event: 'payment.failed', payload: { payment: { entity } } });
    expect(failed({ id: 'pay_F', amount: 118_000, currency: 'INR', subscription_id: 'sub_ABC', invoice_id: 'inv_F', email: 'buyer@example.com' }))
      .toMatchObject({ type: 'payment.failed', subscriptionId: 'sub_ABC', paymentId: 'pay_F', state: null, notes: {} });
    expect(failed({ id: 'pay_G', amount: 118_000, currency: 'INR', invoice_id: 'inv_G' })).toMatchObject({ type: 'payment.failed', subscriptionId: null });
    expect(rp.parseWebhook({ event: 'payment.captured', payload: { payment: { entity: { id: 'pay_H', subscription_id: 'sub_ABC' } } } })).toBeNull();
  });
});

describe('toSubscriptionStatus', () => {
  it('maps every provider state', () => {
    expect(['created', 'authenticated', 'active', 'pending', 'halted', 'paused', 'cancelled', 'completed', 'expired', 'unknown'].map((s) => toSubscriptionStatus(s as never)))
      .toEqual(['incomplete', 'trialing', 'active', 'past_due', 'grace', 'suspended', 'cancelled', 'cancelled', 'cancelled', null]);
  });
});
