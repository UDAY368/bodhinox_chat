import { createHmac } from 'node:crypto';
import { beforeEach, expect, it, vi } from 'vitest';

const ACCOUNT = '11111111-1111-4111-8111-111111111111';
const SECRET = 'whsec-test-only';
const h = vi.hoisted(() => ({
  secrets: new Map<string, string | null>(),
  receipts: new Map<string, { id: string; payload: Record<string, unknown> }>(),
  jobs: [] as { type: string; tenant: string; payload: string; dedupe: string }[],
  failTx: false,
}));

vi.mock('@/lib/payments/providers', () => {
  class PaymentProviderError extends Error {}
  return {
    PaymentProviderError,
    loadRazorpaySecrets: async (accountId: string) => {
      if (!h.secrets.has(accountId)) throw new PaymentProviderError('not_connected');
      return { keyId: 'rzp_test_x', keySecret: 'k', webhookSecret: h.secrets.get(accountId), mode: 'test' };
    },
  };
});
vi.mock('@/lib/commerce/webhook-receipts', () => ({
  claimWebhookReceipt: async (_tx: unknown, input: { provider: string; receiptId: string; payload: Record<string, unknown> }) => {
    const key = `${input.provider}:${input.receiptId}`;
    const existing = h.receipts.get(key);
    if (existing) return { id: existing.id, duplicate: true };
    const id = `r${h.receipts.size + 1}`;
    h.receipts.set(key, { id, payload: input.payload });
    return { id, duplicate: false };
  },
}));
vi.mock('@/lib/db/prisma', () => ({
  getWorkerPrisma: () => ({
    $transaction: async (op: (tx: unknown) => Promise<unknown>) => {
      if (h.failTx) throw new Error('db down');
      return op({
        $executeRaw: async (_s: TemplateStringsArray, type: string, tenant: string, payload: string, dedupe: string) => {
          h.jobs.push({ type, tenant, payload, dedupe });
          return 1;
        },
      });
    },
  }),
}));
vi.mock('@/lib/rate-limit', () => ({ checkRateLimit: () => ({ success: true }), rateLimitResponse: () => Response.json({}, { status: 429 }) }));

import { POST } from './route';

const event = (name: string, extra: Record<string, unknown> = {}) => JSON.stringify({
  event: name,
  payload: { payment_link: { entity: { id: 'plink_Abc123', reference_id: 'fl_abcdefghijklmnopqrstuvwxyz012345', status: name.split('.')[1], amount: 49900, amount_paid: 49900, currency: 'INR', customer: { contact: '+919800000000', email: 'a@example.invalid' }, ...extra } } },
});
const sign = (raw: string, secret = SECRET) => createHmac('sha256', secret).update(raw).digest('hex');
const call = (raw: string, headers: Record<string, string>, account = ACCOUNT) =>
  POST(new Request(`http://localhost/api/payments/razorpay/webhook/${account}`, { method: 'POST', body: raw, headers }), { params: Promise.resolve({ accountId: account }) });

beforeEach(() => {
  h.secrets = new Map([[ACCOUNT, SECRET]]);
  h.receipts.clear();
  h.jobs = [];
  h.failTx = false;
});

it('records a verified payment once and queues its job before acknowledging', async () => {
  const raw = event('payment_link.paid');
  const res = await call(raw, { 'x-razorpay-signature': sign(raw), 'x-razorpay-event-id': 'evt_1' });
  expect(res.status).toBe(200);
  expect(h.jobs).toEqual([{ type: 'payments.razorpay_event', tenant: ACCOUNT, payload: JSON.stringify({ receiptId: 'r1' }), dedupe: 'payment-event:r1' }]);
  const receipt = h.receipts.get(`razorpay:${ACCOUNT}:evt_1`)!;
  // Ids and statuses only: no customer contact details are stored.
  expect(receipt.payload).toEqual({ accountId: ACCOUNT, event: 'payment_link.paid', paymentLinkId: 'plink_Abc123', referenceId: 'fl_abcdefghijklmnopqrstuvwxyz012345', status: 'paid' });
  expect(JSON.stringify(receipt.payload)).not.toContain('9800000000');

  // Razorpay redelivers: acknowledged, nothing queued again.
  expect((await call(raw, { 'x-razorpay-signature': sign(raw), 'x-razorpay-event-id': 'evt_1' })).status).toBe(200);
  expect(h.jobs).toHaveLength(1);
});

it('refuses a missing or wrong signature, an unknown account and a workspace without a webhook secret alike', async () => {
  const raw = event('payment_link.paid');
  expect((await call(raw, {})).status).toBe(401);
  expect((await call(raw, { 'x-razorpay-signature': sign(raw, 'other') })).status).toBe(401);
  expect((await call(raw.replace('49900', '1'), { 'x-razorpay-signature': sign(raw) })).status).toBe(401);
  expect((await call(raw, { 'x-razorpay-signature': sign(raw) }, '99999999-9999-4999-8999-999999999999')).status).toBe(401);
  expect((await call(raw, { 'x-razorpay-signature': sign(raw) }, 'not-a-uuid')).status).toBe(401);
  h.secrets.set(ACCOUNT, null);
  expect((await call(raw, { 'x-razorpay-signature': sign(raw) })).status).toBe(401);
  expect(h.receipts.size).toBe(0);
  expect(h.jobs).toHaveLength(0);
});

it('acknowledges other verified events without recording them', async () => {
  for (const raw of [JSON.stringify({ event: 'payment.captured', payload: {} }), event('payment_link.created')]) {
    expect((await call(raw, { 'x-razorpay-signature': sign(raw) })).status).toBe(200);
  }
  expect(h.receipts.size).toBe(0);
});

it('keys a delivery without an event id by its body, per account', async () => {
  const raw = event('payment_link.expired');
  await call(raw, { 'x-razorpay-signature': sign(raw) });
  await call(raw, { 'x-razorpay-signature': sign(raw) });
  expect(h.jobs).toHaveLength(1);
  expect([...h.receipts.keys()][0]).toMatch(new RegExp(`^razorpay:${ACCOUNT}:sha256-[0-9a-f]{64}$`));
});

it('asks Razorpay to retry when the receipt cannot be stored, and rejects oversized or invalid bodies', async () => {
  const raw = event('payment_link.paid');
  h.failTx = true;
  expect((await call(raw, { 'x-razorpay-signature': sign(raw), 'x-razorpay-event-id': 'evt_2' })).status).toBe(500);
  h.failTx = false;
  const big = 'x'.repeat(300 * 1024);
  expect((await call(big, { 'x-razorpay-signature': sign(big) })).status).toBe(400);
  const broken = '{not json';
  expect((await call(broken, { 'x-razorpay-signature': sign(broken) })).status).toBe(400);
});
