import { createHmac } from 'node:crypto';
import { beforeEach, expect, it, vi } from 'vitest';

const SECRET = 'billing-whsec-test-only';
const h = vi.hoisted(() => ({
  configured: true,
  stored: new Map<string, unknown>(),
  failDb: false,
}));

vi.mock('@/lib/billing/razorpay-billing', async (orig) => {
  const real = await orig<typeof import('@/lib/billing/razorpay-billing')>();
  return {
    ...real,
    getBillingProvider: () => (h.configured ? new real.RazorpayBilling({ keyId: 'rzp_test_x', keySecret: 'k', webhookSecret: SECRET }) : null),
  };
});
vi.mock('@/lib/billing/subscriptions', () => ({
  HANDLED_EVENTS: new Set(['subscription.activated', 'subscription.charged', 'subscription.halted', 'invoice.paid', 'payment.failed']),
  recordBillingEvent: async (eventId: string, event: unknown) => {
    if (h.failDb) throw new Error('db down');
    if (h.stored.has(eventId)) return false;
    h.stored.set(eventId, event);
    return true;
  },
}));
vi.mock('@/lib/rate-limit', () => ({ checkRateLimit: () => ({ success: true }), rateLimitResponse: () => Response.json({}, { status: 429 }) }));

import { POST } from './route';

const body = (event: string, extra: Record<string, unknown> = {}) => JSON.stringify({
  event,
  created_at: 1_790_000_000,
  payload: {
    subscription: { entity: { id: 'sub_Abc123', plan_id: 'plan_Pro1', status: 'active', current_start: 1_790_000_000, current_end: 1_792_592_000,
      notes: { account_id: '11111111-1111-4111-8111-111111111111', intent_id: '22222222-2222-4222-8222-222222222222' } } },
    payment: { entity: { id: 'pay_1', amount: 118000, currency: 'INR', invoice_id: 'inv_1', card: { last4: '4242' }, email: 'buyer@example.invalid', contact: '+919800000000' } },
    ...extra,
  },
});
const sign = (raw: string, secret = SECRET) => createHmac('sha256', secret).update(raw).digest('hex');
const call = (raw: string, headers: Record<string, string>) =>
  POST(new Request('http://localhost/api/billing/webhook', { method: 'POST', body: raw, headers }));

beforeEach(() => {
  h.configured = true;
  h.stored.clear();
  h.failDb = false;
});

it('stores a verified event once, with billing fields only, before acknowledging', async () => {
  const raw = body('subscription.charged');
  const res = await call(raw, { 'x-razorpay-signature': sign(raw), 'x-razorpay-event-id': 'evt_1' });
  expect(res.status).toBe(200);
  const stored = h.stored.get('evt_1') as Record<string, unknown>;
  expect(stored).toMatchObject({ type: 'subscription.charged', subscriptionId: 'sub_Abc123', paymentId: 'pay_1', invoiceId: 'inv_1', amountMinor: 118000 });
  // No card, email or phone reaches storage.
  expect(JSON.stringify(stored)).not.toMatch(/4242|buyer@|9800000000/);
  // A redelivery is acknowledged and stores nothing new.
  expect((await call(raw, { 'x-razorpay-signature': sign(raw), 'x-razorpay-event-id': 'evt_1' })).status).toBe(200);
  expect(h.stored.size).toBe(1);
});

it('refuses a missing, wrong or other-secret signature', async () => {
  const raw = body('subscription.activated');
  expect((await call(raw, {})).status).toBe(401);
  expect((await call(raw, { 'x-razorpay-signature': sign(raw, 'other') })).status).toBe(401);
  expect((await call(raw, { 'x-razorpay-signature': sign(`${raw} `) })).status).toBe(401);
  expect(h.stored.size).toBe(0);
});

it('is absent while billing is not configured', async () => {
  h.configured = false;
  const raw = body('subscription.activated');
  expect((await call(raw, { 'x-razorpay-signature': sign(raw) })).status).toBe(404);
});

it('acknowledges and ignores events it does not act on', async () => {
  const raw = JSON.stringify({ event: 'payment.captured', payload: {} });
  expect((await call(raw, { 'x-razorpay-signature': sign(raw) })).status).toBe(200);
  const other = body('subscription.authenticated_unknown');
  expect((await call(other, { 'x-razorpay-signature': sign(other) })).status).toBe(200);
  expect(h.stored.size).toBe(0);
});

it('stores payment.failed only when the payment names its subscription', async () => {
  const named = JSON.stringify({ event: 'payment.failed', payload: { payment: { entity: { id: 'pay_F1', subscription_id: 'sub_Abc123', email: 'buyer@example.invalid' } } } });
  expect((await call(named, { 'x-razorpay-signature': sign(named), 'x-razorpay-event-id': 'evt_f1' })).status).toBe(200);
  expect(h.stored.get('evt_f1')).toMatchObject({ type: 'payment.failed', subscriptionId: 'sub_Abc123', paymentId: 'pay_F1' });
  const anonymous = JSON.stringify({ event: 'payment.failed', payload: { payment: { entity: { id: 'pay_F2', invoice_id: 'inv_F2' } } } });
  expect((await call(anonymous, { 'x-razorpay-signature': sign(anonymous), 'x-razorpay-event-id': 'evt_f2' })).status).toBe(200);
  expect(h.stored.has('evt_f2')).toBe(false);
});

it('falls back to a body hash for the event id and is not acknowledged when storage fails', async () => {
  const raw = body('subscription.halted');
  expect((await call(raw, { 'x-razorpay-signature': sign(raw), 'x-razorpay-event-id': 'bad id with spaces' })).status).toBe(200);
  expect([...h.stored.keys()][0]).toMatch(/^sha256-[0-9a-f]{64}$/);
  h.failDb = true;
  const again = body('subscription.activated');
  expect((await call(again, { 'x-razorpay-signature': sign(again), 'x-razorpay-event-id': 'evt_9' })).status).toBe(500);
});

it('rejects oversized bodies before verifying', async () => {
  const raw = 'x'.repeat(300 * 1024);
  expect((await call(raw, { 'x-razorpay-signature': sign(raw) })).status).toBe(400);
});
