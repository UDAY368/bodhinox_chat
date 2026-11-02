import { createHmac } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  resolveWooStore: vi.fn(),
  claimWebhookReceipt: vi.fn(),
  markWebhookReceiptProcessed: vi.fn(async () => {}),
  recordCommerceEvent: vi.fn(),
  emitOrderCreated: vi.fn(async () => true),
  emitOrderPaid: vi.fn(async () => true),
  tenants: [] as unknown[],
  predates: true,
  storeExists: vi.fn(async () => true),
}));
const tx = vi.hoisted(() => ({ tx: true, $queryRaw: vi.fn() }));

vi.mock('./stores', () => ({ resolveWooStore: h.resolveWooStore, wooStoreExists: h.storeExists }));
vi.mock('@/lib/db/prisma', () => ({ getWorkerPrisma: () => 'worker' }));
vi.mock('@/lib/db/tenant', () => ({
  withTenant: async (ctx: unknown, op: (tx: unknown) => unknown, db: unknown) => {
    h.tenants.push({ ctx, db });
    return op(tx);
  },
}));
vi.mock('@/lib/commerce/webhook-receipts', () => ({
  claimWebhookReceipt: h.claimWebhookReceipt,
  markWebhookReceiptProcessed: h.markWebhookReceiptProcessed,
}));
vi.mock('@/lib/commerce/event-rules', () => ({ recordCommerceEvent: h.recordCommerceEvent }));
vi.mock('@/lib/webhooks/commerce-events', () => ({ emitOrderCreated: h.emitOrderCreated, emitOrderPaid: h.emitOrderPaid }));

import { processWooWebhook } from './process';

const ACCOUNT = '11111111-1111-4111-8111-111111111111';
const STORE = '22222222-2222-4222-8222-222222222222';
const SECRET = 'test-only-secret';
const body = JSON.stringify({
  id: 1001, number: '1001', status: 'processing', currency: 'INR', total: '10.00', date_paid_gmt: '2026-11-02T10:00:00',
  billing: { first_name: 'Asha', phone: '+919876543210', country: 'IN' }, line_items: [{ quantity: 1 }],
});
const sign = (raw: string, secret = SECRET) => createHmac('sha256', secret).update(raw).digest('base64');
const headers = (over: Record<string, string | null> = {}) => {
  const base: Record<string, string | null> = {
    'x-wc-webhook-signature': sign(body), 'x-wc-webhook-topic': 'order.created', 'x-wc-webhook-delivery-id': 'abc123', ...over,
  };
  const out = new Headers();
  for (const [k, v] of Object.entries(base)) if (v !== null) out.set(k, v);
  return out;
};
const run = (raw = body, hdrs = headers()) => processWooWebhook({ storeId: STORE, rawBody: raw, headers: hdrs });

beforeEach(() => {
  vi.clearAllMocks();
  h.tenants = [];
  h.predates = true;
  tx.$queryRaw.mockImplementation(async () => [{ predates: h.predates }]);
  h.resolveWooStore.mockResolvedValue({ accountId: ACCOUNT, storeId: STORE, storeUrl: 'https://shop.example.com', consentMetaKey: null, secret: SECRET });
  h.claimWebhookReceipt.mockResolvedValue({ id: 'r1', duplicate: false });
  h.storeExists.mockResolvedValue(true);
  let n = 0;
  h.recordCommerceEvent.mockImplementation(async () => ({ eventId: `e${++n}`, duplicate: false, status: 'scheduled', reason: null, contactId: 'c1', scheduledFor: null }));
});

