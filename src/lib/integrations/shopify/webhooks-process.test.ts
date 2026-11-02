import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  resolveShopifyStores: vi.fn(),
  claimWebhookReceipt: vi.fn(),
  markWebhookReceiptProcessed: vi.fn(async () => {}),
  recordCommerceEvent: vi.fn(),
  emitOrderCreated: vi.fn(async () => true),
  emitOrderPaid: vi.fn(async () => true),
  committed: false,
}));
const tx = vi.hoisted(() => ({ $queryRaw: vi.fn(async () => [{ marketing_opt_in_only: false }]) }));

vi.mock('./store', () => ({ resolveShopifyStores: h.resolveShopifyStores, stopShopifyStore: vi.fn() }));
vi.mock('@/lib/db/prisma', () => ({ getWorkerPrisma: () => 'worker' }));
vi.mock('@/lib/db/tenant', () => ({
  withTenant: async (_ctx: unknown, op: (t: unknown) => unknown) => {
    h.committed = false;
    const out = await op(tx);
    h.committed = true;
    return out;
  },
}));
vi.mock('@/lib/commerce/webhook-receipts', () => ({
  claimWebhookReceipt: h.claimWebhookReceipt,
  markWebhookReceiptProcessed: h.markWebhookReceiptProcessed,
}));
vi.mock('@/lib/commerce/event-rules', () => ({ recordCommerceEvent: h.recordCommerceEvent }));
vi.mock('@/lib/webhooks/commerce-events', () => ({ emitOrderCreated: h.emitOrderCreated, emitOrderPaid: h.emitOrderPaid }));

import { processShopifyWebhook } from './webhooks';

const ACCOUNT = '11111111-1111-4111-8111-111111111111';
const shop = 'demo.myshopify.com';
const order = {
  id: 450789469, name: '#1001', currency: 'INR', total_price: '1234.50', financial_status: 'paid', phone: '+919876543210',
  line_items: [{ quantity: 2 }], customer: { id: 7, first_name: 'Asha', last_name: 'Rao', email: 'asha@example.com' },
};
let hook = 0;
const deliver = (topic: string, body: Record<string, unknown> = order) => processShopifyWebhook({ topic, shop, webhookId: `w${++hook}`, body });

beforeEach(() => {
  vi.clearAllMocks();
  h.resolveShopifyStores.mockResolvedValue([{ account_id: ACCOUNT, store_id: 's1', active: true }]);
  h.claimWebhookReceipt.mockResolvedValue({ id: 'r1', duplicate: false });
  h.recordCommerceEvent.mockResolvedValue({ eventId: 'e1', duplicate: false, status: 'skipped', reason: 'no_rule', contactId: 'c1', scheduledFor: null });
  h.emitOrderCreated.mockImplementation(async () => {
    expect(h.committed).toBe(true);
    return true;
  });
});

describe('Shopify order events → outbound order webhooks', () => {
  it('emits order.created once for a newly recorded orders/create, after the transaction commits', async () => {
    expect(await deliver('orders/create')).toBe('recorded');
    expect(h.emitOrderCreated).toHaveBeenCalledTimes(1);
    expect(h.emitOrderPaid).not.toHaveBeenCalled();
    expect(h.emitOrderCreated).toHaveBeenCalledWith(ACCOUNT, expect.objectContaining({
      source: 'shopify', externalId: '450789469', orderNumber: '#1001', status: 'paid', totalMinor: 123450, currency: 'INR',
      itemCount: 2, contactId: 'c1', customerName: 'Asha Rao', customerPhone: '+919876543210',
    }));
    // No email or address in the outbound data.
    expect(JSON.stringify(h.emitOrderCreated.mock.calls)).not.toContain('asha@example.com');
  });

  it('emits order.paid for orders/paid', async () => {
    expect(await deliver('orders/paid')).toBe('recorded');
    expect(h.emitOrderPaid).toHaveBeenCalledTimes(1);
    expect(h.emitOrderCreated).not.toHaveBeenCalled();
  });

  it('emits nothing for a repeated order event (same dedupe key), a redelivery or other topics', async () => {
    h.recordCommerceEvent.mockResolvedValueOnce({ eventId: 'e1', duplicate: true, status: 'scheduled', reason: null, contactId: 'c1', scheduledFor: null });
    expect(await deliver('orders/paid')).toBe('recorded');
    h.claimWebhookReceipt.mockResolvedValueOnce({ id: 'r1', duplicate: true });
    expect(await deliver('orders/create')).toBe('duplicate');
    expect(await deliver('orders/fulfilled')).toBe('recorded');
    expect(await deliver('orders/create', { ...order, id: 'not-a-number' })).toBe('ignored');
    expect(h.emitOrderCreated).not.toHaveBeenCalled();
    expect(h.emitOrderPaid).not.toHaveBeenCalled();
  });

  it('still answers recorded when the webhook enqueue fails', async () => {
    h.emitOrderPaid.mockRejectedValueOnce(new Error('queue down'));
    expect(await deliver('orders/paid')).toBe('recorded');
  });
});
