import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ dispatch: vi.fn(async () => {}), admin: vi.fn(() => ({ admin: true })) }));
vi.mock('./deliver', () => ({ dispatchWebhookEvent: h.dispatch }));
vi.mock('@/lib/data/admin', () => ({ createAdminClient: h.admin }));

import { emitOrderCreated, emitOrderPaid, emitPaymentLinkPaid, orderWebhookData, paymentLinkWebhookData } from './commerce-events';
import { isWebhookEvent } from './events';

const ACCOUNT = '11111111-1111-4111-8111-111111111111';
const at = new Date('2026-11-02T10:00:00Z');

beforeEach(() => vi.clearAllMocks());

describe('commerce outbound webhook data', () => {
  it('builds a flat order payload with a formatted total', () => {
    expect(orderWebhookData({ orderId: 'o1', source: 'woocommerce', externalId: '1001', orderNumber: '1001', status: 'processing',
      totalMinor: 149950, currency: 'inr', itemCount: 3, contactId: 'c1', customerName: ' Asha ', customerPhone: '+919876543210', occurredAt: at }))
      .toEqual({
        order_id: 'o1', source: 'woocommerce', external_id: '1001', order_number: '1001', status: 'processing',
        total_minor: 149950, total: '₹1,499.50', currency: 'INR', item_count: 3, contact_id: 'c1', conversation_id: null,
        customer_name: 'Asha', customer_phone: '+919876543210', occurred_at: '2026-11-02T10:00:00.000Z',
      });
  });

  it('nulls unsafe numbers and unknown currencies instead of guessing', () => {
    const data = orderWebhookData({ source: 'shopify', totalMinor: 1.5, currency: 'ZZZ' });
    expect(data.total_minor).toBeNull();
    expect(data.total).toBeNull();
  });

  it('builds a payment_link.paid payload', () => {
    expect(paymentLinkWebhookData({ paymentLinkId: 'pl1', referenceId: 'ref', amountMinor: 50000, amountPaidMinor: 50000, currency: 'INR', paidAt: at }))
      .toMatchObject({ payment_link_id: 'pl1', provider: 'razorpay', amount_paid: '₹500.00', paid_at: '2026-11-02T10:00:00.000Z' });
  });
});

describe('emit helpers', () => {
  it('dispatch the registered events through a tenant-scoped client', async () => {
    expect(await emitOrderCreated(ACCOUNT, { source: 'woocommerce' })).toBe(true);
    await emitOrderPaid(ACCOUNT, { source: 'woocommerce' });
    await emitPaymentLinkPaid(ACCOUNT, { paymentLinkId: 'pl1', amountPaidMinor: 1, currency: 'INR' });
    expect(h.admin).toHaveBeenCalledWith({ accountId: ACCOUNT, role: 'owner' });
    const events = h.dispatch.mock.calls.map((c) => (c as unknown[])[2]);
    expect(events).toEqual(['order.created', 'order.paid', 'payment_link.paid']);
    for (const e of events) expect(isWebhookEvent(e)).toBe(true);
  });

  it('never throw, and log no payload', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    h.dispatch.mockRejectedValueOnce(new Error('queue down +919876543210'));
    expect(await emitOrderCreated(ACCOUNT, { source: 'woocommerce', customerPhone: '+919876543210' })).toBe(false);
    expect(JSON.stringify(log.mock.calls)).not.toContain('9876543210');
    log.mockRestore();
  });
});