describe('processWooWebhook', () => {
  it('404s an unknown store before touching anything else', async () => {
    h.resolveWooStore.mockResolvedValue(null);
    expect((await run()).status).toBe(404);
    expect(h.claimWebhookReceipt).not.toHaveBeenCalled();
  });

  it('answers the unsigned creation ping without storing anything', async () => {
    const res = await run('webhook_id=7', headers({ 'x-wc-webhook-signature': null }));
    expect(res).toEqual({ status: 200, body: { status: 'ping' } });
    expect(h.claimWebhookReceipt).not.toHaveBeenCalled();
  });

  it('401s a missing or wrong signature, including a signed ping-looking body with a bad signature', async () => {
    expect((await run(body, headers({ 'x-wc-webhook-signature': null }))).status).toBe(401);
    expect((await run(body, headers({ 'x-wc-webhook-signature': sign(body, 'other') }))).status).toBe(401);
    expect((await run('webhook_id=7', headers({ 'x-wc-webhook-signature': sign(body) }))).status).toBe(401);
    expect(h.claimWebhookReceipt).not.toHaveBeenCalled();
    expect(h.recordCommerceEvent).not.toHaveBeenCalled();
  });

  it('refuses a missing or malformed signature before any database lookup', async () => {
    for (const sig of [null, '', 'junk', 'a'.repeat(44), `${sign(body)}x`, sign(body).replace('=', 'A')]) {
      const res = await run(body, headers({ 'x-wc-webhook-signature': sig }));
      expect(res).toEqual({ status: 401, body: { error: 'Invalid signature' } });
    }
    expect((await run('webhook_id=7', headers({ 'x-wc-webhook-signature': null }))).status).toBe(200);
    expect(h.resolveWooStore).not.toHaveBeenCalled();
    expect(h.tenants).toEqual([]);
  });

  it('rolls back and 404s a delivery whose store was disconnected while it ran', async () => {
    h.storeExists.mockResolvedValue(false);
    expect(await run()).toEqual({ status: 404, body: { error: 'Unknown store' } });
    expect(h.storeExists).toHaveBeenCalledWith(tx, ACCOUNT, STORE);
    expect(h.markWebhookReceiptProcessed).not.toHaveBeenCalled();
    expect(h.emitOrderCreated).not.toHaveBeenCalled();
    expect(h.emitOrderPaid).not.toHaveBeenCalled();
  });

  it('acknowledges and ignores other topics, and 400s an unreadable order', async () => {
    expect(await run(body, headers({ 'x-wc-webhook-topic': 'product.updated' }))).toEqual({ status: 200, body: { status: 'ignored' } });
    const bad = '{"id":"x"}';
    expect((await run(bad, headers({ 'x-wc-webhook-signature': sign(bad) }))).status).toBe(400);
    expect(h.claimWebhookReceipt).not.toHaveBeenCalled();
  });

  it('records each mapped event in one worker transaction with the receipt, then emits outbound webhooks', async () => {
    const res = await run();
    expect(res).toEqual({ status: 200, body: { status: 'received', events: 2 } });
    expect(h.tenants).toEqual([{ ctx: { accountId: ACCOUNT, role: 'owner' }, db: 'worker' }]);
    expect(h.claimWebhookReceipt).toHaveBeenCalledWith(tx, {
      provider: 'woocommerce', receiptId: `${STORE}:abc123`,
      payload: { store_id: STORE, topic: 'order.created', order_id: '1001', order_status: 'processing' },
    });
    expect(h.recordCommerceEvent.mock.calls.map((c) => c[1].event)).toEqual(['order_created', 'order_paid']);
    expect(h.recordCommerceEvent.mock.calls[0][1]).toMatchObject({ dedupeKey: `woocommerce:${STORE}:1001:order_created`, phone: '+919876543210' });
    expect(h.markWebhookReceiptProcessed).toHaveBeenCalledWith(tx, 'r1');
    expect(h.emitOrderCreated).toHaveBeenCalledWith(ACCOUNT, expect.objectContaining({ source: 'woocommerce', externalId: '1001', totalMinor: 1000, currency: 'INR' }));
    expect(h.emitOrderPaid).toHaveBeenCalledTimes(1);
  });

  it('treats a contact first created by this order as having no marketing consent', async () => {
    h.predates = false;
    await run();
    expect(h.recordCommerceEvent.mock.calls.map((c) => c[1].marketingConsent)).toEqual([false, false]);
    h.recordCommerceEvent.mockClear();
    h.predates = true;
    await run();
    expect(h.recordCommerceEvent.mock.calls.map((c) => c[1].marketingConsent)).toEqual([null, null]);
  });

  it('keeps an explicit store consent without looking up the contact', async () => {
    h.resolveWooStore.mockResolvedValue({ accountId: ACCOUNT, storeId: STORE, storeUrl: 'https://s.example', consentMetaKey: '_wa', secret: SECRET });
    const raw = JSON.stringify({ ...JSON.parse(body), meta_data: [{ key: '_wa', value: 'yes' }] });
    await run(raw, headers({ 'x-wc-webhook-signature': sign(raw) }));
    expect(tx.$queryRaw).not.toHaveBeenCalled();
    expect(h.recordCommerceEvent.mock.calls.map((c) => c[1].marketingConsent)).toEqual([true, true]);
  });

  it('does nothing for a redelivered delivery id', async () => {
    h.claimWebhookReceipt.mockResolvedValue({ id: 'r1', duplicate: true });
    expect(await run()).toEqual({ status: 200, body: { status: 'duplicate' } });
    expect(h.recordCommerceEvent).not.toHaveBeenCalled();
    expect(h.emitOrderCreated).not.toHaveBeenCalled();
  });

  it('does not re-emit outbound webhooks for events another delivery already recorded', async () => {
    h.recordCommerceEvent.mockResolvedValue({ eventId: 'e1', duplicate: true, status: 'sent', reason: null, contactId: 'c1', scheduledFor: null });
    expect((await run()).status).toBe(200);
    expect(h.emitOrderCreated).not.toHaveBeenCalled();
    expect(h.emitOrderPaid).not.toHaveBeenCalled();
  });

  it('falls back to a body hash when the delivery id header is missing or odd', async () => {
    await run(body, headers({ 'x-wc-webhook-delivery-id': '../../etc' }));
    expect(h.claimWebhookReceipt.mock.calls[0][1].receiptId).toMatch(new RegExp(`^${STORE}:sha256-[0-9a-f]{64}$`));
  });

  it('lets a failed transaction surface so the delivery is not acknowledged', async () => {
    h.recordCommerceEvent.mockRejectedValue(new Error('db down'));
    await expect(run()).rejects.toThrow('db down');
    expect(h.markWebhookReceiptProcessed).not.toHaveBeenCalled();
    expect(h.emitOrderCreated).not.toHaveBeenCalled();
  });
});
